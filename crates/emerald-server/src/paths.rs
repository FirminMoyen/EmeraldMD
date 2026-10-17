//! The server's path policy, on top of `emerald_core`'s checks.
//!
//! `emerald_core` already refuses `..`, `.` and drive prefixes, and refuses
//! to create hidden paths. On the desktop it follows symbolic links, which is
//! what a local user expects. A server must not: a link in a vault folder
//! (planted by a sync tool, a git checkout, or a mistake) would hand every
//! token holder whatever it points at, including other vaults their token is
//! not scoped to. So here:
//!
//! - every path a client names must resolve, through any symbolic links, to
//!   a location inside the vault folder; for paths that do not exist yet,
//!   the deepest existing part must;
//! - listings (snapshot, manifest, search, event stream) leave out whatever
//!   lies behind a link that leads outside;
//! - hidden paths can be read only inside the config folder (`.obsidian`),
//!   which the app needs; `.trash`, `.git` and other dotfiles cannot.
//!
//! Hard links and races with someone changing the folder on the server at
//! the same moment are outside what a path check can catch; see docs/security.md.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use emerald_core::path::{is_hidden, normalize_path};
use emerald_core::vault::{Result as VaultResult, TRASH_FOLDER};
use emerald_core::{CONFIG_DIR, LinkSets, Vault, VaultError, VaultUpdate};

/// Refuses `path` if it, or the deepest existing part of it, resolves
/// outside the vault folder.
pub fn check_inside(vault: &Vault, path: &str) -> VaultResult<()> {
    let full = vault.full_path(path)?;
    let mut existing = full.as_path();
    while fs::symlink_metadata(existing).is_err() {
        // The root exists, so this ends there at the latest.
        existing = existing.parent().ok_or_else(|| VaultError::OutsideVault(path.to_owned()))?;
    }
    // A dangling link cannot be resolved; writing through it would create its target.
    let real = dunce::canonicalize(existing).map_err(|_| VaultError::OutsideVault(path.to_owned()))?;
    if !real.starts_with(vault.root()) {
        return Err(VaultError::OutsideVault(path.to_owned()));
    }
    Ok(())
}

/// For reads: [`check_inside`], and hidden paths only inside the config folder.
pub fn check_readable(vault: &Vault, path: &str) -> VaultResult<()> {
    // `..` and drive prefixes are refused before anything else.
    vault.full_path(path)?;
    let normalized = normalize_path(path);
    if is_hidden(&normalized) {
        if normalized.split('/').next() != Some(CONFIG_DIR) {
            // Answered like a missing file, so probing reveals nothing.
            return Err(VaultError::NotFound(normalized));
        }
        // Also refuses links that lead out of the config folder.
        vault.config_path(&normalized)?;
    }
    check_inside(vault, &normalized)
}

/// For writes: [`check_inside`] for every path the change touches.
pub fn check_writable(vault: &Vault, paths: &[&str]) -> VaultResult<()> {
    paths.iter().try_for_each(|path| check_inside(vault, path))
}

/// For trash: the item, and the `.trash` folder it is moved into.
pub fn check_trashable(vault: &Vault, path: &str) -> VaultResult<()> {
    check_writable(vault, &[path, TRASH_FOLDER])
}

/// The links among a set of vault paths, and their parents, that lead
/// outside the vault. Each distinct folder is looked at once.
pub struct Escapes {
    links: HashSet<String>,
}

impl Escapes {
    pub fn find<'a>(vault: &Vault, paths: impl IntoIterator<Item = &'a str>) -> Self {
        let root = vault.root();
        let mut seen: HashMap<String, bool> = HashMap::new();
        let mut links = HashSet::new();
        for path in paths {
            let mut end = 0;
            loop {
                end = path[end..].find('/').map_or(path.len(), |i| end + i);
                let prefix = &path[..end];
                let escapes = match seen.get(prefix) {
                    Some(&known) => known,
                    None => {
                        let found = escapes(root, prefix);
                        seen.insert(prefix.to_owned(), found);
                        found
                    }
                };
                if escapes {
                    links.insert(prefix.to_owned());
                    break;
                }
                if end == path.len() {
                    break;
                }
                end += 1;
            }
        }
        Self { links }
    }

    pub fn is_empty(&self) -> bool {
        self.links.is_empty()
    }

    /// Whether `path` is one of the links, or lies below one.
    pub fn hides(&self, path: &str) -> bool {
        if self.links.is_empty() {
            return false;
        }
        let mut end = 0;
        loop {
            end = path[end..].find('/').map_or(path.len(), |i| end + i);
            if self.links.contains(&path[..end]) {
                return true;
            }
            if end == path.len() {
                return false;
            }
            end += 1;
        }
    }

    /// Removes hidden entries, their metadata and their link sets.
    pub fn filter_update(&self, update: &mut VaultUpdate) {
        if self.is_empty() {
            return;
        }
        update.upserted.retain(|e| !self.hides(&e.path));
        update.metadata.retain(|path, _| !self.hides(path));
        update.links.retain(|path, _| !self.hides(path));
        for sets in update.links.values_mut() {
            self.filter_links(sets);
        }
    }

    pub fn filter_links(&self, sets: &mut LinkSets) {
        sets.resolved.retain(|path, _| !self.hides(path));
    }
}

