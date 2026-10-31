//! Tauri shell: exposes `emerald-core` to the webview as commands, and pushes
//! changes made outside the app as `vault-changed` events.

mod http;
mod menu;
mod remote;
mod search;
mod synced;

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
    /// Background sync, for vaults that are synced copies of a server vault.
    syncer: Option<synced::Syncer>,
}

/// Asks the open vault's syncer, if any, for a pass soon (after an edit).
fn nudge_sync(state: &AppState) {
    if let Ok(guard) = state.vault.lock()
        && let Some(syncer) = guard.as_ref().and_then(|open| open.syncer.as_ref())
    {
        syncer.nudge();
    }
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
    /// Vaults where the user turned community plugins on (restricted mode
    /// off): local folders, and `remote:<server URL>|<vault id>` for server
    /// vaults. Plugins run code, so this is decided per vault, in EmeraldMD.
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
            // The config folder is not indexed; the webview reloads themes and snippets from it.
            if vault_path.starts_with(".obsidian/") {
                let _ = app.emit("config-changed", &vault_path);
                if let Some(syncer) = &open.syncer {
                    syncer.nudge_config();
                }
                continue;
            }
            match open.session.sync_path(&vault_path) {
                Ok(update) if !update.is_empty() => {
                    let _ = app.emit("vault-changed", &update);
                    if let Some(syncer) = &open.syncer {
                        syncer.nudge();
                    }
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
    let root = session.vault().root().to_path_buf();
    let syncer = synced::config_for(&app, &root).map(|config| synced::Syncer::start(app.clone(), config, root));
    // Lets the webview load the vault's attachments (images, PDFs) through the asset protocol.
    app.asset_protocol_scope().allow_directory(session.vault().root(), true).map_err(|e| e.to_string())?;
    *state.vault.lock().map_err(|_| "vault state is poisoned".to_owned())? =
        Some(OpenVault { session, _watcher: watcher, syncer });
    // The first pass of a synced vault, now that the session is in place.
    nudge_sync(&state);
    let mut settings = load_settings(&app);
    settings.last_vault = Some(path);
    save_settings(&app, &settings);
    Ok(snapshot)
}

#[tauri::command]
async fn read_file(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    with_session(&state, |s| s.read(&path))
}

/// Any file's bytes (attachments), returned as a raw buffer rather than JSON.
#[tauri::command]
async fn read_binary(state: State<'_, AppState>, path: String) -> CmdResult<tauri::ipc::Response> {
    with_session(&state, |s| s.vault().read_bytes(&path)).map(tauri::ipc::Response::new)
}

/// Writes a file from the raw request body; the vault path is the
/// percent-encoded `path` header.
#[tauri::command]
fn write_binary(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> CmdResult<VaultUpdate> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("write_binary expects raw bytes".into());
    };
    let header = request.headers().get("path").and_then(|v| v.to_str().ok()).ok_or("missing path header")?;
    let path = percent_encoding::percent_decode_str(header).decode_utf8().map_err(|e| e.to_string())?;
    let update = with_session(&state, |s| s.write_bytes(&path, data))?;
    nudge_sync(&state);
    Ok(update)
}

#[tauri::command]
async fn write_file(state: State<'_, AppState>, path: String, data: String) -> CmdResult<VaultUpdate> {
    let update = with_session(&state, |s| s.write(&path, &data))?;
    nudge_sync(&state);
    Ok(update)
}

#[tauri::command]
async fn create_file(state: State<'_, AppState>, path: String, data: String) -> CmdResult<VaultUpdate> {
    let update = with_session(&state, |s| s.create(&path, &data))?;
    nudge_sync(&state);
    Ok(update)
}

#[tauri::command]
async fn create_folder(state: State<'_, AppState>, path: String) -> CmdResult<VaultUpdate> {
    let update = with_session(&state, |s| s.create_folder(&path))?;
    nudge_sync(&state);
    Ok(update)
}

#[tauri::command]
async fn rename_path(state: State<'_, AppState>, from: String, to: String) -> CmdResult<VaultUpdate> {
    let update = with_session(&state, |s| s.rename(&from, &to))?;
    nudge_sync(&state);
    Ok(update)
}

#[tauri::command]
async fn trash_path(state: State<'_, AppState>, path: String) -> CmdResult<VaultUpdate> {
    let update = with_session(&state, |s| s.trash(&path))?;
    nudge_sync(&state);
    Ok(update)
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

/// Moves a plugin's or theme's folder (`.obsidian/plugins/<id>`,
/// `.obsidian/themes/<name>`) to the vault's `.trash`, for uninstalling.
/// Other config paths are refused.
#[tauri::command]
async fn config_trash(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    with_vault(&state, |v| v.trash_config_folder(&path))
}

/// Config folders the UI may show in the file manager.
const SHOWABLE_CONFIG_FOLDERS: [&str; 2] = [".obsidian/snippets", ".obsidian/themes"];

/// Opens a config folder (snippets or themes) in the system file manager, creating it if needed.
#[tauri::command]
async fn show_config_folder(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    if !SHOWABLE_CONFIG_FOLDERS.contains(&path.as_str()) {
        return Err(format!("not a folder that can be shown: {path}"));
    }
    let full = with_vault(&state, |v| {
        v.create_config_folder(&path)?;
        v.config_path(&path)
    })?;
    open_with_system(full.as_os_str())
}

/// Shows a file or folder of the open vault in Finder (Explorer, the file manager on Linux).
#[tauri::command]
async fn reveal_path(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let full = with_vault(&state, |v| v.full_path(&path))?;
    if !full.exists() {
        return Err(format!("not found: {path}"));
    }
    let mut command = if cfg!(target_os = "macos") {
        let mut command = std::process::Command::new("open");
        command.arg("-R").arg(&full);
        command
    } else if cfg!(target_os = "windows") {
        let mut command = std::process::Command::new("explorer");
        command.arg(format!("/select,{}", full.display()));
        command
    } else {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(full.parent().unwrap_or(&full));
        command
    };
    command.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Opens a web or mail link in the default app. Other schemes are refused.
#[tauri::command]
async fn open_external(url: String) -> CmdResult<()> {
    let scheme = url.split_once(':').map(|(scheme, _)| scheme.to_ascii_lowercase());
    if !matches!(scheme.as_deref(), Some("http" | "https" | "mailto")) {
        return Err(format!("only web and mail links can be opened: {url}"));
    }
    open_with_system(std::ffi::OsStr::new(&url))
}

/// Hands a path or URL to the system's default handler (Finder, the browser…).
fn open_with_system(target: &std::ffi::OsStr) -> CmdResult<()> {
    let mut command = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
    } else if cfg!(target_os = "windows") {
        let mut command = std::process::Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler");
        command
    } else {
        std::process::Command::new("xdg-open")
    };
    command.arg(target).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn open_vault_root(state: &AppState) -> CmdResult<String> {
    with_vault(state, |v| Ok(v.root().display().to_string()))
}

/// Opens the system's print dialog for the window ("Export to PDF": the page
/// prints only the note it prepared; macOS offers Save as PDF).
#[tauri::command]
async fn print_page(window: tauri::WebviewWindow) -> CmdResult<()> {
    window.print().map_err(|e| e.to_string())
}

/// The key under which a vault's plugin trust is kept: the local vault's
/// folder, or `remote:<server URL>|<vault id>` for a server vault.
fn trust_key(state: &AppState, remote: Option<String>) -> CmdResult<String> {
    match remote {
        Some(id) => {
            if id.is_empty() || id.len() > 2048 || id.chars().any(char::is_control) {
                return Err("invalid server vault".into());
            }
            Ok(format!("remote:{id}"))
        }
        None => open_vault_root(state),
    }
}

/// Whether community plugins may run in the open vault (restricted mode is off).
/// `remote` names a server vault (`<server URL>|<vault id>`); without it, the open local vault.
#[tauri::command]
async fn community_plugins_trusted(app: AppHandle, state: State<'_, AppState>, remote: Option<String>) -> CmdResult<bool> {
    let key = trust_key(&state, remote)?;
    Ok(load_settings(&app).trusted_vaults.contains(&key))
}

#[tauri::command]
async fn set_community_plugins_trusted(app: AppHandle, state: State<'_, AppState>, trusted: bool, remote: Option<String>) -> CmdResult<()> {
    let key = trust_key(&state, remote)?;
    let mut settings = load_settings(&app);
    settings.trusted_vaults.retain(|v| v != &key);
    if trusted {
        settings.trusted_vaults.push(key);
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Window size and position, restored at launch.
        .plugin(tauri_plugin_window_state::Builder::default().build());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event(menu::on_event);
    builder
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
            read_binary,
            write_binary,
            config_read,
            config_write,
            config_list,
            config_stat,
            config_mkdir,
            config_trash,
            show_config_folder,
            open_external,
            reveal_path,
            community_plugins_trusted,
            set_community_plugins_trusted,
            request_url,
            remote::remote_vaults,
            remote::remember_remote_vault,
            remote::forget_remote_vault,
            remote::remote_token,
            remote::set_reopen_remote_vault,
            search::search_vault,
            synced::synced_vaults,
            synced::create_synced_vault,
            synced::forget_synced_vault,
            synced::open_vault_sync,
            synced::sync_now,
            synced::set_sync_config,
            synced::set_sync_filter,
            print_page,
            menu::quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building EmeraldMD")
        .run(|app, event| {
            // Quitting from the Dock or the system: let the page save first.
            if let tauri::RunEvent::ExitRequested { api, .. } = event
                && !menu::may_exit()
                && !app.webview_windows().is_empty()
            {
                api.prevent_exit();
                menu::request_quit(app);
            }
        });
}
