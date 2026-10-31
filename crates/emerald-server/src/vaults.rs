//! One served vault: an `emerald_core::VaultSession`, a file watcher, and the
//! numbered stream of `VaultUpdate`s that the WebSocket clients receive.
//!
//! Every update gets the next `version`. The last [`HISTORY_LEN`] updates are
//! kept, so a client that reconnects with the last version it saw gets what it
//! missed. The `epoch` changes every time the vault is opened (server start,
//! or a reload that changed it), which tells clients that their version
//! numbers no longer apply and they must reload the snapshot.
//!
//! Everything that leaves this module goes through the path policy in
//! [`crate::paths`]: nothing behind a symbolic link that leads out of the
//! vault folder is read, written or listed.
//!
//! With version history on, every change (from a client or seen by the
//! watcher) is also kept in the vault's [`History`].

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard, Weak};

use axum::extract::ws::Utf8Bytes;
use emerald_core::path::{is_hidden, normalize_path};
use emerald_core::vault::Result as VaultResult;
use emerald_core::{ConfigListing, EntryKind, FileEntry, SearchError, SearchOptions, SearchResults, Vault, VaultError, VaultSession, VaultSnapshot, VaultUpdate};
use emerald_sync::{HashCache, Manifest};
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tokio::sync::broadcast;

use crate::config::VaultConfig;
use crate::history::{self, DeletedFile, History, HistorySettings, VersionInfo};
use crate::paths::{self, Escapes};

const HISTORY_LEN: usize = 1024;
const CHANNEL_CAPACITY: usize = 256;

/// A pushed update, serialized once for every client.
pub struct Event {
    pub version: u64,
    /// The client that made the change (`X-EmeraldMD-Client`), which already
    /// has it from the HTTP response. `None` for changes seen by the watcher.
    pub origin: Option<String>,
    pub message: Utf8Bytes,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamMessage<'a> {
    Update { version: u64, update: &'a VaultUpdate },
    /// The client's version is unknown or too old: reload the snapshot.
    Resync,
}

/// What a subscriber gets: the updates it missed, then the live channel.
pub struct Subscription {
    pub backlog: Result<Vec<Arc<Event>>, NeedsResync>,
    pub live: broadcast::Receiver<Arc<Event>>,
}

#[derive(Debug)]
pub struct NeedsResync;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionedSnapshot {
    #[serde(flatten)]
    pub snapshot: VaultSnapshot,
    pub epoch: String,
    pub version: u64,
}

struct Inner {
    session: VaultSession,
    version: u64,
    history: VecDeque<Arc<Event>>,
}

pub struct SharedVault {
    pub id: String,
    pub name: String,
    pub epoch: String,
    /// What it was opened from; a reload reopens it if this changes.
    pub(crate) config: VaultConfig,
    inner: RwLock<Inner>,
    events: broadcast::Sender<Arc<Event>>,
    watcher: std::sync::Mutex<Option<notify::RecommendedWatcher>>,
    /// Content hashes for sync manifests, reused while files are unchanged.
    hashes: std::sync::Mutex<HashCache>,
    /// Earlier versions of files and deleted files; `None` when history is off.
    history: Option<History>,
    /// What `history` was opened with; a reload reopens the vault if this changes.
    pub(crate) history_settings: Option<HistorySettings>,
}

/// Version history is off on this server.
#[derive(Debug)]
pub struct NoHistory;


impl SharedVault {
    /// Opens and indexes the vault, and starts watching it for outside changes.
    pub fn open(config: &VaultConfig, history: Option<&HistorySettings>) -> Result<Arc<Self>, String> {
        let session = VaultSession::open(&config.path).map_err(|e| format!("vault {:?} ({}): {e}", config.id, config.path.display()))?;
        // A history folder that cannot be written must not keep the vault from being served.
        let history_store = history.and_then(|settings| match History::open(settings, &config.id) {
            Ok(history) => Some(history),
            Err(err) => {
                tracing::warn!(vault = %config.id, dir = %settings.dir.display(), "version history is off for this vault: {err}");
                None
            }
        });
        let name = config.name.clone().unwrap_or_else(|| session.vault().name());
        let root = session.vault().root().to_path_buf();
        let vault = Arc::new(Self {
            id: config.id.clone(),
            name,
            epoch: crate::auth::random_hex(8),
            config: config.clone(),
            inner: RwLock::new(Inner { session, version: 0, history: VecDeque::new() }),
            events: broadcast::channel(CHANNEL_CAPACITY).0,
            watcher: std::sync::Mutex::new(None),
            hashes: std::sync::Mutex::new(HashCache::default()),
            history: history_store,
            history_settings: history.cloned(),
        });
        let watcher = watch(Arc::downgrade(&vault), &root).map_err(|e| format!("cannot watch {}: {e}", root.display()))?;
        *vault.watcher.lock().map_err(|_| "watcher lock poisoned")? = Some(watcher);
        Ok(vault)
    }

