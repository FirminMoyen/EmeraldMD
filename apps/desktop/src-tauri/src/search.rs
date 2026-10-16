//! Vault search for the webview (query syntax: docs/search.md).

use emerald_core::{SearchOptions, SearchResults};
use tauri::State;

use crate::AppState;

#[tauri::command]
pub async fn search_vault(
    state: State<'_, AppState>,
    query: String,
    options: Option<SearchOptions>,
) -> Result<SearchResults, String> {
    let mut guard = state.vault.lock().map_err(|_| "vault state is poisoned".to_owned())?;
    let open = guard.as_mut().ok_or("no vault is open")?;
    open.session.search(&query, &options.unwrap_or_default()).map_err(|e| e.to_string())
}
