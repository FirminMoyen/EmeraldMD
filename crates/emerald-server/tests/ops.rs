//! Operations: config reload (as on SIGHUP) against a running server, and
//! the real binary end to end: `token add | list | revoke`, `serve`,
//! SIGHUP, `healthcheck` and SIGTERM.

mod common;

use common::{ALL, NOTES_ONLY, SPARE, TestServer, close_code, next_message, quick_hash, upserted_paths};
use emerald_server::config::{TokenConfig, VaultConfig};
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

const NEW: &str = "token-added-by-reload";

#[tokio::test]
async fn reload_swaps_tokens_and_vaults_without_a_restart() {
    let server = TestServer::start().await;
    // Verified (and cached) before the reload: revoking must still take effect.
    assert_eq!(server.status("/api/vaults", NOTES_ONLY).await, StatusCode::OK);
    let epoch = server.get("/api/vaults/notes/snapshot").send().await.unwrap().json::<Value>().await.unwrap()["epoch"].clone();
    let mut kept = server.events("notes", "", Some(ALL)).await.unwrap();
    let mut revoked = server.events("notes", "", Some(NOTES_ONLY)).await.unwrap();
    let mut removed = server.events("other", "", Some(ALL)).await.unwrap();

    let extra = tempfile::tempdir().unwrap();
    std::fs::write(extra.path().join("Extra.md"), "# Extra").unwrap();
    let mut config = server.config.clone();
    config.vaults.retain(|v| v.id != "other");
    config.vaults.push(VaultConfig { id: "extra".into(), path: extra.path().to_owned(), name: None });
    config.tokens.retain(|t| t.name != "notes");
    config.tokens.push(TokenConfig { name: "new".into(), hash: quick_hash(NEW), vaults: Some(vec!["extra".into()]), read_only: false });
    let summary = server.reload(config).await.unwrap();
    assert_eq!((summary.vaults_added, summary.vaults_removed, summary.tokens), (vec!["extra".to_owned()], vec!["other".to_owned()], 3));
    assert!(summary.needs_restart.is_empty());

    assert_eq!(server.status("/api/vaults", NOTES_ONLY).await, StatusCode::UNAUTHORIZED);
    let vaults: Value = server.http.get(server.url("/api/vaults")).bearer_auth(NEW).send().await.unwrap().json().await.unwrap();
    assert_eq!(vaults, json!([{ "id": "extra", "name": vaults[0]["name"] }]));
    let vaults: Value = server.get("/api/vaults").send().await.unwrap().json().await.unwrap();
    let ids: Vec<&str> = vaults.as_array().unwrap().iter().map(|v| v["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["extra", "notes"]);
    assert_eq!(server.status("/api/vaults/other/snapshot", ALL).await, StatusCode::NOT_FOUND);

    // Streams of the revoked token and of the removed vault are closed...
    assert_eq!(close_code(&mut revoked).await, Some(u16::from(CloseCode::Policy)));
    assert_eq!(close_code(&mut removed).await, Some(u16::from(CloseCode::Away)));
    // ...the others keep going, on the same vault: same epoch, same history.
    server.post("/api/vaults/notes/files", json!({ "path": "After reload.md" })).await;
    assert_eq!(upserted_paths(&next_message(&mut kept).await["update"]), ["After reload.md"]);
    let snapshot: Value = server.get("/api/vaults/notes/snapshot").send().await.unwrap().json().await.unwrap();
    assert_eq!((&snapshot["epoch"], snapshot["version"].as_u64()), (&epoch, Some(1)));
}

#[tokio::test]
async fn reload_keeps_tokens_verified_while_their_client_is_rate_limited() {
    let server = TestServer::start().await;
    assert_eq!(server.status("/api/vaults", ALL).await, StatusCode::OK);
    for _ in 0..10 {
        assert_eq!(server.status("/api/vaults", "wrong").await, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(server.status("/api/vaults", SPARE).await, StatusCode::TOO_MANY_REQUESTS);
    server.reload(server.config.clone()).await.unwrap();
    // Still the same token: no need to go through argon2 and the limit again.
    assert_eq!(server.status("/api/vaults", ALL).await, StatusCode::OK);
    assert_eq!(server.status("/api/vaults", SPARE).await, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn reload_reopens_changed_vaults_and_applies_origins() {
    let server = TestServer::start().await;
    let epoch = server.get("/api/vaults/notes/snapshot").send().await.unwrap().json::<Value>().await.unwrap()["epoch"].clone();
    let mut stream = server.events("notes", "", Some(ALL)).await.unwrap();
    let mut config = server.config.clone();
    config.vaults[0].name = Some("Renamed".into());
    config.allowed_origins.push("https://notes.example.com".into());
    config.max_body_mb += 1;
    let summary = server.reload(config).await.unwrap();
    assert_eq!(summary.vaults_reopened, ["notes"]);
    assert_eq!(summary.needs_restart, ["max_body_mb"]);
    assert_eq!(close_code(&mut stream).await, Some(u16::from(CloseCode::Away)));
    let snapshot: Value = server.get("/api/vaults/notes/snapshot").send().await.unwrap().json().await.unwrap();
    assert_eq!(snapshot["name"], "Renamed");
    assert_ne!(snapshot["epoch"], epoch, "clients must reload their snapshot");

    let preflight = server
        .http
        .request(reqwest::Method::OPTIONS, server.url("/api/vaults"))
        .header("Origin", "https://notes.example.com")
        .header("Access-Control-Request-Method", "GET")
        .send()
        .await
        .unwrap();
    assert_eq!(preflight.headers()["access-control-allow-origin"], "https://notes.example.com");
}

#[tokio::test]
async fn a_config_that_does_not_load_changes_nothing() {
    let server = TestServer::start().await;
    let mut missing_vault = server.config.clone();
    missing_vault.vaults.push(VaultConfig { id: "gone".into(), path: "/does/not/exist".into(), name: None });
    missing_vault.tokens.retain(|t| t.name != "all");
    assert!(server.reload(missing_vault).await.is_err());
    let mut bad_hash = server.config.clone();
    bad_hash.tokens[0].hash = "plain-text".into();
    assert!(server.reload(bad_hash).await.unwrap_err().contains("argon2"));
    assert_eq!(server.status("/api/vaults", ALL).await, StatusCode::OK);
    assert_eq!(server.status("/api/vaults/gone/snapshot", ALL).await, StatusCode::NOT_FOUND);

    // No tokens at all is a valid reload: it locks everyone out.
    let mut nobody = server.config.clone();
    nobody.tokens.clear();
    assert_eq!(server.reload(nobody).await.unwrap().tokens, 0);
    assert_eq!(server.status("/api/vaults", ALL).await, StatusCode::UNAUTHORIZED);
    assert_eq!(server.status("/api/vaults", SPARE).await, StatusCode::UNAUTHORIZED);
}

#[cfg(unix)]
mod binary {
    use std::io::{BufRead, BufReader};
    use std::path::Path;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    use super::*;

    const BIN: &str = env!("CARGO_BIN_EXE_emeraldmd-server");

    fn command(config: &Path) -> Command {
        let mut command = Command::new(BIN);
        command.arg("--config").arg(config);
        for (key, _) in std::env::vars() {
            if key.starts_with("EMERALDMD_") {
                command.env_remove(key);
            }
        }
        command
    }

    fn run(config: &Path, args: &[&str]) -> (bool, String, String) {
        let output = command(config).args(args).output().unwrap();
        (output.status.success(), String::from_utf8(output.stdout).unwrap(), String::from_utf8(output.stderr).unwrap())
    }

    fn signal(child: &Child, name: &str) {
        assert!(Command::new("kill").arg(format!("-{name}")).arg(child.id().to_string()).status().unwrap().success());
    }

    /// Polls until the token gets `expected` (the reload runs asynchronously).
    async fn wait_for(http: &reqwest::Client, base: &str, token: &str, expected: StatusCode) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let status = http.get(format!("{base}/api/vaults")).bearer_auth(token).send().await.unwrap().status();
            if status == expected {
                return;
            }
            assert!(Instant::now() < deadline, "still {status}, expected {expected}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn token_commands_sighup_and_healthcheck() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("notes");
        std::fs::create_dir(&vault).unwrap();
        std::fs::write(vault.join("Home.md"), "# Home").unwrap();
        let config = dir.path().join("emeraldmd-server.toml");
        let text = format!("# Test server\nbind = \"127.0.0.1:0\"\n\n[[vaults]]\nid = \"notes\"\npath = {:?}\n", vault.display().to_string());
        std::fs::write(&config, &text).unwrap();

        let (ok, _, err) = run(&config, &["serve"]);
        assert!(!ok && err.contains("no tokens are configured"), "{err}");
        let (ok, laptop, err) = run(&config, &["token", "add", "laptop"]);
        assert!(ok, "{err}");
        let laptop = laptop.trim().to_owned();
        assert!(laptop.starts_with("emd_") && err.contains("shown only this once"), "{err}");
        assert!(std::fs::read_to_string(&config).unwrap().starts_with(&text), "the file is extended, not rewritten");

        let mut child = command(&config).arg("serve").env("RUST_LOG", "info").stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let (lines_tx, lines) = std::sync::mpsc::channel();
        let stdout = child.stdout.take().unwrap();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = lines_tx.send(line);
            }
        });
        let address = loop {
            let line = lines.recv_timeout(Duration::from_secs(60)).expect("server did not start");
            if let Some(address) = line.split("listening on http://").nth(1) {
                break address.trim().to_owned();
            }
        };
        let base = format!("http://{address}");
        let http = reqwest::Client::new();

        let (ok, out, _) = run(&config, &["healthcheck", &address]);
        assert!(ok && out.trim() == "ok");
        assert!(!run(&config, &["healthcheck", "127.0.0.1:9"]).0, "nothing listens on port 9");
        wait_for(&http, &base, &laptop, StatusCode::OK).await;

        // Added while running: unknown until SIGHUP.
        let (ok, phone, err) = run(&config, &["token", "add", "phone", "--vault", "notes"]);
        assert!(ok, "{err}");
        let phone = phone.trim().to_owned();
        assert_eq!(http.get(format!("{base}/api/vaults")).bearer_auth(&phone).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
        signal(&child, "HUP");
        wait_for(&http, &base, &phone, StatusCode::OK).await;

        let (ok, list, _) = run(&config, &["token", "list"]);
        assert!(ok);
        assert_eq!(list.lines().collect::<Vec<_>>(), ["NAME    VAULTS", "laptop  all", "phone   notes"]);
        assert!(!list.contains("argon2"));

        let (ok, _, err) = run(&config, &["token", "revoke", "laptop"]);
        assert!(ok, "{err}");
        signal(&child, "HUP");
        wait_for(&http, &base, &laptop, StatusCode::UNAUTHORIZED).await;
        wait_for(&http, &base, &phone, StatusCode::OK).await;

        // A broken config is logged and ignored.
        std::fs::write(&config, "this is not toml").unwrap();
        signal(&child, "HUP");
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let line = lines.recv_timeout(Duration::from_secs(20)).expect("no reload error logged");
            if line.contains("reload failed") {
                break;
            }
            assert!(Instant::now() < deadline);
        }
        wait_for(&http, &base, &phone, StatusCode::OK).await;

        signal(&child, "TERM");
        let status = child.wait().unwrap();
        assert!(status.success(), "{status}");
    }
}