    /// Stops watching the folder; called when a reload stops serving the vault.
    pub fn close(&self) {
        self.watcher.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    fn read_inner(&self) -> RwLockReadGuard<'_, Inner> {
        // A panic while holding the lock leaves the index as it was; keep serving.
        self.inner.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write_inner(&self) -> RwLockWriteGuard<'_, Inner> {
        self.inner.write().unwrap_or_else(|e| e.into_inner())
    }

    pub fn snapshot(&self) -> VersionedSnapshot {
        let inner = self.read_inner();
        let mut snapshot = inner.session.snapshot();
        snapshot.name = self.name.clone();
        // Where the vault lives on the server is none of the client's business.
        snapshot.base_path = String::new();
        let escapes = Escapes::find(inner.session.vault(), snapshot.files.iter().map(|e| e.path.as_str()));
        if !escapes.is_empty() {
            snapshot.files.retain(|e| !escapes.hides(&e.path));
            snapshot.metadata.retain(|path, _| !escapes.hides(path));
            snapshot.links.retain(|path, _| !escapes.hides(path));
            snapshot.links.values_mut().for_each(|sets| escapes.filter_links(sets));
        }
        VersionedSnapshot { snapshot, epoch: self.epoch.clone(), version: inner.version }
    }

    /// A file's text. Hidden files only from the config folder.
    pub fn read(&self, path: &str) -> VaultResult<String> {
        let inner = self.read_inner();
        paths::check_readable(inner.session.vault(), path)?;
        inner.session.read(path)
    }

    /// Any file's bytes. Hidden files only from the config folder.
    pub fn read_bytes(&self, path: &str) -> VaultResult<Vec<u8>> {
        let inner = self.read_inner();
        paths::check_readable(inner.session.vault(), path)?;
        inner.session.vault().read_bytes(path)
    }

    /// Full-text search; takes the write lock because the session caches note contents.
    pub fn search(&self, query: &str, options: &SearchOptions) -> Result<SearchResults, SearchError> {
        let mut inner = self.write_inner();
        // The limit is applied after leaving out files behind links, so `totalFiles` stays right.
        let unlimited = SearchOptions { limit: None, ..options.clone() };
        let mut results = inner.session.search(query, &unlimited)?;
        let escapes = Escapes::find(inner.session.vault(), results.files.iter().map(|f| f.path.as_str()));
        results.files.retain(|f| !escapes.hides(&f.path));
        results.total_files = results.files.len();
        results.files.truncate(options.limit.unwrap_or(usize::MAX));
        Ok(results)
    }

    /// A folder of the config folder: its files and subfolders.
    pub fn list_config(&self, path: &str) -> VaultResult<ConfigListing> {
        let inner = self.read_inner();
        paths::check_config(inner.session.vault(), path)?;
        inner.session.vault().list_config(path)
    }

    /// A config file's or folder's entry, or `None` when it does not exist.
    pub fn config_entry(&self, path: &str) -> VaultResult<Option<FileEntry>> {
        let inner = self.read_inner();
        paths::check_config(inner.session.vault(), path)?;
        inner.session.vault().config_entry(path)
    }

    /// Writes a config file (settings, a theme, a plugin's data). Not indexed
    /// and not announced on the event stream. Takes the write lock so writes
    /// to the vault folder stay one at a time.
    pub fn write_config(&self, path: &str, data: &[u8]) -> VaultResult<()> {
        let inner = self.write_inner();
        paths::check_config(inner.session.vault(), path)?;
        inner.session.vault().write_config_bytes(path, data)
    }

