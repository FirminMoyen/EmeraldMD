//! Vaults kept in the app's own storage. On Android and iOS the system folder
//! picker hands out content URIs rather than paths, so vaults live in the
//! app's Documents folder (visible in the Files app on iOS).

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppVaults {
    pub dir: String,
    /// Vault folder names, sorted.
    pub vaults: Vec<String>,
}

fn vaults_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().document_dir().or_else(|_| app.path().app_data_dir()).map_err(|e| e.to_string())?;
    let dir = base.join("EmeraldMD");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

#[tauri::command]
pub async fn app_vaults(app: AppHandle) -> Result<AppVaults, String> {
    let dir = vaults_dir(&app)?;
    let mut vaults: Vec<String> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with('.'))
        .collect();
    vaults.sort_by_key(|v| v.to_lowercase());
    Ok(AppVaults { dir: dir.display().to_string(), vaults })
}

/// Creates (or reuses) a vault folder and returns its path.
#[tauri::command]
pub async fn create_app_vault(app: AppHandle, name: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 100 || name.starts_with('.') || name.contains(['/', '\\', ':']) {
        return Err("Vault names cannot be empty, start with a dot, or contain / \\ :".into());
    }
    let path = vaults_dir(&app)?.join(name);
    fs::create_dir_all(&path).map_err(|e| format!("cannot create {}: {e}", path.display()))?;
    Ok(path.display().to_string())
}
