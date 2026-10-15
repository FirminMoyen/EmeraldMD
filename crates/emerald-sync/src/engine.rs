//! Runs one sync pass between a local vault and a server.
//!
//! State lives in the vault's hidden `.emeraldmd/` folder: the base manifest
//! (what both sides agreed on last time), a hash cache, and the base content
//! of text files, which three-way merges need.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use emerald_core::{Vault, VaultError, VaultSession, VaultUpdate};

use crate::manifest::{FileState, HashCache, Manifest, hash_bytes};
use crate::merge::merge_text;
use crate::plan::{Action, is_text, plan};

pub const STATE_PATH: &str = ".emeraldmd/sync.json";
const BASE_DIR: &str = ".emeraldmd/sync-base";

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error(transparent)]
    Vault(#[from] VaultError),
    #[error("server error: {0}")]
    Remote(String),
    #[error("sync state is unreadable: {0}")]
    State(String),
}

/// The server side of a sync.
pub trait Remote {
    fn manifest(&mut self) -> Result<Manifest, SyncError>;
    fn read(&mut self, path: &str) -> Result<Vec<u8>, SyncError>;
    fn write(&mut self, path: &str, data: &[u8]) -> Result<(), SyncError>;
    /// Moves the file to the server vault's trash.
    fn trash(&mut self, path: &str) -> Result<(), SyncError>;
}

#[derive(Serialize, Deserialize, Default, Debug, PartialEq, Eq)]
pub struct SyncState {
    pub base: Manifest,
    pub hashes: HashCache,
}

impl SyncState {
    pub fn load(vault: &Vault) -> Result<Self, SyncError> {
        match vault.read_bytes(STATE_PATH) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| SyncError::State(e.to_string())),
            Err(VaultError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save(&self, vault: &Vault) -> Result<(), SyncError> {
        let json = serde_json::to_vec(self).map_err(|e| SyncError::State(e.to_string()))?;
        vault.write_bytes(STATE_PATH, &json)?;
        Ok(())
    }
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// Actions that completed.
    pub done: Vec<Action>,
    /// Conflict copies created this pass.
    pub conflict_copies: Vec<String>,
    /// Actions that failed; they are retried on the next pass.
    pub failed: Vec<(Action, String)>,
    /// Local changes made by the sync, for the UI mirror.
    pub update: VaultUpdate,
}

fn absorb(into: &mut VaultUpdate, update: VaultUpdate) {
    into.renamed.extend(update.renamed);
    into.removed.extend(update.removed);
    into.upserted.extend(update.upserted);
    into.metadata.extend(update.metadata);
    into.links.extend(update.links);
}

fn base_blob(hash: &str) -> String {
    format!("{BASE_DIR}/{hash}")
}

/// Brings `session`'s vault and the server in line. `device` names conflict copies.
pub fn sync_once(session: &mut VaultSession, remote: &mut dyn Remote, device: &str) -> Result<SyncReport, SyncError> {
    let mut state = SyncState::load(session.vault())?;
    let local = state.hashes.scan(session.vault())?;
    let server = remote.manifest()?;
    let mut report = SyncReport::default();
    // The file watcher normally keeps the index current; don't depend on its timing.
    let stale: Vec<String> = local
        .keys()
        .filter(|p| session.index().entry(p).is_none())
        .cloned()
        .chain(
            session
                .index()
                .entries()
                .filter(|e| e.kind == emerald_core::EntryKind::File && !local.contains_key(&e.path))
                .map(|e| e.path.clone()),
        )
        .collect();
    for path in stale {
        absorb(&mut report.update, session.sync_path(&path)?);
    }
    let mut run = Runner { session: &mut *session, remote, state: &mut state, local: &local, server: &server, device };
    for action in plan(&run.state.base.clone(), &local, &server) {
        match run.apply(&action, &mut report) {
            Ok(()) => report.done.push(action),
            Err(err) => report.failed.push((action, err.to_string())),
        }
    }
    run.collect_garbage();
    state.save(session.vault())?;
    Ok(report)
}

struct Runner<'a> {
    session: &'a mut VaultSession,
    remote: &'a mut dyn Remote,
    state: &'a mut SyncState,
    local: &'a Manifest,
    server: &'a Manifest,
    device: &'a str,
}

