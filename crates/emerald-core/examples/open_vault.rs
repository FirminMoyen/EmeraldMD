//! Times opening a vault the way the app does: index, snapshot, and the
//! snapshot as JSON (what crosses to the webview).
//!
//!     cargo run --release -p emerald-core --example open_vault -- <folder> [snapshot.json]
//!
//! With a second argument, the snapshot JSON is also written there.

use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).expect("usage: open_vault <folder>");
    let start = Instant::now();
    let session = emerald_core::VaultSession::open(&path).expect("cannot open the vault");
    let indexed = start.elapsed();
    let snapshot = session.snapshot();
    let snapshotted = start.elapsed();
    let json = serde_json::to_string(&snapshot).expect("serializes");
    let serialized = start.elapsed();
    if let Some(out) = std::env::args().nth(2) {
        std::fs::write(out, &json).expect("cannot write the snapshot");
    }
    println!(
        "{} files: index {:.0} ms, snapshot {:.0} ms, JSON {:.0} ms ({:.1} MB)",
        snapshot.files.len(),
        indexed.as_secs_f64() * 1000.0,
        (snapshotted - indexed).as_secs_f64() * 1000.0,
        (serialized - snapshotted).as_secs_f64() * 1000.0,
        json.len() as f64 / 1e6
    );
}
