//! What a vault contains: every visible file with its content hash.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use emerald_core::{CONFIG_DIR, EntryKind, FileEntry, Vault};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct FileState {
    /// SHA-256 of the content, lower-case hex.
    pub hash: String,
    pub size: u64,
}

/// Vault path -> state, for files only (folders follow from their files).
pub type Manifest = BTreeMap<String, FileState>;

/// Sent back by servers whose manifest includes the config folder when asked (`?config=true`).
pub const MANIFEST_CONFIG_HEADER: &str = "X-EmeraldMD-Manifest-Config";

/// Whether `path` is in the vault's config folder (`.obsidian`).
pub fn is_config(path: &str) -> bool {
    path.strip_prefix(CONFIG_DIR).is_some_and(|rest| rest.starts_with('/'))
}

/// Config files that stay on each device: the window layout, and hidden files.
fn is_local_config(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    matches!(path, ".obsidian/workspace.json" | ".obsidian/workspace-mobile.json") || name.starts_with('.')
}

pub fn hash_bytes(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// Remembers hashes by modification time and size, so unchanged files are
/// not read again on every sync.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct HashCache {
    entries: BTreeMap<String, CachedHash>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
struct CachedHash {
    mtime: u64,
    size: u64,
    hash: String,
}

impl HashCache {
    /// Hashes every visible file in `vault`, reusing cached hashes when the
    /// file's mtime and size are unchanged. Entries for vanished files are dropped.
    pub fn scan(&mut self, vault: &Vault) -> emerald_core::vault::Result<Manifest> {
        self.scan_with(vault, false)
    }

    /// Like [`HashCache::scan`]; with `config`, also the config folder's files
    /// (settings, themes, snippets, plugins), except those that stay on each
    /// device (`workspace.json`). Without it, cached config hashes are kept.
    pub fn scan_with(&mut self, vault: &Vault, config: bool) -> emerald_core::vault::Result<Manifest> {
        let mut manifest = Manifest::new();
        let mut seen = BTreeMap::new();
        let mut entries: Vec<FileEntry> = vault.scan("/")?.into_iter().filter(|e| e.kind == EntryKind::File).collect();
        if config {
            entries.extend(vault.scan_config()?.into_iter().filter(|e| !is_local_config(&e.path)));
        } else {
            seen.extend(self.entries.iter().filter(|(path, _)| is_config(path)).map(|(p, c)| (p.clone(), c.clone())));
        }
        for entry in entries {
            let hash = match self.entries.get(&entry.path) {
                Some(c) if c.mtime == entry.mtime && c.size == entry.size => c.hash.clone(),
                _ => hash_bytes(&vault.read_bytes(&entry.path)?),
            };
            manifest.insert(entry.path.clone(), FileState { hash: hash.clone(), size: entry.size });
            seen.insert(entry.path, CachedHash { mtime: entry.mtime, size: entry.size, hash });
        }
        self.entries = seen;
        Ok(manifest)
    }
}