impl Runner<'_> {
    fn apply(&mut self, action: &Action, report: &mut SyncReport) -> Result<(), SyncError> {
        match action {
            Action::Upload(path) => {
                let data = self.session.vault().read_bytes(path)?;
                self.remote.write(path, &data)?;
                self.agreed(path, &data)
            }
            Action::Download(path) => {
                let data = self.download(path)?;
                absorb(&mut report.update, self.session.write_bytes(path, &data)?);
                self.agreed(path, &data)
            }
            Action::DeleteRemote(path) => {
                self.remote.trash(path)?;
                self.state.base.remove(path);
                Ok(())
            }
            Action::DeleteLocal(path) => {
                absorb(&mut report.update, self.session.trash(path)?);
                self.state.base.remove(path);
                Ok(())
            }
            Action::Agree(path) => {
                match self.local.get(path) {
                    Some(_) => {
                        let data = self.session.vault().read_bytes(path)?;
                        self.agreed(path, &data)?;
                    }
                    None => {
                        self.state.base.remove(path);
                    }
                }
                Ok(())
            }
            Action::Merge(path) => {
                let base_hash = self.state.base.get(path).map(|s| s.hash.clone());
                let base_text = base_hash.and_then(|h| self.session.vault().read_bytes(&base_blob(&h)).ok());
                let local_data = self.session.vault().read_bytes(path)?;
                let remote_data = self.download(path)?;
                let merged = match (base_text, std::str::from_utf8(&local_data), std::str::from_utf8(&remote_data)) {
                    (Some(base), Ok(local), Ok(remote)) => {
                        std::str::from_utf8(&base).ok().and_then(|base| merge_text(base, local, remote))
                    }
                    _ => None,
                };
                match merged {
                    Some(text) => {
                        absorb(&mut report.update, self.session.write_bytes(path, text.as_bytes())?);
                        self.remote.write(path, text.as_bytes())?;
                        self.agreed(path, text.as_bytes())
                    }
                    None => self.conflict_copy(path, local_data, remote_data, report),
                }
            }
            Action::ConflictCopy(path) => {
                let local_data = self.session.vault().read_bytes(path)?;
                let remote_data = self.download(path)?;
                self.conflict_copy(path, local_data, remote_data, report)
            }
        }
    }

    /// Downloads `path` and checks it against the server manifest, so a file
    /// that changed mid-sync is left for the next pass.
    fn download(&mut self, path: &str) -> Result<Vec<u8>, SyncError> {
        let data = self.remote.read(path)?;
        let expected = self.server.get(path).map(|s| s.hash.as_str());
        if expected != Some(hash_bytes(&data).as_str()) {
            return Err(SyncError::Remote(format!("{path} changed on the server during sync")));
        }
        Ok(data)
    }

    /// Keeps the server's version at `path` and the local one as a renamed copy on both sides.
    fn conflict_copy(
        &mut self,
        path: &str,
        local_data: Vec<u8>,
        remote_data: Vec<u8>,
        report: &mut SyncReport,
    ) -> Result<(), SyncError> {
        let copy = self.copy_name(path);
        absorb(&mut report.update, self.session.write_bytes(&copy, &local_data)?);
        self.remote.write(&copy, &local_data)?;
        self.agreed(&copy, &local_data)?;
        absorb(&mut report.update, self.session.write_bytes(path, &remote_data)?);
        self.agreed(path, &remote_data)?;
        report.conflict_copies.push(copy);
        Ok(())
    }

    fn copy_name(&self, path: &str) -> String {
        let (stem, ext) = match path.rsplit_once('.') {
            Some((stem, ext)) if !stem.ends_with('/') && !stem.is_empty() => (stem, format!(".{ext}")),
            _ => (path, String::new()),
        };
        let device: String = self.device.chars().filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-').collect();
        let base = format!("{stem} (conflict {} {})", timestamp(), device.trim());
        let taken = |p: &str| self.local.contains_key(p) || self.server.contains_key(p) || self.session.index().entry(p).is_some();
        let mut candidate = format!("{base}{ext}");
        let mut n = 2;
        while taken(&candidate) {
            candidate = format!("{base} {n}{ext}");
            n += 1;
        }
        candidate
    }

    /// Records that both sides now hold `data` at `path`.
    fn agreed(&mut self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        let hash = hash_bytes(data);
        if is_text(path) {
            self.session.vault().write_bytes(&base_blob(&hash), data)?;
        }
        self.state.base.insert(path.to_owned(), FileState { hash, size: data.len() as u64 });
        Ok(())
    }

    /// Removes base contents no longer referenced by the base manifest.
    fn collect_garbage(&self) {
        let vault = self.session.vault();
        let Ok(dir) = vault.full_path(BASE_DIR) else { return };
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !self.state.base.values().any(|s| s.hash == name) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// `YYYY-MM-DD HHMM` in UTC.
fn timestamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {:02}{:02}", rem / 3600, rem % 3600 / 60)
}

#[cfg(test)]
mod tests {
    #[test]
    fn timestamp_shape() {
        let t = super::timestamp();
        assert_eq!(t.len(), 15, "{t}");
        assert!(t.starts_with("20"));
    }
}
