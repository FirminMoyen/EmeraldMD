//! Tauri shell: exposes `emerald-core` to the webview as commands, and pushes
//! changes made outside the app as `vault-changed` events.

mod http;
mod remote;
mod search;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use emerald_core::{ConfigListing, FileEntry, Vault, VaultSession, VaultSnapshot, VaultUpdate};
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

struct OpenVault {
    session: VaultSession,
    /// Dropping the watcher stops it.
    _watcher: notify::RecommendedWatcher,
}

#[derive(Default)]
struct AppState {
    vault: Mutex<Option<OpenVault>>,
}

type CmdResult<T> = Result<T, String>;

fn with_session<T>(
    state: &AppState,
    f: impl FnOnce(&mut VaultSession) -> emerald_core::vault::Result<T>,
) -> CmdResult<T> {
    let mut guard = state.vault.lock().map_err(|_| "vault state is poisoned".to_owned())?;
    let open = guard.as_mut().ok_or("no vault is open")?;
    f(&mut open.session).map_err(|e| e.to_string())
}

fn with_vault<T>(state: &AppState, f: impl FnOnce(&Vault) -> emerald_core::vault::Result<T>) -> CmdResult<T> {
    with_session(state, |s| f(s.vault()))
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
    last_vault: Option<String>,
    /// Vault folders where the user turned community plugins on (restricted
    /// mode off). Plugins run code, so this is decided per vault, in EmeraldMD.
    #[serde(default)]
    trusted_vaults: Vec<String>,
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &Settings) {
    let Some(path) = settings_path(app) else { return };
    let result = path
        .parent()
        .map_or(Ok(()), fs::create_dir_all)
        .and_then(|()| fs::write(&path, serde_json::to_string_pretty(settings).unwrap_or_default()));
    if let Err(err) = result {
        eprintln!("could not save settings: {err}");
    }
}

/// Watches the vault folder and forwards external changes to the webview.
fn watch(app: AppHandle, root: PathBuf) -> notify::Result<notify::RecommendedWatcher> {
    let watched_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        let state = app.state::<AppState>();
        let Ok(mut guard) = state.vault.lock() else { return };
        let Some(open) = guard.as_mut() else { return };
        // Events can still arrive from a vault that was just closed.
        if open.session.vault().root() != watched_root {
            return;
        }
        for path in &event.paths {
            let Some(vault_path) = open.session.vault().vault_path(path) else { continue };
            match open.session.sync_path(&vault_path) {
                Ok(update) if !update.is_empty() => {
                    let _ = app.emit("vault-changed", &update);
                }
                Ok(_) => {}
                Err(err) => eprintln!("could not sync {vault_path}: {err}"),
            }
        }
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    Ok(watcher)
}

#[tauri::command]
async fn last_vault(app: AppHandle) -> Option<String> {
    load_settings(&app).last_vault.filter(|p| Path::new(p).is_dir())
}

#[tauri::command]
async fn open_vault(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<VaultSnapshot> {
    let session = VaultSession::open(&path).map_err(|e| e.to_string())?;
    let snapshot = session.snapshot();
    let watcher = watch(app.clone(), session.vault().root().to_path_buf()).map_err(|e| e.to_string())?;
    *state.vault.lock().map_err(|_| "vault state is poisoned".to_owned())? =
        Some(OpenVault { session, _watcher: watcher });
    let mut settings = load_settings(&app);
    settings.last_vault = Some(path);
    save_settings(&app, &settings);
    Ok(snapshot)
}

#[tauri::command]
async fn read_file(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    with_session(&state, |s| s.read(&path))
}

#[tauri::command]
async fn write_file(state: State<'_, AppState>, path: String, data: String) -> CmdResult<VaultUpdate> {
    with_session(&state, |s| s.write(&path, &data))
}

#[tauri::command]
async fn create_file(state: State<'_, AppState>, path: String, data: String) -> CmdResult<VaultUpdate> {
    with_session(&state, |s| s.create(&path, &data))
}

#[tauri::command]
async fn create_folder(state: State<'_, AppState>, path: String) -> CmdResult<VaultUpdate> {
    with_session(&state, |s| s.create_folder(&path))
}

#[tauri::command]
async fn rename_path(state: State<'_, AppState>, from: String, to: String) -> CmdResult<VaultUpdate> {
    with_session(&state, |s| s.rename(&from, &to))
}

#[tauri::command]
async fn trash_path(state: State<'_, AppState>, path: String) -> CmdResult<VaultUpdate> {
    with_session(&state, |s| s.trash(&path))
}

#[tauri::command]
async fn config_read(state: State<'_, AppState>, path: String) -> CmdResult<Option<String>> {
    with_vault(&state, |v| v.read_config(&path))
}

#[tauri::command]
async fn config_write(state: State<'_, AppState>, path: String, data: String) -> CmdResult<()> {
    with_vault(&state, |v| v.write_config(&path, &data))
}

#[tauri::command]
async fn config_list(state: State<'_, AppState>, path: String) -> CmdResult<ConfigListing> {
    with_vault(&state, |v| v.list_config(&path))
}

#[tauri::command]
async fn config_stat(state: State<'_, AppState>, path: String) -> CmdResult<Option<FileEntry>> {
    with_vault(&state, |v| v.config_entry(&path))
}

#[tauri::command]
async fn config_mkdir(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    with_vault(&state, |v| v.create_config_folder(&path))
}

fn open_vault_root(state: &AppState) -> CmdResult<String> {
    with_vault(state, |v| Ok(v.root().display().to_string()))
}

/// Whether community plugins may run in the open vault (restricted mode is off).
#[tauri::command]
async fn community_plugins_trusted(app: AppHandle, state: State<'_, AppState>) -> CmdResult<bool> {
    let root = open_vault_root(&state)?;
    Ok(load_settings(&app).trusted_vaults.contains(&root))
}

#[tauri::command]
async fn set_community_plugins_trusted(app: AppHandle, state: State<'_, AppState>, trusted: bool) -> CmdResult<()> {
    let root = open_vault_root(&state)?;
    let mut settings = load_settings(&app);
    settings.trusted_vaults.retain(|v| v != &root);
    if trusted {
        settings.trusted_vaults.push(root);
    }
    save_settings(&app, &settings);
    Ok(())
}

#[tauri::command]
async fn request_url(request: http::HttpRequest) -> CmdResult<http::HttpResponse> {
    http::send(request).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            last_vault,
            open_vault,
            read_file,
            write_file,
            create_file,
            create_folder,
            rename_path,
            trash_path,
            config_read,
            config_write,
            config_list,
            config_stat,
            config_mkdir,
            community_plugins_trusted,
            set_community_plugins_trusted,
            request_url,
            remote::remote_vaults,
            remote::remember_remote_vault,
            remote::forget_remote_vault,
            remote::remote_token,
            remote::set_reopen_remote_vault,
            search::search_vault,
        ])
        .run(tauri::generate_context!())
        .expect("error while running EmeraldMD");
}
