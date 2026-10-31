//! Starts the server on a random port against temporary vaults and talks to
//! it over HTTP and WebSocket, like the app does.

use std::path::Path;
use std::time::Duration;

use argon2::password_hash::PasswordHasher;
use argon2::{Algorithm, Argon2, Params, Version};
use emerald_server::Server;
use emerald_server::config::{Config, TokenConfig, VaultConfig};
use futures_util::StreamExt;
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const ALL: &str = "token-for-every-vault";
const NOTES_ONLY: &str = "token-for-notes";

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Cheap argon2 parameters keep the tests fast; the server reads them from the hash.
fn quick_hash(token: &str) -> String {
    let params = Params::new(8, 1, 1, None).unwrap();
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hash_password(token.as_bytes()).unwrap().to_string()
}

struct TestServer {
    base: String,
    http: reqwest::Client,
    notes: tempfile::TempDir,
    _other: tempfile::TempDir,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

impl TestServer {
    async fn start() -> Self {
        let notes = tempfile::tempdir().unwrap();
        std::fs::write(notes.path().join("Home.md"), "# Home\n\nSee [[Plan]].\n").unwrap();
        std::fs::create_dir(notes.path().join("Projects")).unwrap();
        std::fs::write(notes.path().join("Projects/Plan.md"), "# Plan\n").unwrap();
        std::fs::create_dir(notes.path().join(".obsidian")).unwrap();
        std::fs::write(notes.path().join(".obsidian/app.json"), "{}").unwrap();
        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join("Other.md"), "").unwrap();

        let config = Config {
            vaults: vec![
                VaultConfig { id: "notes".into(), path: notes.path().to_owned(), name: Some("My notes".into()) },
                VaultConfig { id: "other".into(), path: other.path().to_owned(), name: None },
            ],
            tokens: vec![
                TokenConfig { name: "all".into(), hash: quick_hash(ALL), vaults: None, read_only: false },
                TokenConfig { name: "notes".into(), hash: quick_hash(NOTES_ONLY), vaults: Some(vec!["notes".into()]), read_only: false },
            ],
            ..Config::default()
        };
        let server = Server::new(&config).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(server.serve(listener, async {
            let _ = stopped.await;
        }));
        Self { base, http: reqwest::Client::new(), notes, _other: other, stop: Some(stop) }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.http.get(self.url(path)).bearer_auth(ALL)
    }

    async fn post(&self, path: &str, body: Value, client: &str) -> (StatusCode, Value) {
        let response = self.http.post(self.url(path)).bearer_auth(ALL).header("X-EmeraldMD-Client", client).json(&body).send().await.unwrap();
        (response.status(), response.json().await.unwrap())
    }

    async fn put(&self, vault_path: &str, data: &str) -> (StatusCode, Value) {
        let response = self
            .http
            .put(self.url("/api/vaults/notes/files"))
            .bearer_auth(ALL)
            .query(&[("path", vault_path)])
            .body(data.to_owned())
            .send()
            .await
            .unwrap();
        (response.status(), response.json().await.unwrap())
    }

    async fn snapshot(&self) -> Value {
        self.get("/api/vaults/notes/snapshot").send().await.unwrap().json().await.unwrap()
    }

    async fn events(&self, query: &str, token: Option<&str>) -> Result<Ws, StatusCode> {
        let url = format!("{}/api/vaults/notes/events?{query}", self.base.replace("http://", "ws://"));
        let mut request = url.into_client_request().unwrap();
        if let Some(token) = token {
            request.headers_mut().insert("Authorization", format!("Bearer {token}").parse().unwrap());
        }
        match tokio_tungstenite::connect_async(request).await {
            Ok((ws, _)) => Ok(ws),
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => Err(response.status()),
            Err(err) => panic!("websocket failed: {err}"),
        }
    }
}

async fn next_message(ws: &mut Ws) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("no event within 10 s")
            .expect("stream ended")
            .expect("websocket error");
        match message {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Ping(_) | Message::Pong(_) => {}
            other => panic!("unexpected message: {other:?}"),
        }
    }
}