    pub fn create_config_folder(&self, path: &str) -> VaultResult<()> {
        let inner = self.write_inner();
        paths::check_config(inner.session.vault(), path)?;
        inner.session.vault().create_config_folder(path)
    }

    /// Moves a config file or folder (not the config folder) to the vault's `.trash`.
    pub fn trash_config(&self, path: &str) -> VaultResult<String> {
        let inner = self.write_inner();
        paths::check_config(inner.session.vault(), path)?;
        inner.session.vault().trash_config(path)
    }

    /// Every visible file with its content hash, for sync clients; with `config`, the config folder's files too.
    pub fn manifest(&self, config: bool) -> VaultResult<Manifest> {
        let inner = self.read_inner();
        let mut hashes = self.hashes.lock().unwrap_or_else(|e| e.into_inner());
        let mut manifest = hashes.scan_with(inner.session.vault(), config)?;
        let escapes = Escapes::find(inner.session.vault(), manifest.keys().map(String::as_str));
        manifest.retain(|path, _| !escapes.hides(path));
        Ok(manifest)
    }

    /// Runs a mutation and publishes its update to every other client. `f`
    /// runs under the vault's lock and should check its paths with
    /// [`crate::paths`] before touching anything. `changes` are the paths it
    /// will change or delete: those (and the files under them) that have no
    /// version yet get one of their current content first.
    pub fn mutate(
        &self,
        origin: Option<String>,
        changes: &[&str],
        f: impl FnOnce(&mut VaultSession) -> VaultResult<VaultUpdate>,
    ) -> VaultResult<VaultUpdate> {
        let mut inner = self.write_inner();
        self.seed_history(&inner, changes);
        let mut update = f(&mut inner.session)?;
        hide_escapes(inner.session.vault(), &mut update);
        self.remember(&inner, &update);
        self.publish(&mut inner, origin, &update);
        Ok(update)
    }

    /// Keeps the current content of the files at (or under) `paths` that have no version yet.
    fn seed_history(&self, inner: &Inner, paths: &[&str]) {
        let Some(history) = &self.history else { return };
        let vault = inner.session.vault();
        for path in paths {
            let path = normalize_path(path);
            let prefix = format!("{path}/");
            let files: Vec<&FileEntry> = inner
                .session
                .index()
                .entries()
                .filter(|e| e.kind == EntryKind::File && (e.path == path || e.path.starts_with(&prefix)))
                .collect();
            let escapes = Escapes::find(vault, files.iter().map(|e| e.path.as_str()));
            for entry in files {
                if escapes.hides(&entry.path) || history.has_versions(&entry.path) {
                    continue;
                }
                match vault.read_bytes(&entry.path) {
                    Ok(data) => {
                        if let Err(err) = history.seed(&entry.path, &data, entry.mtime) {
                            tracing::warn!(vault = %self.id, path = %entry.path, "could not keep a version: {err}");
                        }
                    }
                    Err(err) => tracing::debug!(vault = %self.id, path = %entry.path, "could not read for history: {err}"),
                }
            }
        }
    }

    /// Records an update in the history: renames move versions, removals are
    /// noted, and written files get a version of their new content.
    fn remember(&self, inner: &Inner, update: &VaultUpdate) {
        let Some(history) = &self.history else { return };
        let now = history::now_ms();
        let vault = inner.session.vault();
        let warn = |path: &str, err: std::io::Error| tracing::warn!(vault = %self.id, %path, "could not update the history: {err}");
        for (from, to) in &update.renamed {
            if let Err(err) = history.rename(from, to) {
                warn(from, err);
            }
        }
        for path in &update.removed {
            if let Err(err) = history.mark_deleted(path, now) {
                warn(path, err);
            }
        }
        for entry in update.upserted.iter().filter(|e| e.kind == EntryKind::File) {
            match vault.read_bytes(&entry.path) {
                Ok(data) => {
                    if let Err(err) = history.record(&entry.path, &data, now) {
                        warn(&entry.path, err);
                    }
                }
                // Gone again already: the next update says so.
                Err(err) => tracing::debug!(vault = %self.id, path = %entry.path, "could not read for history: {err}"),
            }
        }
    }

