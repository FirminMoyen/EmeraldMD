//! Read-only tokens: everything that reads works, nothing that changes the vault does.

mod common;

use common::{TestServer, quick_hash};
use emerald_server::config::TokenConfig;
use reqwest::StatusCode;
use serde_json::{Value, json};

const READER: &str = "token-that-only-reads";

async fn start() -> TestServer {
    TestServer::start_with(|config, _| {
        config.tokens.push(TokenConfig { name: "reader".into(), hash: quick_hash(READER), vaults: Some(vec!["notes".into()]), read_only: true });
    })
    .await
}

#[tokio::test]
async fn reads_but_cannot_change_anything() {
    let server = start().await;
    let get = |path: &str| server.http.get(server.url(path)).bearer_auth(READER).send();

    let vaults: Value = get("/api/vaults").await.unwrap().json().await.unwrap();
    assert_eq!(vaults, json!([{ "id": "notes", "name": "My notes", "readOnly": true }]));
    let snapshot: Value = get("/api/vaults/notes/snapshot").await.unwrap().json().await.unwrap();
    assert_eq!(snapshot["readOnly"], true);
    let note = server.http.get(server.url("/api/vaults/notes/files")).query(&[("path", "Home.md")]).bearer_auth(READER).send().await.unwrap();
    assert_eq!(note.text().await.unwrap(), "# Home\n\nSee [[Plan]].\n");
    assert_eq!(server.http.get(server.url("/api/vaults/notes/search")).query(&[("q", "Plan")]).bearer_auth(READER).send().await.unwrap().status(), StatusCode::OK);

    let refused = |response: reqwest::Response| async move {
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["error"], "this token can only read");
    };
    refused(server.http.put(server.url("/api/vaults/notes/files")).query(&[("path", "Home.md")]).bearer_auth(READER).body("changed").send().await.unwrap()).await;
    refused(server.http.post(server.url("/api/vaults/notes/files")).bearer_auth(READER).json(&json!({ "path": "New.md", "data": "" })).send().await.unwrap()).await;
    refused(server.http.post(server.url("/api/vaults/notes/rename")).bearer_auth(READER).json(&json!({ "from": "Home.md", "to": "Start.md" })).send().await.unwrap()).await;
    refused(server.http.post(server.url("/api/vaults/notes/trash")).bearer_auth(READER).json(&json!({ "path": "Home.md" })).send().await.unwrap()).await;
    refused(server.http.put(server.url("/api/vaults/notes/config/file")).query(&[("path", ".obsidian/app.json")]).bearer_auth(READER).body("{}").send().await.unwrap()).await;
    assert_eq!(std::fs::read_to_string(server.notes.path().join("Home.md")).unwrap(), "# Home\n\nSee [[Plan]].\n");

    // The event stream still works: its ticket is a POST.
    let ticket = server.http.post(server.url("/api/vaults/notes/events/ticket")).bearer_auth(READER).json(&json!({})).send().await.unwrap();
    assert_eq!(ticket.status(), StatusCode::OK);

    // Other tokens are not read-only.
    let all: Value = server.get("/api/vaults").send().await.unwrap().json().await.unwrap();
    assert!(all[0].get("readOnly").is_none());
}