fn upserted_paths(update: &Value) -> Vec<&str> {
    update["upserted"].as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn every_request_needs_a_valid_token() {
    let server = TestServer::start().await;
    let anonymous = server.http.get(server.url("/api/vaults")).send().await.unwrap();
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(anonymous.headers()["www-authenticate"], "Bearer");
    let wrong = server.http.get(server.url("/api/vaults")).bearer_auth("nope").send().await.unwrap();
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    let unknown_path = server.http.get(server.url("/anything")).send().await.unwrap();
    assert_eq!(unknown_path.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(server.events("", None).await.unwrap_err(), StatusCode::UNAUTHORIZED);

    let all: Value = server.get("/api/vaults").send().await.unwrap().json().await.unwrap();
    assert_eq!(all, json!([{ "id": "notes", "name": "My notes" }, { "id": "other", "name": all[1]["name"] }]));

    let limited = |path: &str| server.http.get(server.url(path)).bearer_auth(NOTES_ONLY).send();
    let vaults: Value = limited("/api/vaults").await.unwrap().json().await.unwrap();
    assert_eq!(vaults, json!([{ "id": "notes", "name": "My notes" }]));
    assert_eq!(limited("/api/vaults/other/snapshot").await.unwrap().status(), StatusCode::NOT_FOUND);
    assert_eq!(limited("/api/vaults/notes/snapshot").await.unwrap().status(), StatusCode::OK);
}

#[tokio::test]
async fn cors_allows_only_the_app_origins() {
    let server = TestServer::start().await;
    let preflight = |origin: &'static str| {
        server
            .http
            .request(reqwest::Method::OPTIONS, server.url("/api/vaults/notes/files"))
            .header("Origin", origin)
            .header("Access-Control-Request-Method", "PUT")
            .header("Access-Control-Request-Headers", "authorization,content-type,x-emeraldmd-client")
            .send()
    };
    for origin in ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"] {
        let response = preflight(origin).await.unwrap();
        assert!(response.status().is_success(), "{origin}: {}", response.status());
        assert_eq!(response.headers()["access-control-allow-origin"], origin);
        let headers = response.headers()["access-control-allow-headers"].to_str().unwrap().to_lowercase();
        assert!(headers.contains("authorization") && headers.contains("x-emeraldmd-client"), "{headers}");
    }
    let evil = preflight("https://evil.example").await.unwrap();
    assert!(evil.headers().get("access-control-allow-origin").is_none());
}

#[tokio::test]
async fn reads_and_changes_files_like_the_desktop_commands() {
    let server = TestServer::start().await;
    let snapshot = server.snapshot().await;
    assert_eq!(snapshot["name"], "My notes");
    assert_eq!(snapshot["basePath"], "");
    assert_eq!(snapshot["version"], 0);
    let files: Vec<&str> = snapshot["files"].as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap()).collect();
    assert_eq!(files, ["Home.md", "Projects", "Projects/Plan.md"]);
    assert_eq!(snapshot["links"]["Home.md"]["resolved"], json!({ "Projects/Plan.md": 1 }));

    // Create
    let (status, update) = server.post("/api/vaults/notes/files", json!({ "path": "Ideas/New.md", "data": "# New\n[[Home]]" }), "a").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(upserted_paths(&update), ["Ideas", "Ideas/New.md"]);
    assert_eq!(update["metadata"]["Ideas/New.md"]["headings"][0]["heading"], "New");
    assert_eq!(update["links"]["Ideas/New.md"]["resolved"], json!({ "Home.md": 1 }));

    // Read
    let read = server.get("/api/vaults/notes/files").query(&[("path", "Ideas/New.md")]).send().await.unwrap();
    assert_eq!(read.headers()["content-type"], "text/plain; charset=utf-8");
    assert_eq!(read.text().await.unwrap(), "# New\n[[Home]]");
    let config = server.get("/api/vaults/notes/files").query(&[("path", ".obsidian/app.json")]).send().await.unwrap();
    assert_eq!(config.text().await.unwrap(), "{}");

    // Write
    let (status, update) = server.put("Ideas/New.md", "changed #tag").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(upserted_paths(&update), ["Ideas/New.md"]);
    assert_eq!(update["metadata"]["Ideas/New.md"]["tags"][0]["tag"], "#tag");
    assert_eq!(std::fs::read_to_string(server.notes.path().join("Ideas/New.md")).unwrap(), "changed #tag");

    // Folder, rename, trash
    let (status, update) = server.post("/api/vaults/notes/folders", json!({ "path": "Archive" }), "a").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(upserted_paths(&update), ["Archive"]);
    let (status, update) = server.post("/api/vaults/notes/rename", json!({ "from": "Projects/Plan.md", "to": "Archive/Plan.md" }), "a").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(update["renamed"], json!([["Projects/Plan.md", "Archive/Plan.md"]]));
    assert_eq!(update["links"]["Home.md"]["resolved"], json!({ "Archive/Plan.md": 1 }));
    let (status, update) = server.post("/api/vaults/notes/trash", json!({ "path": "Archive" }), "a").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(update["removed"], json!(["Archive/Plan.md", "Archive"]));
    assert!(server.notes.path().join(".trash/Archive/Plan.md").exists(), "trash moves, never deletes");

    let snapshot = server.snapshot().await;
    assert_eq!(snapshot["version"], 5);
}

#[tokio::test]
async fn reports_vault_errors_with_status_codes() {
    let server = TestServer::start().await;
    let (status, body) = server.post("/api/vaults/notes/files", json!({ "path": "Home.md", "data": "" }), "a").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "already exists: Home.md");
    let missing = server.get("/api/vaults/notes/files").query(&[("path", "Missing.md")]).send().await.unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert_eq!(server.put("../escape.md", "x").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(server.put(".obsidian/app.json", "x").await.0, StatusCode::BAD_REQUEST);
    let (status, _) = server.post("/api/vaults/notes/rename", json!({ "from": "Nope.md", "to": "B.md" }), "a").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = server.post("/api/vaults/missing/folders", json!({ "path": "A" }), "a").await;
    assert_eq!((status, body["error"].as_str()), (StatusCode::NOT_FOUND, Some("unknown vault: missing")));
    assert!(!Path::new(&server.notes.path().join("../escape.md")).exists());
}

