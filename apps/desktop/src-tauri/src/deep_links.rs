//! `emeraldmd://` links (the scheme is declared in Info.plist). macOS sends
//! them with `RunEvent::Opened`, when they start the app or later. They wait
//! here until the page takes them (`take_open_urls`); an `open-url` event
//! tells the page there are some, and the window comes to the front.

use std::sync::Mutex;

use tauri::State;
#[cfg(any(target_os = "macos", target_os = "ios"))]
use tauri::{AppHandle, Emitter, Manager};

// macOS and iOS hand links to the app with `RunEvent::Opened`; other systems need a plugin, still to come.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub const SCHEME: &str = "emeraldmd";

/// Links received and not yet taken by the page.
#[derive(Default)]
pub struct OpenUrls(Mutex<Vec<String>>);

/// Keeps the `emeraldmd://` links among `urls` for the page, and shows the window.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn received<'a>(app: &AppHandle, urls: impl IntoIterator<Item = &'a str>) {
    let links: Vec<String> = urls.into_iter().filter(|u| u.starts_with(&format!("{SCHEME}:"))).map(str::to_owned).collect();
    if links.is_empty() {
        return;
    }
    if let Ok(mut queue) = app.state::<OpenUrls>().0.lock() {
        queue.extend(links);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("open-url", ());
}

/// The links received since the last call.
#[tauri::command]
pub fn take_open_urls(urls: State<'_, OpenUrls>) -> Vec<String> {
    urls.0.lock().map(|mut queue| std::mem::take(&mut *queue)).unwrap_or_default()
}