    fn history(&self) -> Result<&History, NoHistory> {
        self.history.as_ref().ok_or(NoHistory)
    }

    /// A vault path to look up in the history: normalized, never hidden.
    fn history_path(&self, path: &str) -> VaultResult<String> {
        let inner = self.read_inner();
        inner.session.vault().full_path(path)?;
        let normalized = normalize_path(path);
        if normalized.is_empty() || is_hidden(&normalized) {
            return Err(VaultError::NotFound(normalized));
        }
        Ok(normalized)
    }

    /// A file's versions, newest first.
    pub fn versions(&self, path: &str) -> Result<VaultResult<Vec<VersionInfo>>, NoHistory> {
        let history = self.history()?;
        Ok(self.history_path(path).map(|path| history.versions(&path)))
    }

    /// The content of one version of a file.
    pub fn read_version(&self, path: &str, time: u64) -> Result<VaultResult<Vec<u8>>, NoHistory> {
        let history = self.history()?;
        Ok(self.history_path(path).and_then(|path| history.read(&path, time).map_err(VaultError::from)))
    }

    /// Deleted files that still have versions, most recently deleted first.
    pub fn deleted_files(&self) -> Result<Vec<DeletedFile>, NoHistory> {
        let history = self.history()?;
        let inner = self.read_inner();
        let index = inner.session.index();
        Ok(history.deleted(|path| index.entry(path).is_some()))
    }

    /// Applies a change reported by the file watcher.
    fn sync_path(&self, full: &Path) {
        let mut inner = self.write_inner();
        let Some(path) = inner.session.vault().vault_path(full) else { return };
        match inner.session.sync_path(&path) {
            Ok(mut update) => {
                hide_escapes(inner.session.vault(), &mut update);
                self.remember(&inner, &update);
                self.publish(&mut inner, None, &update);
            }
            Err(err) => tracing::warn!(vault = %self.id, %path, "could not sync: {err}"),
        }
    }

    fn publish(&self, inner: &mut Inner, origin: Option<String>, update: &VaultUpdate) {
        if update.is_empty() {
            return;
        }
        inner.version += 1;
        let version = inner.version;
        let message = serde_json::to_string(&StreamMessage::Update { version, update }).expect("updates serialize");
        let event = Arc::new(Event { version, origin, message: message.into() });
        if inner.history.len() == HISTORY_LEN {
            inner.history.pop_front();
        }
        inner.history.push_back(event.clone());
        // An error only means nobody is listening.
        let _ = self.events.send(event);
    }

    /// Subscribes to updates after `since` (`epoch`, `version`), as returned by
    /// the snapshot. Without `since`, only future updates are delivered.
    pub fn subscribe(&self, since: Option<(&str, u64)>) -> Subscription {
        // Under the lock, so that no update falls between backlog and live.
        let inner = self.read_inner();
        let live = self.events.subscribe();
        let backlog = match since {
            None => Ok(Vec::new()),
            Some((epoch, version)) if epoch != self.epoch || version > inner.version => Err(NeedsResync),
            Some((_, version)) => {
                let oldest = inner.history.front().map_or(inner.version + 1, |e| e.version);
                if version + 1 < oldest {
                    Err(NeedsResync)
                } else {
                    Ok(inner.history.iter().filter(|e| e.version > version).cloned().collect())
                }
            }
        };
        Subscription { backlog, live }
    }
}

fn hide_escapes(vault: &Vault, update: &mut VaultUpdate) {
    Escapes::find(vault, paths::update_paths(update)).filter_update(update);
}

/// Watches the vault folder; changes made outside the server (another
/// program, a sync tool, a shell) become updates like any other.
fn watch(vault: Weak<SharedVault>, root: &Path) -> notify::Result<notify::RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let (Ok(event), Some(vault)) = (event, vault.upgrade()) else { return };
        for path in &event.paths {
            vault.sync_path(path);
        }
    })?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok(watcher)
}
