//! Two devices sync through a real server over HTTP with `emerald_sync::HttpRemote`.

use std::fs;
use std::path::Path;

use argon2::password_hash::PasswordHasher;
use argon2::{Algorithm, Argon2, Params, Version};
use emerald_core::VaultSession;
use emerald_server::Server;
use emerald_server::config::{Config, TokenConfig, VaultConfig};
use emerald_sync::{Action, HttpRemote, SyncOptions, SyncReport, sync_once, sync_once_with};

const TOKEN: &str = "sync-test-token";

fn quick_hash(token: &str) -> String {
    let params = Params::new(8, 1, 1, None).unwrap();
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hash_password(token.as_bytes()).unwrap().to_string()
}

fn write(root: &Path, path: &str, data: &[u8]) {
    let full = root.join(path);
    fs::create_dir_all(full.parent().unwrap()).unwrap();
    fs::write(full, data).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
}

fn sync(base: &str, root: &Path, device: &str) -> SyncReport {
    let mut session = VaultSession::open(root).unwrap();
    let mut remote = HttpRemote::new(base, "notes", TOKEN, device).unwrap();
    sync_once(&mut session, &mut remote, device).unwrap()
}

fn sync_settings(base: &str, root: &Path, device: &str, config: bool) -> SyncReport {
    let mut session = VaultSession::open(root).unwrap();
    let mut remote = HttpRemote::new(base, "notes", TOKEN, device).unwrap().with_config(config);
    sync_once_with(&mut session, &mut remote, device, SyncOptions { config, ..SyncOptions::default() }).unwrap()
}

