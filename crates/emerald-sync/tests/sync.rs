//! Two real vaults synced through a third one standing in for the server.

use std::fs;
use std::path::Path;

use emerald_core::VaultSession;
use emerald_sync::{Action, HashCache, Manifest, Remote, SyncError, sync_once};

/// A "server" that is just another vault on disk.
struct VaultRemote<'a>(&'a mut VaultSession);

impl Remote for VaultRemote<'_> {
    fn manifest(&mut self) -> Result<Manifest, SyncError> {
        Ok(HashCache::default().scan(self.0.vault())?)
    }

    fn read(&mut self, path: &str) -> Result<Vec<u8>, SyncError> {
        Ok(self.0.vault().read_bytes(path)?)
    }

    fn write(&mut self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        self.0.write_bytes(path, data)?;
        Ok(())
    }

    fn trash(&mut self, path: &str) -> Result<(), SyncError> {
        self.0.trash(path)?;
        Ok(())
    }
}

struct World {
    _dirs: Vec<tempfile::TempDir>,
    server: VaultSession,
    laptop: VaultSession,
    phone: VaultSession,
}

fn write(s: &VaultSession, path: &str, text: &str) {
    let full = s.vault().root().join(path);
    fs::create_dir_all(full.parent().unwrap()).unwrap();
    fs::write(full, text).unwrap();
    // Make sure the next scan sees a different mtime even on coarse clocks.
    std::thread::sleep(std::time::Duration::from_millis(5));
}

fn read(s: &VaultSession, path: &str) -> Option<String> {
    fs::read_to_string(s.vault().root().join(path)).ok()
}

fn exists(root: &Path, path: &str) -> bool {
    root.join(path).exists()
}

impl World {
    fn new() -> Self {
        let dirs: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
        let open = |i: usize| VaultSession::open(dirs[i].path()).unwrap();
        Self { server: open(0), laptop: open(1), phone: open(2), _dirs: dirs }
    }

    fn sync_laptop(&mut self) -> emerald_sync::SyncReport {
        sync_once(&mut self.laptop, &mut VaultRemote(&mut self.server), "Laptop").unwrap()
    }

    fn sync_phone(&mut self) -> emerald_sync::SyncReport {
        sync_once(&mut self.phone, &mut VaultRemote(&mut self.server), "Phone").unwrap()
    }
}

#[test]
fn first_sync_combines_both_sides_and_second_sync_is_quiet() {
    let mut w = World::new();
    write(&w.laptop, "Notes/Laptop.md", "from laptop");
    write(&w.server, "Server.md", "from server");
    write(&w.laptop, ".obsidian/workspace.json", "{}");
    let report = w.sync_laptop();
    assert_eq!(report.done, [Action::Upload("Notes/Laptop.md".into()), Action::Download("Server.md".into())]);
    assert_eq!(read(&w.server, "Notes/Laptop.md").as_deref(), Some("from laptop"));
    assert_eq!(read(&w.laptop, "Server.md").as_deref(), Some("from server"));
    assert!(report.update.metadata.contains_key("Server.md"), "the UI mirror learns about downloads");
    assert!(!exists(w.server.vault().root(), ".obsidian/workspace.json"), "config is not synced yet");
    assert!(w.sync_laptop().done.is_empty());
}

#[test]
fn edits_travel_between_devices() {
    let mut w = World::new();
    write(&w.laptop, "Plan.md", "v1");
    w.sync_laptop();
    w.sync_phone();
    assert_eq!(read(&w.phone, "Plan.md").as_deref(), Some("v1"));

    write(&w.phone, "Plan.md", "v2 from phone");
    w.sync_phone();
    let report = w.sync_laptop();
    assert_eq!(report.done, [Action::Download("Plan.md".into())]);
    assert_eq!(read(&w.laptop, "Plan.md").as_deref(), Some("v2 from phone"));
}

