//! The native menu bar.
//!
//! Items that run app commands carry the command id (`file-explorer:new-file`…)
//! and send it to the webview as a `menu-command` event, where it runs like a
//! hotkey would. Only standard shortcuts are menu accelerators (⌘N, ⌘, ⌘W,
//! ⌘Q and the Edit menu); the others stay in the page, where the vault's
//! hotkeys can change them.
//!
//! Quitting goes through the page first (`quit-requested`), so unsaved edits
//! are written before the app exits.

// The menu bar is macOS only; quitting through the page applies everywhere.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Set once the page has saved and the app may exit.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// How long the page gets to save before the app quits anyway.
const QUIT_GRACE: Duration = Duration::from_secs(3);

const QUIT_ID: &str = "app:quit";
const CLOSE_WINDOW_ID: &str = "window:close";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let command = |id: &str, label: &str, accelerator: Option<&str>| MenuItem::with_id(app, id, label, true, accelerator);
    let separator = || PredefinedMenuItem::separator(app);
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        comments: Some("Markdown notes, compatible with Obsidian vaults.".into()),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        &info.name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &separator()?,
            &command("app:open-settings", "Settings…", Some("CmdOrCtrl+,"))?,
            &separator()?,
            &PredefinedMenuItem::services(app, None)?,
            &separator()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &separator()?,
            &command(QUIT_ID, &format!("Quit {}", info.name), Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &command("file-explorer:new-file", "New Note", Some("CmdOrCtrl+N"))?,
            &command("file-explorer:new-folder", "New Folder", None)?,
            &separator()?,
            &command("app:open-vault", "Open Vault…", None)?,
            &command("emerald:connect-server", "Connect to Server…", None)?,
            &separator()?,
            &command("workspace:close", "Close Note", Some("CmdOrCtrl+W"))?,
            &command(CLOSE_WINDOW_ID, "Close Window", Some("CmdOrCtrl+Shift+W"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &command("command-palette:open", "Command Palette…", None)?,
            &command("switcher:open", "Quick Switcher…", None)?,
            &command("global-search:open", "Search in Vault…", None)?,
            &separator()?,
            &command("markdown:toggle-preview", "Toggle Reading View", None)?,
            &command("editor:toggle-source", "Toggle Live Preview / Source Mode", None)?,
            &separator()?,
            &command("app:toggle-left-sidebar", "Toggle Left Sidebar", None)?,
            &command("app:toggle-right-sidebar", "Toggle Right Sidebar", None)?,
            &command("graph:open", "Graph View", None)?,
            &separator()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        QUIT_ID => request_quit(app),
        CLOSE_WINDOW_ID => {
            if let Some(window) = app.get_webview_window("main") {
                // Goes through the page's close handler, which saves first.
                let _ = window.close();
            }
        }
        id => {
            let _ = app.emit("menu-command", id);
        }
    }
}

/// Asks the page to save, then quit (`quit_app`). Quits anyway after a grace period.
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    if app.webview_windows().is_empty() {
        quit(app);
        return;
    }
    let _ = app.emit("quit-requested", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_GRACE);
        quit(&handle);
    });
}

/// Whether an exit request may go ahead; otherwise the page is asked to save first.
pub fn may_exit() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

fn quit<R: Runtime>(app: &AppHandle<R>) {
    QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Called by the page once pending edits are saved.
#[tauri::command]
pub fn quit_app<R: Runtime>(app: AppHandle<R>) {
    quit(&app);
}