#[tokio::test]
async fn event_stream_pushes_changes_from_other_clients() {
    let server = TestServer::start().await;
    let snapshot = server.snapshot().await;
    let query = format!("epoch={}&since={}&client=me", snapshot["epoch"].as_str().unwrap(), snapshot["version"]);
    let mut ws = server.events(&query, Some(ALL)).await.unwrap();

    // The client's own change is in its HTTP response, so it is not pushed back.
    server.post("/api/vaults/notes/files", json!({ "path": "Mine.md" }), "me").await;
    server.post("/api/vaults/notes/files", json!({ "path": "Theirs.md", "data": "#shared" }), "someone-else").await;

    let message = next_message(&mut ws).await;
    assert_eq!(message["type"], "update");
    assert_eq!(message["version"], 2);
    assert_eq!(upserted_paths(&message["update"]), ["Theirs.md"]);
    assert_eq!(message["update"]["metadata"]["Theirs.md"]["tags"][0]["tag"], "#shared");
}

#[tokio::test]
async fn event_stream_reports_changes_made_on_disk() {
    let server = TestServer::start().await;
    let mut ws = server.events("", Some(ALL)).await.unwrap();
    std::fs::write(server.notes.path().join("Outside.md"), "written by another program").unwrap();
    let message = next_message(&mut ws).await;
    assert_eq!(upserted_paths(&message["update"]), ["Outside.md"]);
    let read = server.get("/api/vaults/notes/files").query(&[("path", "Outside.md")]).send().await.unwrap();
    assert_eq!(read.text().await.unwrap(), "written by another program");
}

#[tokio::test]
async fn event_stream_replays_missed_updates_or_asks_for_a_resync() {
    let server = TestServer::start().await;
    let epoch = server.snapshot().await["epoch"].as_str().unwrap().to_owned();
    server.post("/api/vaults/notes/files", json!({ "path": "One.md" }), "a").await;
    server.post("/api/vaults/notes/files", json!({ "path": "Two.md" }), "a").await;

    let mut ws = server.events(&format!("epoch={epoch}&since=1&client=b"), Some(ALL)).await.unwrap();
    let message = next_message(&mut ws).await;
    assert_eq!((message["version"].as_u64(), upserted_paths(&message["update"])), (Some(2), vec!["Two.md"]));

    for query in ["epoch=from-a-previous-run&since=1", &format!("epoch={epoch}&since=99")] {
        let mut ws = server.events(query, Some(ALL)).await.unwrap();
        assert_eq!(next_message(&mut ws).await, json!({ "type": "resync" }));
    }
}

#[tokio::test]
async fn tickets_open_the_event_stream_once() {
    let server = TestServer::start().await;
    let unauthorized = server.http.post(server.url("/api/vaults/notes/events/ticket")).send().await.unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    let forbidden = server.http.post(server.url("/api/vaults/other/events/ticket")).bearer_auth(NOTES_ONLY).send().await.unwrap();
    assert_eq!(forbidden.status(), StatusCode::NOT_FOUND);

    let response: Value =
        server.http.post(server.url("/api/vaults/notes/events/ticket")).bearer_auth(NOTES_ONLY).send().await.unwrap().json().await.unwrap();
    assert_eq!(response["expiresInSecs"], 30);
    let first = response["ticket"].as_str().unwrap();
    let mut ws = server.events(&format!("ticket={first}&client=t"), None).await.unwrap();
    server.post("/api/vaults/notes/folders", json!({ "path": "Pushed" }), "other").await;
    assert_eq!(upserted_paths(&next_message(&mut ws).await["update"]), ["Pushed"]);
    assert_eq!(server.events(&format!("ticket={first}"), None).await.unwrap_err(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn search_uses_obsidian_query_syntax() {
    let server = TestServer::start().await;
    let found: Value = server.get("/api/vaults/notes/search?q=file%3Aplan").send().await.unwrap().json().await.unwrap();
    assert_eq!(found["totalFiles"], 1);
    assert_eq!(found["files"][0]["path"], "Projects/Plan.md");
    let linked: Value = server.get("/api/vaults/notes/search?q=%22See%20%5B%5BPlan%5D%5D%22").send().await.unwrap().json().await.unwrap();
    assert_eq!(linked["files"][0]["path"], "Home.md");
    assert_eq!(linked["files"][0]["matches"][0]["line"], 2);
    let bad = server.get("/api/vaults/notes/search?q=(oops").send().await.unwrap();
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    let error: Value = bad.json().await.unwrap();
    assert!(error["error"].as_str().unwrap().contains("unclosed ("), "{error}");
}
