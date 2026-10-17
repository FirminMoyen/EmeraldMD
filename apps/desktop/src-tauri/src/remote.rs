//! Vaults on an EmeraldMD server that the user connected to. The list is kept
//! in `remote-vaults.json` next to `settings.json`; access tokens go to the OS
//! keychain (one entry per server URL) and are never written to a file.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub(crate) const KEYCHAIN_SERVICE: &str = "org.emeraldmd.desktop";
const MAX_RECENT: usize = 10;

type CmdResult<T> = Result<T, String>;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteVault {
    pub server_url: String,
    pub vault_id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteVaults {
    /// Most recently opened first.
    pub recent: Vec<RemoteVault>,
    /// The last vault opened was `recent[0]`, so reopen it on start.
    pub reopen_last: bool,
}

impl RemoteVaults {
    fn remember(&mut self, vault: RemoteVault) {
        self.recent.retain(|v| !(v.server_url == vault.server_url && v.vault_id == vault.vault_id));
        self.recent.insert(0, vault);
        self.recent.truncate(MAX_RECENT);
        self.reopen_last = true;
    }

    /// Removes a vault; true if no remembered vault uses its server any more.
    fn forget(&mut self, server_url: &str, vault_id: &str) -> bool {
        if self.recent.first().is_some_and(|v| v.server_url == server_url && v.vault_id == vault_id) {
            self.reopen_last = false;
        }
        self.recent.retain(|v| !(v.server_url == server_url && v.vault_id == vault_id));
        !self.recent.iter().any(|v| v.server_url == server_url)
    }
}

fn list_path(app: &AppHandle) -> CmdResult<PathBuf> {
    app.path().app_config_dir().map(|dir| dir.join("remote-vaults.json")).map_err(|e| e.to_string())
}

fn load(app: &AppHandle) -> RemoteVaults {
    list_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, vaults: &RemoteVaults) -> CmdResult<()> {
    let path = list_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(vaults).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("could not save {}: {e}", path.display()))
}

/// Keychain calls can block (the OS may ask the user), so they run off the
/// async runtime's workers.
async fn keychain<T: Send + 'static>(f: impl FnOnce() -> keyring::Result<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("keychain: {e}"))
}

#[tauri::command]
pub async fn remote_vaults(app: AppHandle) -> RemoteVaults {
    load(&app)
}

/// Puts the vault first in the recent list, marks it to be reopened on start,
/// and stores the token in the keychain if one is given.
#[tauri::command]
pub async fn remember_remote_vault(app: AppHandle, vault: RemoteVault, token: Option<String>) -> CmdResult<()> {
    let server_url = vault.server_url.clone();
    let mut vaults = load(&app);
    vaults.remember(vault);
    save(&app, &vaults)?;
    if let Some(token) = token {
        keychain(move || keyring::Entry::new(KEYCHAIN_SERVICE, &server_url)?.set_password(&token)).await?;
    }
    Ok(())
}

/// Removes the vault from the list, and its server's token once no listed
/// vault uses that server.
#[tauri::command]
pub async fn forget_remote_vault(app: AppHandle, server_url: String, vault_id: String) -> CmdResult<()> {
    let mut vaults = load(&app);
    let last_on_server = vaults.forget(&server_url, &vault_id);
    save(&app, &vaults)?;
    if last_on_server {
        keychain(move || match keyring::Entry::new(KEYCHAIN_SERVICE, &server_url)?.delete_credential() {
            Err(keyring::Error::NoEntry) => Ok(()),
            other => other,
        })
        .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_token(server_url: String) -> CmdResult<Option<String>> {
    keychain(move || match keyring::Entry::new(KEYCHAIN_SERVICE, &server_url)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err),
    })
    .await
}

/// Called with `false` when a local vault is opened.
#[tauri::command]
pub async fn set_reopen_remote_vault(app: AppHandle, reopen: bool) -> CmdResult<()> {
    let mut vaults = load(&app);
    if vaults.reopen_last != reopen {
        vaults.reopen_last = reopen && !vaults.recent.is_empty();
        save(&app, &vaults)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(server: &str, id: &str) -> RemoteVault {
        RemoteVault { server_url: server.into(), vault_id: id.into(), name: id.into() }
    }

    #[test]
    fn keeps_the_most_recent_first_without_duplicates() {
        let mut vaults = RemoteVaults::default();
        vaults.remember(vault("https://a", "one"));
        vaults.remember(vault("https://a", "two"));
        vaults.remember(vault("https://a", "one"));
        let ids: Vec<_> = vaults.recent.iter().map(|v| v.vault_id.as_str()).collect();
        assert_eq!(ids, ["one", "two"]);
        assert!(vaults.reopen_last);
        for i in 0..20 {
            vaults.remember(vault("https://b", &i.to_string()));
        }
        assert_eq!(vaults.recent.len(), MAX_RECENT);
    }

    #[test]
    fn forgetting_reports_when_a_server_is_no_longer_used() {
        let mut vaults = RemoteVaults::default();
        vaults.remember(vault("https://a", "one"));
        vaults.remember(vault("https://a", "two"));
        vaults.remember(vault("https://b", "three"));
        assert!(!vaults.forget("https://a", "one"));
        assert!(vaults.reopen_last, "the last opened vault is still listed");
        assert!(vaults.forget("https://b", "three"));
        assert!(!vaults.reopen_last);
        assert!(vaults.forget("https://a", "two"));
        assert!(vaults.recent.is_empty());
    }

    #[test]
    fn reads_the_file_format() {
        let vaults: RemoteVaults = serde_json::from_str(
            r#"{"recent":[{"serverUrl":"https://a","vaultId":"notes","name":"Notes"}],"reopenLast":true}"#,
        )
        .unwrap();
        assert_eq!(vaults.recent, [RemoteVault { server_url: "https://a".into(), vault_id: "notes".into(), name: "Notes".into() }]);
    }
}
