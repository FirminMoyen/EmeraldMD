//! What a vault contains: every visible file with its content hash.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use emerald_core::{EntryKind, Vault};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct FileState {
    /// SHA-256 of the content, lower-case hex.
    pub hash: String,
    pub size: u64,
}

/// Vault path -> state, for files only (folders follow from their files).
pub type Manifest = BTreeMap<String, FileState>;

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
        let mut manifest = Manifest::new();
        let mut seen = BTreeMap::new();
        for entry in vault.scan("/")? {
            if entry.kind != EntryKind::File {
                continue;
            }
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
