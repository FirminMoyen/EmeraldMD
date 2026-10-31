//! Synced vaults: a local folder kept in step with a vault on an
//! emeraldmd-server (docs/sync.md). The folder is an ordinary local vault;
//! while it is open, a background thread runs `emerald_sync::sync_once` when
//! the vault opens, shortly after local changes, as soon as the server's
//! event stream reports a change from another device, and every minute in
//! case the stream is down. Progress reaches the webview as `sync-status`
//! events, and changes made by a pass as `vault-changed`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use emerald_sync::{Action, HttpRemote, SyncFilter, SyncOptions, is_config, sync_once_with};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::remote::KEYCHAIN_SERVICE;
use crate::{AppState, CmdResult};

/// How often to look for changes from other devices.
const POLL: Duration = Duration::from_secs(60);
/// Edits that follow each other within this window are synced together.
const DEBOUNCE: Duration = Duration::from_millis(1500);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncedVault {
    /// The local folder (canonical path).
    pub local_path: String,
    pub server_url: String,
    pub vault_id: String,
    pub name: String,
    /// Also sync `.obsidian` (settings, themes, snippets, plugins); off unless the user turns it on.
    #[serde(default)]
    pub sync_config: bool,
    /// Folders and file types this device leaves out (selective sync).
    #[serde(default)]
    pub filter: SyncFilter,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum SyncStatus {
    Syncing,
    /// Up to date as of `last_sync` (ms since the epoch).
    Synced { last_sync: u64, conflict_copies: Vec<String>, failed: usize },
    /// The server could not be reached; local edits are kept and sync later.
    Offline { message: String },
    /// The server refused the token.
    Unauthorized,
    Error { message: String },
}

fn list_path(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("synced-vaults.json"))
}

