//! Two devices sync through a real server over HTTP with `emerald_sync::HttpRemote`.

use std::fs;
use std::path::Path;

use argon2::password_hash::PasswordHasher;
use argon2::{Algorithm, Argon2, Params, Version};
use emerald_core::VaultSession;
use emerald_server::Server;
use emerald_server::config::{Config, TokenConfig, VaultConfig};
use emerald_sync::{Action, HttpRemote, SyncReport, sync_once};

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

#[tokio::test(flavor = "multi_thread")]
async fn devices_sync_through_the_server() {
    let server_dir = tempfile::tempdir().unwrap();
    write(server_dir.path(), "Server note.md", b"# On the server\n");
    let config = Config {
        vaults: vec![VaultConfig { id: "notes".into(), path: server_dir.path().to_owned(), name: None }],
        tokens: vec![TokenConfig { name: "test".into(), hash: quick_hash(TOKEN), vaults: None }],
        ..Config::default()
    };
    let server = Server::new(&config).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(server.serve(listener, async {
        let _ = stopped.await;
    }));

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
        tokens: vec![TokenConfig { name: "test".into(), hash: quick_hash(TOKEN), vaults: None }],
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
