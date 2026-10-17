//! One served vault: an `emerald_core::VaultSession`, a file watcher, and the
//! numbered stream of `VaultUpdate`s that the WebSocket clients receive.
//!
//! Every update gets the next `version`. The last [`HISTORY_LEN`] updates are
//! kept, so a client that reconnects with the last version it saw gets what it
//! missed. The `epoch` changes on every server start, which tells clients that
//! their version numbers no longer apply and they must reload the snapshot.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard, Weak};

use axum::extract::ws::Utf8Bytes;
use emerald_core::vault::Result as VaultResult;
use emerald_core::{SearchError, SearchOptions, SearchResults, VaultSession, VaultSnapshot, VaultUpdate};
use emerald_sync::{HashCache, Manifest};
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tokio::sync::broadcast;

use crate::config::VaultConfig;

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
    inner: RwLock<Inner>,
    events: broadcast::Sender<Arc<Event>>,
    watcher: std::sync::Mutex<Option<notify::RecommendedWatcher>>,
    /// Content hashes for sync manifests, reused while files are unchanged.
    hashes: std::sync::Mutex<HashCache>,
}


impl SharedVault {
    /// Opens and indexes the vault, and starts watching it for outside changes.
    pub fn open(config: &VaultConfig, epoch: &str) -> Result<Arc<Self>, String> {
        let session = VaultSession::open(&config.path).map_err(|e| format!("vault {:?} ({}): {e}", config.id, config.path.display()))?;
        let name = config.name.clone().unwrap_or_else(|| session.vault().name());
        let root = session.vault().root().to_path_buf();
        let vault = Arc::new(Self {
            id: config.id.clone(),
            name,
            epoch: epoch.to_owned(),
            inner: RwLock::new(Inner { session, version: 0, history: VecDeque::new() }),
            events: broadcast::channel(CHANNEL_CAPACITY).0,
            watcher: std::sync::Mutex::new(None),
            hashes: std::sync::Mutex::new(HashCache::default()),
        });
        let watcher = watch(Arc::downgrade(&vault), &root).map_err(|e| format!("cannot watch {}: {e}", root.display()))?;
        *vault.watcher.lock().map_err(|_| "watcher lock poisoned")? = Some(watcher);
        Ok(vault)
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
        VersionedSnapshot { snapshot, epoch: self.epoch.clone(), version: inner.version }
    }

    pub fn read(&self, path: &str) -> VaultResult<String> {
        self.read_inner().session.read(path)
    }

    pub fn read_bytes(&self, path: &str) -> VaultResult<Vec<u8>> {
        self.read_inner().session.vault().read_bytes(path)
    }

    /// Full-text search; takes the write lock because the session caches note contents.
    pub fn search(&self, query: &str, options: &SearchOptions) -> Result<SearchResults, SearchError> {
        self.write_inner().session.search(query, options)
    }

    /// Every visible file with its content hash, for sync clients.
    pub fn manifest(&self) -> VaultResult<Manifest> {
        let inner = self.read_inner();
        let mut hashes = self.hashes.lock().unwrap_or_else(|e| e.into_inner());
        hashes.scan(inner.session.vault())
    }

    /// Runs a mutation and publishes its update to every other client.
    pub fn mutate(
        &self,
        origin: Option<String>,
        f: impl FnOnce(&mut VaultSession) -> VaultResult<VaultUpdate>,
    ) -> VaultResult<VaultUpdate> {
        let mut inner = self.write_inner();
        let update = f(&mut inner.session)?;
        self.publish(&mut inner, origin, &update);
        Ok(update)
    }

    /// Applies a change reported by the file watcher.
    fn sync_path(&self, full: &Path) {
        let mut inner = self.write_inner();
        let Some(path) = inner.session.vault().vault_path(full) else { return };
        match inner.session.sync_path(&path) {
            Ok(update) => self.publish(&mut inner, None, &update),
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