pub fn load(app: &AppHandle) -> Vec<SyncedVault> {
    list_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, vaults: &[SyncedVault]) -> CmdResult<()> {
    let path = list_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, serde_json::to_string_pretty(vaults).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// The synced-vault entry for a vault folder, if it is one.
pub fn config_for(app: &AppHandle, root: &Path) -> Option<SyncedVault> {
    let root = root.display().to_string();
    load(app).into_iter().find(|v| v.local_path == root)
}

/// This computer's name for conflict copies: the host name without `.local`.
fn device_name() -> String {
    let host = gethostname::gethostname().to_string_lossy().into_owned();
    let host = host.strip_suffix(".local").unwrap_or(&host);
    host.replace('.', "-")
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// The background sync of the open synced vault. Dropping it stops the thread.
pub struct Syncer {
    trigger: Sender<()>,
    /// Stops the event-stream thread when the vault closes.
    stop: Arc<AtomicBool>,
    /// Whether passes include `.obsidian` (the vault's `sync_config`, changed while open by `set_sync_config`).
    sync_config: Arc<AtomicBool>,
    /// What passes leave out (the vault's `filter`, changed while open by `set_sync_filter`).
    filter: Arc<Mutex<SyncFilter>>,
}

impl Drop for Syncer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Syncer {
    pub fn start(app: AppHandle, config: SyncedVault, root: PathBuf) -> Self {
        let (trigger, requests) = mpsc::channel::<()>();
        let device = device_name();
        let stop = Arc::new(AtomicBool::new(false));
        let sync_config = Arc::new(AtomicBool::new(config.sync_config));
        let filter = Arc::new(Mutex::new(config.filter.clone()));
        Self::watch_server(&config, &device, trigger.clone(), stop.clone());
        let pass_config = sync_config.clone();
        let pass_filter = filter.clone();
        thread::spawn(move || {
            loop {
                // A nudge (opening, edits, "Sync now") or the poll interval starts a pass.
                let nudged = match requests.recv_timeout(POLL) {
                    Ok(()) => true,
                    Err(RecvTimeoutError::Timeout) => false,
                    Err(RecvTimeoutError::Disconnected) => break,
                };
                // Let a burst of edits settle before syncing them.
                if nudged {
                    loop {
                        match requests.recv_timeout(DEBOUNCE) {
                            Ok(()) => continue,
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                }
                let options = SyncOptions {
                    config: pass_config.load(Ordering::SeqCst),
                    filter: pass_filter.lock().map(|f| f.clone()).unwrap_or_default(),
                };
                let status = run_pass(&app, &config, &root, &device, options);
                let _ = app.emit("sync-status", &status);
            }
        });
        Self { trigger, stop, sync_config, filter }
    }

    /// Syncs as soon as the server vault changes, through its event stream.
    /// Without a connection, edits and the poll interval still start passes.
    fn watch_server(config: &SyncedVault, device: &str, trigger: Sender<()>, stop: Arc<AtomicBool>) {
        let config = config.clone();
        let client_id = format!("sync-{device}");
        thread::spawn(move || {
            let connect = || {
                let token = token(&config).map_err(|e| emerald_sync::SyncError::Remote(format!("keychain: {e}")))?;
                HttpRemote::new(&config.server_url, &config.vault_id, &token, &client_id)
            };
            emerald_sync::watch_changes(
                connect,
                &stop,
                || {
                    let _ = trigger.send(());
                },
                |err| eprintln!("sync event stream for {}: {err}", config.server_url),
            );
        });
    }

    /// Asks for a sync pass soon (after local edits, or "Sync now").
    pub fn nudge(&self) {
        let _ = self.trigger.send(());
    }

    /// After a change in `.obsidian`: a pass, if settings are synced.
    pub fn nudge_config(&self) {
        if self.sync_config.load(Ordering::SeqCst) {
            self.nudge();
        }
    }
}

/// The server token from the Keychain.
fn token(config: &SyncedVault) -> Result<String, keyring::Error> {
    // Debug builds can take a test server's token from the environment (see remote::dev_token).
    if let Some(token) = crate::remote::dev_token() {
        return Ok(token);
    }
    keyring::Entry::new(KEYCHAIN_SERVICE, &config.server_url)?.get_password()
}

fn run_pass(app: &AppHandle, config: &SyncedVault, root: &Path, device: &str, options: SyncOptions) -> SyncStatus {
    let _ = app.emit("sync-status", &SyncStatus::Syncing);
    let token = match token(config) {
        Ok(token) => token,
        Err(keyring::Error::NoEntry) => return SyncStatus::Unauthorized,
        Err(err) => return SyncStatus::Error { message: format!("keychain: {err}") },
    };
    let mut remote = match HttpRemote::new(&config.server_url, &config.vault_id, &token, &format!("sync-{device}")) {
        Ok(remote) => remote.with_config(options.config),
        Err(err) => return SyncStatus::Error { message: err.to_string() },
    };
    let state = app.state::<AppState>();
    let Ok(mut guard) = state.vault.lock() else { return SyncStatus::Error { message: "vault state is poisoned".into() } };
    let Some(open) = guard.as_mut() else { return SyncStatus::Error { message: "no vault is open".into() } };
    if open.session.vault().root() != root {
        return SyncStatus::Error { message: "another vault is open".into() };
    }
    match sync_once_with(&mut open.session, &mut remote, device, options) {
        Ok(report) => {
            if !report.update.is_empty() {
                let _ = app.emit("vault-changed", &report.update);
            }
            // Settings that came from another device: the page offers to reload.
            let received: Vec<&str> = report
                .done
                .iter()
                .filter_map(|action| match action {
                    Action::Download(p) | Action::DeleteLocal(p) | Action::Merge(p) | Action::ConflictCopy(p) if is_config(p) => Some(p.as_str()),
                    _ => None,
                })
                .collect();
            if !received.is_empty() {
                let _ = app.emit("config-synced", &received);
            }
            SyncStatus::Synced { last_sync: now_ms(), conflict_copies: report.conflict_copies, failed: report.failed.len() }
        }
        Err(emerald_sync::SyncError::Remote(message)) if message.starts_with("401") => SyncStatus::Unauthorized,
        Err(emerald_sync::SyncError::Remote(message)) => SyncStatus::Offline { message },
        Err(err) => SyncStatus::Error { message: err.to_string() },
    }
}

#[tauri::command]
pub async fn synced_vaults(app: AppHandle) -> Vec<SyncedVault> {
    load(&app)
}

/// Registers a local folder as the synced copy of a server vault (creating
/// the folder) and stores the token in the keychain. Returns the folder's
/// path, which the app then opens like any vault; the first pass fills it.
#[tauri::command]
pub async fn create_synced_vault(
    app: AppHandle,
    server_url: String,
    vault_id: String,
    name: String,
    token: String,
    local_path: String,
) -> CmdResult<String> {
    fs::create_dir_all(&local_path).map_err(|e| format!("cannot create {local_path}: {e}"))?;
    let canonical = dunce::canonicalize(&local_path).map_err(|e| e.to_string())?.display().to_string();
    let server = server_url.clone();
    tauri::async_runtime::spawn_blocking(move || keyring::Entry::new(KEYCHAIN_SERVICE, &server)?.set_password(&token))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("keychain: {e}"))?;
    let mut vaults = load(&app);
    vaults.retain(|v| v.local_path != canonical);
    vaults.push(SyncedVault { local_path: canonical.clone(), server_url, vault_id, name, sync_config: false, filter: SyncFilter::default() });
    save(&app, &vaults)?;
    Ok(canonical)
}

/// Stops syncing a folder; its files stay as an ordinary local vault.
#[tauri::command]
pub async fn forget_synced_vault(app: AppHandle, state: State<'_, AppState>, local_path: String) -> CmdResult<()> {
    let mut vaults = load(&app);
    vaults.retain(|v| v.local_path != local_path);
    save(&app, &vaults)?;
    if let Ok(mut guard) = state.vault.lock()
        && let Some(open) = guard.as_mut()
        && open.session.vault().root().display().to_string() == local_path
    {
        open.syncer = None;
    }
    Ok(())
}

/// The synced-vault entry of the open vault, if it is synced.
#[tauri::command]
pub async fn open_vault_sync(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Option<SyncedVault>> {
    let guard = state.vault.lock().map_err(|_| "vault state is poisoned".to_owned())?;
    Ok(guard.as_ref().and_then(|open| config_for(&app, open.session.vault().root())))
}

/// Turns syncing `.obsidian` on or off for the open synced vault, then syncs.
#[tauri::command]
pub async fn set_sync_config(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> CmdResult<()> {
    let guard = state.vault.lock().map_err(|_| "vault state is poisoned".to_owned())?;
    let open = guard.as_ref().ok_or("no vault is open")?;
    let root = open.session.vault().root().display().to_string();
    let mut vaults = load(&app);
    let entry = vaults.iter_mut().find(|v| v.local_path == root).ok_or("this vault is not synced")?;
    entry.sync_config = enabled;
    save(&app, &vaults)?;
    if let Some(syncer) = open.syncer.as_ref() {
        syncer.sync_config.store(enabled, Ordering::SeqCst);
        syncer.nudge();
    }
    Ok(())
}

/// Sets the folders and file types the open synced vault leaves out, then syncs.
#[tauri::command]
pub async fn set_sync_filter(app: AppHandle, state: State<'_, AppState>, filter: SyncFilter) -> CmdResult<()> {
    let guard = state.vault.lock().map_err(|_| "vault state is poisoned".to_owned())?;
    let open = guard.as_ref().ok_or("no vault is open")?;
    let root = open.session.vault().root().display().to_string();
    let mut vaults = load(&app);
    let entry = vaults.iter_mut().find(|v| v.local_path == root).ok_or("this vault is not synced")?;
    entry.filter = filter.clone();
    save(&app, &vaults)?;
    if let Some(syncer) = open.syncer.as_ref() {
        *syncer.filter.lock().map_err(|_| "sync filter is poisoned".to_owned())? = filter;
        syncer.nudge();
    }
    Ok(())
}

#[tauri::command]
pub async fn sync_now(state: State<'_, AppState>) -> CmdResult<()> {
    let guard = state.vault.lock().map_err(|_| "vault state is poisoned".to_owned())?;
    let syncer = guard.as_ref().and_then(|open| open.syncer.as_ref()).ok_or("this vault is not synced")?;
    syncer.nudge();
    Ok(())
}
