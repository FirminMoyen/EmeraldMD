use emerald_core::{EntryKind, FileEntry, VaultIndex};
use serde_json::Value;

#[test]
fn shared_fixture_cases() {
    let fixture: Value = serde_json::from_str(include_str!("../../../fixtures/link-resolution.json")).unwrap();
    let mut index = VaultIndex::new();
    for path in fixture["files"].as_array().unwrap() {
        index.upsert_entry(FileEntry {
            path: path.as_str().unwrap().to_owned(),
            kind: EntryKind::File,
            ctime: 0,
            mtime: 0,
            size: 0,
        });
    }
    for case in fixture["cases"].as_array().unwrap() {
        let (link, source) = (case["link"].as_str().unwrap(), case["source"].as_str().unwrap());
        assert_eq!(index.resolve(link, source), case["expected"].as_str(), "link {link:?} from {source:?}");
    }
}
