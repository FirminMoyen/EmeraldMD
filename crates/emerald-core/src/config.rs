//! The vault's config folder (`.obsidian`): app settings, community plugins
//! and their `data.json`, themes and snippets.
//!
//! [`crate::VaultSession`] refuses hidden paths, so notes and the index never
//! see this folder. These methods are the explicit way in: they accept only
//! vault paths inside the config folder, and refuse paths that would leave it
//! through `..` or a symbolic link.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::path::normalize_path;
use crate::vault::{FileEntry, Result, Vault, VaultError};

/// Name of the config folder at the vault root, as Obsidian names it.
pub const CONFIG_DIR: &str = ".obsidian";

/// Contents of a config folder, as vault paths.
#[derive(Serialize, Debug, Default, PartialEq, Eq)]
pub struct ConfigListing {
    pub files: Vec<String>,
    pub folders: Vec<String>,
}

fn exists_no_follow(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

impl Vault {
    /// Absolute OS path for a vault path inside the config folder.
    ///
    /// `path` must be the config folder itself or a path below it. If the
    /// config folder exists, the deepest existing part of `path` must
    /// resolve (following symbolic links) to a location inside it.
    pub fn config_path(&self, path: &str) -> Result<PathBuf> {
        let normalized = normalize_path(path);
        if normalized.split('/').next() != Some(CONFIG_DIR) {
            return Err(VaultError::NotConfigPath(path.to_owned()));
        }
        let full = self.full_path(&normalized)?;
        let config_root = self.root().join(CONFIG_DIR);
        if exists_no_follow(&config_root) {
            let canonical_root = fs::canonicalize(&config_root)?;
            let mut existing = full.as_path();
            while !exists_no_follow(existing) {
                existing = existing.parent().ok_or_else(|| VaultError::NotConfigPath(path.to_owned()))?;
            }
            // A dangling symlink cannot be canonicalized; refuse it rather than write through it.
            let canonical = fs::canonicalize(existing).map_err(|_| VaultError::NotConfigPath(path.to_owned()))?;
            if !canonical.starts_with(&canonical_root) {
                return Err(VaultError::NotConfigPath(path.to_owned()));
            }
        }
        Ok(full)
    }

    /// Reads a config file. `Ok(None)` if it does not exist.
    pub fn read_config(&self, path: &str) -> Result<Option<String>> {
        match fs::read_to_string(self.config_path(path)?) {
            Ok(text) => Ok(Some(text)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    /// Writes a config file, creating parent folders as needed.
    pub fn write_config(&self, path: &str, data: &str) -> Result<()> {
        if normalize_path(path) == CONFIG_DIR {
            return Err(VaultError::NotConfigPath(path.to_owned()));
        }
        let full = self.config_path(path)?;
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)?;
        }
        // Re-check now that the parents exist: they could be symlinks created meanwhile.
        self.config_path(path)?;
        fs::write(full, data)?;
        Ok(())
    }

    /// Creates a folder (and its parents) in the config folder.
    pub fn create_config_folder(&self, path: &str) -> Result<()> {
        fs::create_dir_all(self.config_path(path)?)?;
        Ok(())
    }

    /// Lists a config folder, including dotfiles, sorted by name.
    pub fn list_config(&self, path: &str) -> Result<ConfigListing> {
        let folder = normalize_path(path);
        let full = self.config_path(&folder)?;
        let mut listing = ConfigListing::default();
        let read = match fs::read_dir(&full) {
            Ok(read) => read,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Err(VaultError::NotFound(folder)),
            Err(err) => return Err(err.into()),
        };
        let mut entries: Vec<_> = read.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let child = format!("{folder}/{}", entry.file_name().to_string_lossy());
            // Entries that resolve outside the config folder are left out.
            if self.config_path(&child).is_err() {
                continue;
            }
            match fs::metadata(entry.path()) {
                Ok(meta) if meta.is_dir() => listing.folders.push(child),
                Ok(_) => listing.files.push(child),
                Err(_) => {}
            }
        }
        Ok(listing)
    }

    /// Size and times of a config file or folder. `Ok(None)` if it does not exist.
    pub fn config_entry(&self, path: &str) -> Result<Option<FileEntry>> {
        self.config_path(path)?;
        self.entry(path)
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
    fn reads_writes_and_lists_config_files() {
        let (_dir, v) = vault();
        assert_eq!(v.read_config(".obsidian/community-plugins.json").unwrap(), None);
        v.write_config(".obsidian/plugins/demo/data.json", "{}").unwrap();
        v.write_config(".obsidian/community-plugins.json", "[\"demo\"]").unwrap();
        assert_eq!(v.read_config(".obsidian/plugins/demo/data.json").unwrap().as_deref(), Some("{}"));
        let root = v.list_config(".obsidian").unwrap();
        assert_eq!(root.files, [".obsidian/community-plugins.json"]);
        assert_eq!(root.folders, [".obsidian/plugins"]);
        assert_eq!(v.list_config(".obsidian/plugins").unwrap().folders, [".obsidian/plugins/demo"]);
        assert!(v.config_entry(".obsidian/plugins/demo").unwrap().is_some());
        assert!(v.config_entry(".obsidian/missing.json").unwrap().is_none());
        // Config files stay out of the vault's file list.
        assert!(v.scan("/").unwrap().is_empty());
    }

    #[test]
    fn refuses_paths_outside_the_config_folder() {
        let (_dir, v) = vault();
        for path in ["Note.md", ".trash/x.md", ".obsidian/../Note.md", "../.obsidian/x", ".obsidianx/a", "a/.obsidian/b"] {
            assert!(v.write_config(path, "x").is_err(), "{path} should be refused");
            assert!(v.read_config(path).is_err(), "{path} should be refused");
        }
        assert!(v.write_config(".obsidian", "x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_that_leave_the_config_folder() {
        let (dir, v) = vault();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        fs::create_dir_all(dir.path().join(".obsidian/plugins")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join(".obsidian/plugins/evil")).unwrap();
        assert!(v.read_config(".obsidian/plugins/evil/secret.txt").is_err());
        assert!(v.write_config(".obsidian/plugins/evil/new.txt", "x").is_err());
        assert!(!outside.path().join("new.txt").exists());
        assert!(v.list_config(".obsidian/plugins").unwrap().folders.is_empty());
    }
}
