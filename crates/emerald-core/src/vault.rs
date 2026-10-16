//! A vault is a folder on disk. All public methods take vault paths
//! (see [`crate::path`]) and refuse paths that would escape the vault root.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Serialize, Serializer};

use crate::path::{file_name, is_hidden, normalize_path, split_extension};

/// Deleted files are moved here instead of being removed, like Obsidian's
/// "Move to Obsidian trash" option.
pub const TRASH_FOLDER: &str = ".trash";

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("path escapes the vault: {0}")]
    OutsideVault(String),
    #[error("already exists: {0}")]
    AlreadyExists(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("not a folder: {0}")]
    NotAFolder(String),
    #[error("not in the vault's config folder: {0}")]
    NotConfigPath(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Errors cross the Tauri boundary as plain messages.
impl Serialize for VaultError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, VaultError>;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Folder,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub kind: EntryKind,
    /// Milliseconds since the Unix epoch.
    pub ctime: u64,
    pub mtime: u64,
    pub size: u64,
}

pub struct Vault {
    root: PathBuf,
}

fn millis(time: std::io::Result<SystemTime>) -> u64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

impl Vault {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        // dunce avoids Windows `\\?\` verbatim paths, which reject `/` and
        // never match the plain paths file watchers report.
        let root = dunce::canonicalize(root.as_ref())?;
        if !root.is_dir() {
            return Err(VaultError::NotAFolder(root.display().to_string()));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn name(&self) -> String {
        self.root.file_name().map_or_else(|| "Vault".to_owned(), |n| n.to_string_lossy().into_owned())
    }

    /// Absolute OS path for a vault path.
    pub fn full_path(&self, path: &str) -> Result<PathBuf> {
        let normalized = normalize_path(path);
        if normalized == "/" {
            return Ok(self.root.clone());
        }
        if normalized.split('/').any(|s| s == ".." || s == ".") {
            return Err(VaultError::OutsideVault(path.to_owned()));
        }
        // Join segment by segment so the OS separator is used, then make sure
        // nothing (e.g. a Windows drive prefix like `C:`) replaced the root.
        let full = normalized.split('/').fold(self.root.clone(), |acc, segment| acc.join(segment));
        if !full.starts_with(&self.root) || full == self.root {
            return Err(VaultError::OutsideVault(path.to_owned()));
        }
        Ok(full)
    }

    /// Vault path for an absolute OS path inside the vault.
    pub fn vault_path(&self, full: &Path) -> Option<String> {
        let relative = full.strip_prefix(&self.root).ok()?;
        let joined = relative.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        Some(normalize_path(&joined))
    }

    pub fn entry(&self, path: &str) -> Result<Option<FileEntry>> {
        let full = self.full_path(path)?;
        match fs::metadata(&full) {
            Ok(meta) => {
                let mtime = millis(meta.modified());
                // Not every file system records a creation time.
                let ctime = if meta.created().is_ok() { millis(meta.created()) } else { mtime };
                Ok(Some(FileEntry {
                    path: normalize_path(path),
                    kind: if meta.is_dir() { EntryKind::Folder } else { EntryKind::File },
                    ctime,
                    mtime,
                    size: if meta.is_dir() { 0 } else { meta.len() },
                }))
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    /// Every visible file and folder below `folder` (use `/` for the whole vault),
    /// parents before children. Hidden entries (dot-prefixed) are skipped.
    pub fn scan(&self, folder: &str) -> Result<Vec<FileEntry>> {
        let mut out = Vec::new();
        self.scan_into(&normalize_path(folder), &mut out)?;
        Ok(out)
    }

    fn scan_into(&self, folder: &str, out: &mut Vec<FileEntry>) -> Result<()> {
        let mut names: Vec<String> = fs::read_dir(self.full_path(folder)?)?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| !name.starts_with('.'))
            .collect();
        names.sort();
        for name in names {
            let child = if folder == "/" { normalize_path(&name) } else { normalize_path(&format!("{folder}/{name}")) };
            // Broken symlinks have no metadata; skip them.
            let Some(entry) = self.entry(&child)? else { continue };
            let is_folder = entry.kind == EntryKind::Folder;
            out.push(entry);
            if is_folder {
                self.scan_into(&child, out)?;
            }
        }
        Ok(())
    }

    pub fn read(&self, path: &str) -> Result<String> {
        Ok(fs::read_to_string(self.full_path(path)?)?)
    }

    /// Writes a file, creating parent folders as needed.
    pub fn write(&self, path: &str, data: &str) -> Result<FileEntry> {
        let full = self.full_path(path)?;
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&full, data)?;
        self.entry(path)?.ok_or_else(|| VaultError::NotFound(path.to_owned()))
    }

    /// Like [`Vault::write`], but fails if something already exists at `path`.
    pub fn create(&self, path: &str, data: &str) -> Result<FileEntry> {
        if self.full_path(path)?.exists() {
            return Err(VaultError::AlreadyExists(normalize_path(path)));
        }
        self.write(path, data)
    }

    pub fn create_folder(&self, path: &str) -> Result<FileEntry> {
        let full = self.full_path(path)?;
        if full.exists() {
            return Err(VaultError::AlreadyExists(normalize_path(path)));
        }
        fs::create_dir_all(&full)?;
        self.entry(path)?.ok_or_else(|| VaultError::NotFound(path.to_owned()))
    }

    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let (from_full, to_full) = (self.full_path(from)?, self.full_path(to)?);
        if !from_full.exists() {
            return Err(VaultError::NotFound(normalize_path(from)));
        }
        // A case-only rename ("note" -> "Note") hits the same file on
        // case-insensitive file systems, so it must not count as a collision.
        let case_only = normalize_path(from).to_lowercase() == normalize_path(to).to_lowercase();
        if to_full.exists() && !case_only {
            return Err(VaultError::AlreadyExists(normalize_path(to)));
        }
        if let Some(parent) = to_full.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(from_full, to_full)?;
        Ok(())
    }

    /// Moves a file or folder into the vault's `.trash` folder and returns its
    /// new vault path. Nothing is ever deleted permanently.
    pub fn trash(&self, path: &str) -> Result<String> {
        let path = normalize_path(path);
        if !self.full_path(&path)?.exists() {
            return Err(VaultError::NotFound(path));
        }
        let name = file_name(&path);
        let (base, ext) = split_extension(name);
        let mut target = format!("{TRASH_FOLDER}/{name}");
        let mut n = 1;
        while self.full_path(&target)?.exists() {
            target = if ext.is_empty() { format!("{TRASH_FOLDER}/{base} {n}") } else { format!("{TRASH_FOLDER}/{base} {n}.{ext}") };
            n += 1;
        }
        self.rename(&path, &target)?;
        Ok(target)
    }

    /// False for the root and for hidden paths (config folder, `.trash`, dotfiles).
    pub fn is_visible(&self, path: &str) -> bool {
        path != "/" && !is_hidden(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        (dir, vault)
    }

    #[test]
    fn writes_scans_and_skips_hidden() {
        let (_dir, v) = vault();
        v.write("a/b/Note.md", "# Hi").unwrap();
        v.write(".obsidian/app.json", "{}").unwrap();
        v.write("Root.md", "").unwrap();
        let paths: Vec<_> = v.scan("/").unwrap().into_iter().map(|e| e.path).collect();
        assert_eq!(paths, ["Root.md", "a", "a/b", "a/b/Note.md"]);
        assert_eq!(v.read("a/b/Note.md").unwrap(), "# Hi");
    }

    #[test]
    fn refuses_paths_outside_the_vault() {
        let (_dir, v) = vault();
        assert!(matches!(v.write("../escape.md", "x"), Err(VaultError::OutsideVault(_))));
        assert!(matches!(v.read("a/../../x"), Err(VaultError::OutsideVault(_))));
    }

    #[cfg(windows)]
    #[test]
    fn refuses_drive_prefixes_and_maps_watcher_paths() {
        let (dir, v) = vault();
        assert!(matches!(v.write("C:/escape.md", "x"), Err(VaultError::OutsideVault(_))));
        v.write("a/b.md", "x").unwrap();
        // Watchers report plain (non-verbatim) paths with backslashes.
        let reported = dir.path().join("a").join("b.md");
        assert_eq!(v.vault_path(&dunce::canonicalize(reported).unwrap()).as_deref(), Some("a/b.md"));
    }

    #[test]
    fn create_and_rename_detect_collisions() {
        let (_dir, v) = vault();
        v.create("One.md", "1").unwrap();
        v.create("Two.md", "2").unwrap();
        assert!(matches!(v.create("One.md", ""), Err(VaultError::AlreadyExists(_))));
        assert!(matches!(v.rename("One.md", "Two.md"), Err(VaultError::AlreadyExists(_))));
        v.rename("One.md", "sub/Three.md").unwrap();
        assert_eq!(v.read("sub/Three.md").unwrap(), "1");
        v.rename("Two.md", "two.md").unwrap();
    }

    #[test]
    fn trash_moves_instead_of_deleting() {
        let (_dir, v) = vault();
        v.write("Note.md", "a").unwrap();
        assert_eq!(v.trash("Note.md").unwrap(), ".trash/Note.md");
        v.write("Note.md", "b").unwrap();
        assert_eq!(v.trash("Note.md").unwrap(), ".trash/Note 1.md");
        assert_eq!(v.read(".trash/Note 1.md").unwrap(), "b");
        assert!(v.scan("/").unwrap().is_empty());
    }
}
