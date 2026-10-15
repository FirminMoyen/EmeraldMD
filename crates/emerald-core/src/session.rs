//! An open vault: the files on disk plus their index. Every mutation returns a
//! [`VaultUpdate`] describing what changed, which front ends (the desktop
//! webview, and later the server's clients) apply to their mirror.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use crate::index::{LinkSets, VaultIndex};
use crate::metadata::{CachedMetadata, parse_markdown};
use crate::path::{is_markdown, normalize_path, parent_path};
use crate::vault::{EntryKind, FileEntry, Result, Vault, VaultError};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultSnapshot {
    pub name: String,
    pub base_path: String,
    /// Sorted by path, so parents come before their children.
    pub files: Vec<FileEntry>,
    pub metadata: BTreeMap<String, CachedMetadata>,
    pub links: BTreeMap<String, LinkSets>,
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultUpdate {
    /// `[from, to]` pairs. Only the moved item is listed, not its descendants.
    pub renamed: Vec<(String, String)>,
    /// Removed paths, children before parents.
    pub removed: Vec<String>,
    /// New or changed entries, parents before children.
    pub upserted: Vec<FileEntry>,
    pub metadata: BTreeMap<String, CachedMetadata>,
    /// Link sets that changed, keyed by source note.
    pub links: BTreeMap<String, LinkSets>,
}

impl VaultUpdate {
    pub fn is_empty(&self) -> bool {
        self.renamed.is_empty()
            && self.removed.is_empty()
            && self.upserted.is_empty()
            && self.metadata.is_empty()
            && self.links.is_empty()
    }
}

pub struct VaultSession {
    vault: Vault,
    index: VaultIndex,
}

impl VaultSession {
    /// Opens a vault folder and indexes every visible file.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let mut session = Self { vault: Vault::open(root)?, index: VaultIndex::new() };
        session.index_from_disk("/", &mut VaultUpdate::default())?;
        session.index.relink_all();
        Ok(session)
    }

    pub fn vault(&self) -> &Vault {
        &self.vault
    }

    pub fn index(&self) -> &VaultIndex {
        &self.index
    }

    pub fn snapshot(&self) -> VaultSnapshot {
        let mut files: Vec<FileEntry> = self.index.entries().cloned().collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        VaultSnapshot {
            name: self.vault.name(),
            base_path: self.vault.root().display().to_string(),
            files,
            metadata: self.index.all_metadata().iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            links: self.index.all_links().iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        }
    }

    pub fn read(&self, path: &str) -> Result<String> {
        self.vault.read(path)
    }

    pub fn write(&mut self, path: &str, data: &str) -> Result<VaultUpdate> {
        let path = self.visible_path(path)?;
        let entry = self.vault.write(&path, data)?;
        let mut update = VaultUpdate::default();
        self.after_file_written(entry, Some(data), &mut update)?;
        Ok(update)
    }

    /// Writes any file, attachments included. Markdown must be UTF-8.
    pub fn write_bytes(&mut self, path: &str, data: &[u8]) -> Result<VaultUpdate> {
        let path = self.visible_path(path)?;
        let text = if is_markdown(&path) {
            Some(std::str::from_utf8(data).map_err(|e| {
                VaultError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, format!("{path} is not UTF-8: {e}")))
            })?)
        } else {
            None
        };
        let entry = self.vault.write_bytes(&path, data)?;
        let mut update = VaultUpdate::default();
        self.after_file_written(entry, text, &mut update)?;
        Ok(update)
    }

    pub fn create(&mut self, path: &str, data: &str) -> Result<VaultUpdate> {
        let path = self.visible_path(path)?;
        let entry = self.vault.create(&path, data)?;
        let mut update = VaultUpdate::default();
        self.after_file_written(entry, Some(data), &mut update)?;
        Ok(update)
    }

    pub fn create_folder(&mut self, path: &str) -> Result<VaultUpdate> {
        let path = self.visible_path(path)?;
        let entry = self.vault.create_folder(&path)?;
        let mut update = VaultUpdate::default();
        self.add_missing_ancestors(&path, &mut update)?;
        self.index.upsert_entry(entry.clone());
        update.upserted.push(entry);
        Ok(update)
    }

    pub fn rename(&mut self, from: &str, to: &str) -> Result<VaultUpdate> {
        let (from, to) = (normalize_path(from), self.visible_path(to)?);
        if self.index.entry(&from).is_none() {
            return Err(VaultError::NotFound(from));
        }
        self.vault.rename(&from, &to)?;
        let mut update = VaultUpdate::default();
        self.add_missing_ancestors(&to, &mut update)?;
        self.index.rename(&from, &to);
        update.renamed.push((from, to));
        self.relink_all(&mut update);
        Ok(update)
    }

    /// Moves `path` to the vault's `.trash` folder.
    pub fn trash(&mut self, path: &str) -> Result<VaultUpdate> {
        let path = normalize_path(path);
        if self.index.entry(&path).is_none() {
            return Err(VaultError::NotFound(path));
        }
        self.vault.trash(&path)?;
        let mut update = VaultUpdate { removed: self.index.remove(&path), ..Default::default() };
        self.relink_all(&mut update);
        Ok(update)
    }

    /// Brings the index in line with what is on disk at `path`, after a change
    /// made outside EmeraldMD (reported by a file watcher).
    pub fn sync_path(&mut self, path: &str) -> Result<VaultUpdate> {
        let path = normalize_path(path);
        let mut update = VaultUpdate::default();
        if !self.vault.is_visible(&path) {
            return Ok(update);
        }
        match self.vault.entry(&path)? {
            None => {
                if self.index.entry(&path).is_some() {
                    update.removed = self.index.remove(&path);
                    self.relink_all(&mut update);
                }
            }
            Some(entry) if entry.kind == EntryKind::Folder => {
                if self.index.entry(&path).is_none() {
                    self.add_missing_ancestors(&path, &mut update)?;
                    self.index.upsert_entry(entry.clone());
                    update.upserted.push(entry);
                    self.index_from_disk(&path, &mut update)?;
                    self.relink_all(&mut update);
                }
            }
            Some(entry) => {
                let unchanged = self.index.entry(&path).is_some_and(|old| old.mtime == entry.mtime && old.size == entry.size);
                if !unchanged {
                    self.after_file_written(entry, None, &mut update)?;
                }
            }
        }
        Ok(update)
    }

    /// Normalizes a path for creating something new; hidden paths are refused
    /// because the index (and Obsidian) never show them.
    fn visible_path(&self, path: &str) -> Result<String> {
        let path = normalize_path(path);
        self.vault.full_path(&path)?;
        if !self.vault.is_visible(&path) {
            return Err(VaultError::OutsideVault(path));
        }
        Ok(path)
    }

    fn after_file_written(&mut self, entry: FileEntry, data: Option<&str>, update: &mut VaultUpdate) -> Result<()> {
        let path = entry.path.clone();
        self.add_missing_ancestors(&path, update)?;
        let is_new = self.index.upsert_entry(entry.clone());
        update.upserted.push(entry);
        if is_markdown(&path) {
            let metadata = match data {
                Some(text) => parse_markdown(text),
                None => parse_markdown(&self.vault.read(&path)?),
            };
            self.index.set_metadata(&path, metadata.clone());
            update.metadata.insert(path.clone(), metadata);
        }
        if is_new {
            // A new file can satisfy links that were unresolved until now.
            self.relink_all(update);
        } else if self.index.relink(&path)
            && let Some(sets) = self.index.link_sets(&path)
        {
            update.links.insert(path, sets.clone());
        }
        Ok(())
    }

    fn add_missing_ancestors(&mut self, path: &str, update: &mut VaultUpdate) -> Result<()> {
        let mut missing = Vec::new();
        let mut folder = parent_path(path);
        while folder != "/" && self.index.entry(folder).is_none() {
            missing.push(folder.to_owned());
            folder = parent_path(folder);
        }
        for folder in missing.into_iter().rev() {
            if let Some(entry) = self.vault.entry(&folder)? {
                self.index.upsert_entry(entry.clone());
                update.upserted.push(entry);
            }
        }
        Ok(())
    }

    fn index_from_disk(&mut self, folder: &str, update: &mut VaultUpdate) -> Result<()> {
        for entry in self.vault.scan(folder)? {
            if entry.kind == EntryKind::File && is_markdown(&entry.path) {
                // An unreadable note (e.g. invalid UTF-8) is listed without metadata.
                if let Ok(text) = self.vault.read(&entry.path) {
                    let metadata = parse_markdown(&text);
                    self.index.set_metadata(&entry.path, metadata.clone());
                    update.metadata.insert(entry.path.clone(), metadata);
                }
            }
            self.index.upsert_entry(entry.clone());
            update.upserted.push(entry);
        }
        Ok(())
    }

    fn relink_all(&mut self, update: &mut VaultUpdate) {
        for source in self.index.relink_all() {
            if let Some(sets) = self.index.link_sets(&source) {
                update.links.insert(source, sets.clone());
            }
        }
    }
}
