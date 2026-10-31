//! Version history: versions of changed files, deleted files, renames, and
//! the endpoints that read them.

mod common;

use std::time::Duration;

use common::{NOTES_ONLY, TestServer};
use reqwest::StatusCode;
use serde_json::{Value, json};

async fn start() -> (TestServer, tempfile::TempDir) {
    let history = tempfile::tempdir().unwrap();
    let dir = history.path().to_owned();
    let server = TestServer::start_with(move |config, _| config.history.dir = Some(dir)).await;
    (server, history)
}

async fn versions(server: &TestServer, path: &str) -> Vec<Value> {
    let response = server.get("/api/vaults/notes/history").query(&[("path", path)]).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    body["versions"].as_array().unwrap().clone()
}

async fn version_text(server: &TestServer, path: &str, time: u64) -> String {
    let response = server.get("/api/vaults/notes/history/raw").query(&[("path", path), ("time", &time.to_string())]).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response.text().await.unwrap()
}

async fn put(server: &TestServer, path: &str, text: &str) {
    let response = server
        .http
        .put(server.url("/api/vaults/notes/files"))
        .bearer_auth(common::ALL)
        .query(&[("path", path)])
        .body(text.to_owned())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn keeps_the_text_before_and_after_changes() {
    let (server, _history) = start().await;
    put(&server, "Home.md", "First edit\n").await;
    put(&server, "Home.md", "Second edit\n").await;
    let list = versions(&server, "Home.md").await;
    // The text from before the server changed it, and one version for the burst of edits.
    assert_eq!(list.len(), 2, "{list:?}");
    let newest = list[0]["time"].as_u64().unwrap();
    let oldest = list[1]["time"].as_u64().unwrap();
    assert!(newest > oldest);
    assert_eq!(version_text(&server, "Home.md", newest).await, "Second edit\n");
    assert_eq!(version_text(&server, "Home.md", oldest).await, "# Home\n\nSee [[Plan]].\n");
    assert_eq!(list[0]["size"], 12);
    let missing = server.get("/api/vaults/notes/history/raw").query(&[("path", "Home.md"), ("time", "1")]).send().await.unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn lists_deleted_files_and_follows_renames() {
    let (server, _history) = start().await;
    let (status, _) = server.post("/api/vaults/notes/trash", json!({ "path": "Projects" })).await;
    assert_eq!(status, StatusCode::OK);
    let deleted: Value = server.get("/api/vaults/notes/history/deleted").send().await.unwrap().json().await.unwrap();
    let deleted = deleted.as_array().unwrap();
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0]["path"], "Projects/Plan.md");
    assert!(deleted[0]["deletedAt"].as_u64().unwrap() > 0);
    let time = versions(&server, "Projects/Plan.md").await[0]["time"].as_u64().unwrap();
    assert_eq!(version_text(&server, "Projects/Plan.md", time).await, "# Plan\n");

    let (status, _) = server.post("/api/vaults/notes/rename", json!({ "from": "Home.md", "to": "Start.md" })).await;
    assert_eq!(status, StatusCode::OK);
    assert!(versions(&server, "Home.md").await.is_empty());
    let start = versions(&server, "Start.md").await;
    assert_eq!(start.len(), 1);
    assert_eq!(version_text(&server, "Start.md", start[0]["time"].as_u64().unwrap()).await, "# Home\n\nSee [[Plan]].\n");
}

#[tokio::test]
async fn keeps_changes_made_outside_the_server() {
    let (server, _history) = start().await;
    std::fs::write(server.notes.path().join("Outside.md"), "Written by another program\n").unwrap();
    let mut found = Vec::new();
    for _ in 0..50 {
        found = versions(&server, "Outside.md").await;
        if !found.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(found.len(), 1);
    assert_eq!(version_text(&server, "Outside.md", found[0]["time"].as_u64().unwrap()).await, "Written by another program\n");
}

#[tokio::test]
async fn refuses_hidden_paths_other_vaults_and_servers_without_history() {
    let (server, _history) = start().await;
    let status = |path: &'static str, token: &'static str| {
        let server = &server;
        async move { server.http.get(server.url(path)).bearer_auth(token).send().await.unwrap().status() }
    };
    assert_eq!(status("/api/vaults/notes/history?path=.obsidian/app.json", common::ALL).await, StatusCode::NOT_FOUND);
    assert_eq!(status("/api/vaults/notes/history?path=../secret.md", common::ALL).await, StatusCode::BAD_REQUEST);
    assert_eq!(status("/api/vaults/other/history/deleted", NOTES_ONLY).await, StatusCode::NOT_FOUND);
    assert_eq!(status("/api/vaults/notes/history/deleted", "wrong").await, StatusCode::UNAUTHORIZED);

    let plain = TestServer::start().await;
    let response = plain.get("/api/vaults/notes/history").query(&[("path", "Home.md")]).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"], "version history is off on this server");
}