/// A server for `dir` on a free port: its address, and a sender that stops it.
async fn start(dir: &Path) -> (String, tokio::sync::oneshot::Sender<()>) {
    let config = Config {
        vaults: vec![VaultConfig { id: "notes".into(), path: dir.to_owned(), name: None }],
        tokens: vec![TokenConfig { name: "test".into(), hash: quick_hash(TOKEN), vaults: None, read_only: false }],
        ..Config::default()
    };
    let server = Server::new(&config).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(server.serve(listener, async {
        let _ = stopped.await;
    }));
    (base, stop)
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_sync_between_devices_that_opt_in() {
    let server_dir = tempfile::tempdir().unwrap();
    let (base, stop) = start(server_dir.path()).await;
    let server_root = server_dir.path().to_owned();
    tokio::task::spawn_blocking(move || {
        let laptop = tempfile::tempdir().unwrap();
        let phone = tempfile::tempdir().unwrap();
        write(laptop.path(), "Note.md", b"text\n");
        write(laptop.path(), ".obsidian/app.json", b"{\"vimMode\":true}");
        write(laptop.path(), ".obsidian/snippets/wide.css", b".a {}");
        write(laptop.path(), ".obsidian/plugins/x/icon.bin", &[0, 159, 255, 1]);
        write(laptop.path(), ".obsidian/workspace.json", b"{\"layout\":1}");

        let report = sync_settings(&base, laptop.path(), "Laptop", true);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!(fs::read(server_root.join(".obsidian/plugins/x/icon.bin")).unwrap(), [0, 159, 255, 1]);
        assert!(server_root.join(".obsidian/snippets/wide.css").exists());
        // The window layout stays on each device.
        assert!(!server_root.join(".obsidian/workspace.json").exists());

        // A device that does not opt in gets notes only.
        sync_settings(&base, phone.path(), "Phone", false);
        assert!(phone.path().join("Note.md").exists());
        assert!(!phone.path().join(".obsidian").exists());
        sync_settings(&base, phone.path(), "Phone", true);
        assert_eq!(fs::read_to_string(phone.path().join(".obsidian/app.json")).unwrap(), "{\"vimMode\":true}");

        // Deletions travel through the server's trash.
        fs::remove_file(phone.path().join(".obsidian/snippets/wide.css")).unwrap();
        sync_settings(&base, phone.path(), "Phone", true);
        assert!(!server_root.join(".obsidian/snippets/wide.css").exists());
        let report = sync_settings(&base, laptop.path(), "Laptop", true);
        assert_eq!(report.done, [Action::DeleteLocal(".obsidian/snippets/wide.css".into())]);
        assert!(!laptop.path().join(".obsidian/snippets/wide.css").exists());

        // Changed on both sides: the server's version stays, the local one goes to .trash.
        write(phone.path(), ".obsidian/app.json", b"{\"vimMode\":false}");
        write(laptop.path(), ".obsidian/app.json", b"{\"spellcheck\":true}");
        sync_settings(&base, phone.path(), "Phone", true);
        let report = sync_settings(&base, laptop.path(), "Laptop", true);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!(fs::read_to_string(laptop.path().join(".obsidian/app.json")).unwrap(), "{\"vimMode\":false}");
        let kept = report.conflict_copies.first().expect("the local version is kept");
        assert!(kept.starts_with(".trash/app (conflict "), "{kept}");
        assert_eq!(fs::read_to_string(laptop.path().join(kept)).unwrap(), "{\"spellcheck\":true}");

        // Turning the option off leaves settings alone on both sides.
        let report = sync_settings(&base, laptop.path(), "Laptop", false);
        assert!(report.done.is_empty(), "{:?}", report.done);
        assert!(laptop.path().join(".obsidian/app.json").exists());
        assert!(server_root.join(".obsidian/app.json").exists());
    })
    .await
    .unwrap();
    let _ = stop.send(());
}

#[tokio::test(flavor = "multi_thread")]
async fn devices_sync_through_the_server() {
    let server_dir = tempfile::tempdir().unwrap();
    write(server_dir.path(), "Server note.md", b"# On the server\n");
    let (base, stop) = start(server_dir.path()).await;

    let server_root = server_dir.path().to_owned();
    // The sync client is blocking, as it runs on a worker thread in the app.
    tokio::task::spawn_blocking(move || {
        let laptop = tempfile::tempdir().unwrap();
        let phone = tempfile::tempdir().unwrap();
        write(laptop.path(), "Laptop/Ideas.md", b"line one\n\nline two\n");
        write(laptop.path(), "Assets/photo.png", &[0x89, b'P', b'N', b'G', 0, 1, 2, 255]);

        let report = sync(&base, laptop.path(), "Laptop");
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!(fs::read(server_root.join("Assets/photo.png")).unwrap(), [0x89, b'P', b'N', b'G', 0, 1, 2, 255]);
        assert!(laptop.path().join("Server note.md").exists());

        let report = sync(&base, phone.path(), "Phone");
        assert_eq!(report.done.len(), 3);
        assert_eq!(fs::read_to_string(phone.path().join("Laptop/Ideas.md")).unwrap(), "line one\n\nline two\n");

        // Edits to different lines on two devices merge through the server.
        write(laptop.path(), "Laptop/Ideas.md", b"line one (laptop)\n\nline two\n");
        write(phone.path(), "Laptop/Ideas.md", b"line one\n\nline two (phone)\n");
        sync(&base, phone.path(), "Phone");
        let report = sync(&base, laptop.path(), "Laptop");
        assert_eq!(report.done, [Action::Merge("Laptop/Ideas.md".into())]);
        assert!(report.conflict_copies.is_empty(), "{:?}", report.conflict_copies);
        let merged = "line one (laptop)\n\nline two (phone)\n";
        assert_eq!(fs::read_to_string(server_root.join("Laptop/Ideas.md")).unwrap(), merged);
        sync(&base, phone.path(), "Phone");
        assert_eq!(fs::read_to_string(phone.path().join("Laptop/Ideas.md")).unwrap(), merged);

        // A deletion reaches the server's trash, then the other device.
        fs::remove_file(phone.path().join("Server note.md")).unwrap();
        sync(&base, phone.path(), "Phone");
        assert!(server_root.join(".trash/Server note.md").exists());
        let report = sync(&base, laptop.path(), "Laptop");
        assert_eq!(report.done, [Action::DeleteLocal("Server note.md".into())]);

        let wrong = HttpRemote::new(&base, "notes", "wrong-token", "x").unwrap();
        let mut session = VaultSession::open(laptop.path()).unwrap();
        let err = sync_once(&mut session, &mut { wrong }, "x").unwrap_err();
        assert!(err.to_string().contains("401"), "{err}");
    })
    .await
    .unwrap();
    let _ = stop.send(());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_event_stream_announces_other_devices_changes() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    let server_dir = tempfile::tempdir().unwrap();
    let config = Config {
        vaults: vec![VaultConfig { id: "notes".into(), path: server_dir.path().to_owned(), name: None }],
        tokens: vec![TokenConfig { name: "test".into(), hash: quick_hash(TOKEN), vaults: None, read_only: false }],
        ..Config::default()
    };
    let server = Server::new(&config).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (stop_server, stopped) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(server.serve(listener, async {
        let _ = stopped.await;
    }));

    tokio::task::spawn_blocking(move || {
        let (changed, notices) = mpsc::channel::<()>();
        let stop = Arc::new(AtomicBool::new(false));
        let watcher = {
            let (base, stop) = (base.clone(), stop.clone());
            std::thread::spawn(move || {
                emerald_sync::watch_changes(
                    || HttpRemote::new(&base, "notes", TOKEN, "Laptop"),
                    &stop,
                    || changed.send(()).unwrap(),
                    |err| panic!("event stream failed: {err}"),
                );
            })
        };
        // Once on connecting, for anything missed while offline.
        notices.recv_timeout(Duration::from_secs(5)).expect("a notice on connecting");

        let phone = tempfile::tempdir().unwrap();
        write(phone.path(), "From the phone.md", b"hello\n");
        sync(&base, phone.path(), "Phone");
        notices.recv_timeout(Duration::from_secs(5)).expect("a notice for the phone's change");
        while notices.recv_timeout(Duration::from_millis(300)).is_ok() {}

        // The laptop's own changes are not echoed back.
        let laptop = tempfile::tempdir().unwrap();
        write(laptop.path(), "From the laptop.md", b"hi\n");
        sync(&base, laptop.path(), "Laptop");
        assert!(notices.recv_timeout(Duration::from_secs(1)).is_err(), "own change announced");

        stop.store(true, Ordering::SeqCst);
        watcher.join().unwrap();
    })
    .await
    .unwrap();
    let _ = stop_server.send(());
}
