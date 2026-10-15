use std::fs;

use emerald_core::VaultSession;

fn vault_with(files: &[(&str, &str)]) -> (tempfile::TempDir, VaultSession) {
    let dir = tempfile::tempdir().unwrap();
    for (path, text) in files {
        let full = dir.path().join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, text).unwrap();
    }
    let session = VaultSession::open(dir.path()).unwrap();
    (dir, session)
}

#[test]
fn open_indexes_links_and_backlinks() {
    let (_dir, s) = vault_with(&[
        ("Home.md", "[[Projects/Plan]] [[Missing]] [[Plan#Goals]]"),
        ("Projects/Plan.md", "back to [[Home]]"),
        (".obsidian/app.json", "{}"),
    ]);
    let snap = s.snapshot();
    let paths: Vec<_> = snap.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["Home.md", "Projects", "Projects/Plan.md"]);
    let home = &snap.links["Home.md"];
    assert_eq!(home.resolved["Projects/Plan.md"], 2);
    assert_eq!(home.unresolved["Missing"], 1);
    assert_eq!(s.index().backlinks("Home.md"), ["Projects/Plan.md"]);
}

#[test]
fn creating_a_note_resolves_pending_links() {
    let (_dir, mut s) = vault_with(&[("Home.md", "[[Later]]")]);
    let update = s.create("Inbox/Later.md", "").unwrap();
    let upserted: Vec<_> = update.upserted.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(upserted, ["Inbox", "Inbox/Later.md"]);
    assert_eq!(update.links["Home.md"].resolved["Inbox/Later.md"], 1);
    assert!(update.links["Home.md"].unresolved.is_empty());
}

#[test]
fn editing_reports_metadata_and_changed_links_only() {
    let (_dir, mut s) = vault_with(&[("A.md", "[[B]]"), ("B.md", "")]);
    let update = s.write("A.md", "[[B]] #tag").unwrap();
    assert_eq!(update.metadata["A.md"].tags[0].tag, "#tag");
    assert!(update.links.is_empty(), "links did not change");
    let update = s.write("A.md", "nothing").unwrap();
    assert!(update.links["A.md"].resolved.is_empty());
}

#[test]
fn renaming_a_folder_moves_children_and_relinks() {
    let (_dir, mut s) = vault_with(&[("Home.md", "[[Old/Note]]"), ("Old/Note.md", "x")]);
    let update = s.rename("Old", "New").unwrap();
    assert_eq!(update.renamed, [("Old".to_owned(), "New".to_owned())]);
    assert!(s.index().entry("New/Note.md").is_some());
    assert!(s.index().metadata("New/Note.md").is_some());
    assert_eq!(update.links["Home.md"].unresolved["Old/Note"], 1);
}

#[test]
fn trash_removes_from_index_but_keeps_file() {
    let (dir, mut s) = vault_with(&[("Home.md", "[[Gone]]"), ("Gone.md", "bye")]);
    let update = s.trash("Gone.md").unwrap();
    assert_eq!(update.removed, ["Gone.md"]);
    assert_eq!(update.links["Home.md"].unresolved["Gone"], 1);
    assert_eq!(fs::read_to_string(dir.path().join(".trash/Gone.md")).unwrap(), "bye");
}

#[test]
fn sync_path_picks_up_external_changes_and_ignores_own_writes() {
    let (dir, mut s) = vault_with(&[("A.md", "one")]);
    s.write("A.md", "two").unwrap();
    assert!(s.sync_path("A.md").unwrap().is_empty(), "own write is not a change");

    fs::write(dir.path().join("A.md"), "three [[B]] and more").unwrap();
    let update = s.sync_path("A.md").unwrap();
    assert_eq!(update.metadata["A.md"].links[0].link, "B");

    fs::create_dir_all(dir.path().join("Dropped/In")).unwrap();
    fs::write(dir.path().join("Dropped/In/B.md"), "").unwrap();
    let update = s.sync_path("Dropped").unwrap();
    let upserted: Vec<_> = update.upserted.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(upserted, ["Dropped", "Dropped/In", "Dropped/In/B.md"]);
    assert_eq!(update.links["A.md"].resolved["Dropped/In/B.md"], 1);

    fs::remove_file(dir.path().join("A.md")).unwrap();
    assert_eq!(s.sync_path("A.md").unwrap().removed, ["A.md"]);
    assert!(s.sync_path(".obsidian/workspace.json").unwrap().is_empty());
}

#[test]
fn refuses_hidden_and_escaping_paths() {
    let (_dir, mut s) = vault_with(&[]);
    assert!(s.create(".obsidian/x.md", "").is_err());
    assert!(s.create("../x.md", "").is_err());
}