/// Whether the vault path `prefix` is a symbolic link that resolves outside
/// `root`, or cannot be resolved at all.
fn escapes(root: &Path, prefix: &str) -> bool {
    let full = prefix.split('/').fold(root.to_path_buf(), |acc, segment| acc.join(segment));
    match fs::symlink_metadata(&full) {
        Ok(meta) if meta.file_type().is_symlink() => dunce::canonicalize(&full).map_or(true, |real| !real.starts_with(root)),
        _ => false,
    }
}

/// Every path an update mentions, for [`Escapes::find`].
pub fn update_paths(update: &VaultUpdate) -> impl Iterator<Item = &str> {
    update
        .upserted
        .iter()
        .map(|e| e.path.as_str())
        .chain(update.metadata.keys().map(String::as_str))
        .chain(update.links.keys().map(String::as_str))
        .chain(update.links.values().flat_map(|sets| sets.resolved.keys().map(String::as_str)))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn setup() -> (tempfile::TempDir, tempfile::TempDir, Vault) {
        let vault_dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = vault_dir.path();
        fs::create_dir_all(root.join("Inside/Deep")).unwrap();
        fs::write(root.join("Inside/Deep/Note.md"), "").unwrap();
        fs::write(outside.path().join("secret.md"), "").unwrap();
        symlink(outside.path(), root.join("Out")).unwrap();
        symlink(outside.path().join("secret.md"), root.join("secret.md")).unwrap();
        symlink(root.join("Inside"), root.join("Alias")).unwrap();
        symlink(outside.path().join("missing.md"), root.join("dangling.md")).unwrap();
        fs::create_dir(root.join(".obsidian")).unwrap();
        symlink(outside.path(), root.join(".obsidian/plugins")).unwrap();
        let vault = Vault::open(root).unwrap();
        (vault_dir, outside, vault)
    }

    #[test]
    fn paths_must_resolve_inside_the_vault() {
        let (_dir, _outside, vault) = setup();
        for ok in ["Inside/Deep/Note.md", "Inside/New/Sub.md", "Alias/Deep/Note.md", "Alias/Fresh.md", "New.md"] {
            check_inside(&vault, ok).unwrap_or_else(|e| panic!("{ok}: {e}"));
        }
        for bad in ["Out", "Out/secret.md", "Out/new/folder.md", "secret.md", "dangling.md", "../x.md", "a/../../x.md"] {
            assert!(matches!(check_inside(&vault, bad), Err(VaultError::OutsideVault(_))), "{bad}");
        }
        // Absolute paths are vault paths with a leading slash, not OS paths.
        assert_eq!(vault.full_path("/etc/passwd").unwrap(), vault.root().join("etc/passwd"));
    }

    #[test]
    fn hidden_paths_are_readable_only_in_the_config_folder() {
        let (_dir, _outside, vault) = setup();
        fs::write(vault.root().join(".obsidian/app.json"), "{}").unwrap();
        check_readable(&vault, ".obsidian/app.json").unwrap();
        for hidden in [".trash/Old.md", ".git/config", ".env", "Inside/.secret"] {
            assert!(matches!(check_readable(&vault, hidden), Err(VaultError::NotFound(_))), "{hidden}");
        }
        assert!(check_readable(&vault, ".obsidian/plugins/secret.md").is_err());
        assert!(check_trashable(&vault, "Inside/Deep/Note.md").is_ok());
        symlink(_outside.path(), vault.root().join(TRASH_FOLDER)).unwrap();
        assert!(check_trashable(&vault, "Inside/Deep/Note.md").is_err(), "a .trash link leading outside is refused");
    }

    #[test]
    fn escapes_hide_links_that_lead_outside_and_what_lies_below() {
        let (_dir, _outside, vault) = setup();
        let paths = ["Alias", "Alias/Deep/Note.md", "Inside", "Inside/Deep/Note.md", "Out", "Out/secret.md", "secret.md", "dangling.md"];
        let escapes = Escapes::find(&vault, paths);
        let hidden: Vec<&str> = paths.into_iter().filter(|p| escapes.hides(p)).collect();
        assert_eq!(hidden, ["Out", "Out/secret.md", "secret.md", "dangling.md"]);
        assert!(!escapes.hides("Outside.md"), "prefixes match whole segments");
        assert!(Escapes::find(&vault, ["Inside/Deep/Note.md"]).is_empty());
    }
}