#[test]
fn edits_to_different_lines_merge() {
    let mut w = World::new();
    write(&w.laptop, "Doc.md", "# Doc\n\nintro\n\nmiddle\n\nend\n");
    w.sync_laptop();
    w.sync_phone();
    write(&w.laptop, "Doc.md", "# Doc\n\nintro (laptop)\n\nmiddle\n\nend\n");
    write(&w.phone, "Doc.md", "# Doc\n\nintro\n\nmiddle\n\nend (phone)\n");
    w.sync_phone();
    let report = w.sync_laptop();
    assert_eq!(report.done, [Action::Merge("Doc.md".into())]);
    let merged = "# Doc\n\nintro (laptop)\n\nmiddle\n\nend (phone)\n";
    assert_eq!(read(&w.laptop, "Doc.md").as_deref(), Some(merged));
    assert_eq!(read(&w.server, "Doc.md").as_deref(), Some(merged));
    w.sync_phone();
    assert_eq!(read(&w.phone, "Doc.md").as_deref(), Some(merged));
}

#[test]
fn clashing_edits_keep_both_versions() {
    let mut w = World::new();
    write(&w.laptop, "Doc.md", "line\n");
    w.sync_laptop();
    w.sync_phone();
    write(&w.laptop, "Doc.md", "laptop line\n");
    write(&w.phone, "Doc.md", "phone line\n");
    w.sync_phone();
    let report = w.sync_laptop();
    assert_eq!(report.done, [Action::Merge("Doc.md".into())]);
    let copy = &report.conflict_copies[0];
    assert!(copy.starts_with("Doc (conflict ") && copy.ends_with(" Laptop).md"), "{copy}");
    assert_eq!(read(&w.laptop, "Doc.md").as_deref(), Some("phone line\n"));
    assert_eq!(read(&w.laptop, copy).as_deref(), Some("laptop line\n"));
    assert_eq!(read(&w.server, copy).as_deref(), Some("laptop line\n"));
    assert!(w.sync_laptop().done.is_empty());
}

#[test]
fn binary_conflicts_and_deletions() {
    let mut w = World::new();
    write(&w.laptop, "img.png", "png-1");
    write(&w.laptop, "Old.md", "old");
    write(&w.laptop, "Kept.md", "kept");
    w.sync_laptop();
    w.sync_phone();

    write(&w.laptop, "img.png", "png-laptop");
    write(&w.phone, "img.png", "png-phone");
    fs::remove_file(w.phone.vault().root().join("Old.md")).unwrap();
    // Deleted on the laptop while edited on the phone: the edit wins.
    fs::remove_file(w.laptop.vault().root().join("Kept.md")).unwrap();
    write(&w.phone, "Kept.md", "kept, edited");
    w.sync_phone();
    assert!(exists(w.server.vault().root(), ".trash/Old.md"), "deletions go to the server's trash");

    let report = w.sync_laptop();
    assert_eq!(
        report.done,
        [
            Action::Download("Kept.md".into()),
            Action::DeleteLocal("Old.md".into()),
            Action::ConflictCopy("img.png".into()),
        ]
    );
    assert_eq!(read(&w.laptop, "Kept.md").as_deref(), Some("kept, edited"));
    assert!(!exists(w.laptop.vault().root(), "Old.md"));
    assert!(exists(w.laptop.vault().root(), ".trash/Old.md"));
    assert_eq!(read(&w.laptop, "img.png").as_deref(), Some("png-phone"));
    assert_eq!(read(&w.laptop, &report.conflict_copies[0]).as_deref(), Some("png-laptop"));
}

#[test]
fn state_survives_reopening_the_vault() {
    let mut w = World::new();
    write(&w.laptop, "A.md", "a");
    w.sync_laptop();
    let root = w.laptop.vault().root().to_path_buf();
    w.laptop = VaultSession::open(&root).unwrap();
    assert!(exists(&root, emerald_sync::engine::STATE_PATH));
    assert!(w.sync_laptop().done.is_empty());
}
