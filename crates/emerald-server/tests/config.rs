//! The config endpoints: the app keeps a remote vault's `.obsidian` (settings,
//! themes, snippets, hotkeys) on the server.

mod common;

use common::{ALL, NOTES_ONLY, TestServer};
use reqwest::StatusCode;
use serde_json::{Value, json};

impl TestServer {
    async fn put_config(&self, path: &str, data: &str, token: &str) -> StatusCode {
        self.http
            .put(self.url("/api/vaults/notes/config/file"))
            .query(&[("path", path)])
            .bearer_auth(token)
            .body(data.to_owned())
            .send()
            .await
            .unwrap()
            .status()
    }

    async fn get_json(&self, path: &str, query: &[(&str, &str)]) -> (StatusCode, Value) {
        let response = self.get(path).query(query).send().await.unwrap();
        let status = response.status();
        (status, response.json().await.unwrap_or(Value::Null))
    }
}

#[tokio::test]
async fn config_files_round_trip() {
    let server = TestServer::start().await;
    assert_eq!(server.put_config(".obsidian/themes/Ocean/theme.css", ".ocean {}", ALL).await, StatusCode::NO_CONTENT);
    assert_eq!(server.put_config(".obsidian/appearance.json", r#"{"cssTheme":"Ocean"}"#, ALL).await, StatusCode::NO_CONTENT);

    let read = server.get("/api/vaults/notes/files").query(&[("path", ".obsidian/themes/Ocean/theme.css")]).send().await.unwrap();
    assert_eq!(read.text().await.unwrap(), ".ocean {}");

    let (status, listing) = server.get_json("/api/vaults/notes/config/list", &[("path", ".obsidian")]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listing["files"], json!([".obsidian/app.json", ".obsidian/appearance.json"]));
    assert_eq!(listing["folders"], json!([".obsidian/themes"]));

    let (_, entry) = server.get_json("/api/vaults/notes/config/stat", &[("path", ".obsidian/themes/Ocean")]).await;
    assert_eq!(entry["kind"], "folder");
    let (_, missing) = server.get_json("/api/vaults/notes/config/stat", &[("path", ".obsidian/nope.json")]).await;
    assert_eq!(missing, Value::Null);

    let status = server
        .http
        .post(server.url("/api/vaults/notes/config/folders"))
        .bearer_auth(ALL)
        .json(&json!({ "path": ".obsidian/snippets" }))
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(server.notes.path().join(".obsidian/snippets").is_dir());

    // Config files are not notes: they stay out of the snapshot.
    let (_, snapshot) = server.get_json("/api/vaults/notes/snapshot", &[]).await;
    let paths: Vec<&str> = snapshot["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert!(paths.iter().all(|p| !p.starts_with(".obsidian")), "{paths:?}");
}

#[tokio::test]
async fn only_the_config_folder_is_reachable() {
    let server = TestServer::start().await;
    for path in [".trash/x.md", "Home.md", ".obsidian/../Home.md", "../outside.md", ".obsidianx/a", ".git/config"] {
        let status = server.put_config(path, "x", ALL).await;
        assert!(status.is_client_error(), "{path}: {status}");
        let (status, _) = server.get_json("/api/vaults/notes/config/list", &[("path", path)]).await;
        assert!(status.is_client_error(), "list {path}: {status}");
    }
    assert_eq!(std::fs::read_to_string(server.notes.path().join("Home.md")).unwrap(), "# Home\n\nSee [[Plan]].\n");
}

#[cfg(unix)]
#[tokio::test]
async fn links_out_of_the_config_folder_are_refused() {
    let server = TestServer::start_with(|_, notes| {
        std::fs::create_dir_all(notes.join(".obsidian/plugins")).unwrap();
    })
    .await;
    std::os::unix::fs::symlink(server.outside.path(), server.notes.path().join(".obsidian/plugins/evil")).unwrap();
    assert!(server.put_config(".obsidian/plugins/evil/main.js", "x", ALL).await.is_client_error());
    assert!(!server.outside.path().join("main.js").exists());
    let (_, listing) = server.get_json("/api/vaults/notes/config/list", &[("path", ".obsidian/plugins")]).await;
    assert_eq!(listing["folders"], json!([]));
}

#[tokio::test]
async fn tokens_reach_only_their_vaults() {
    let server = TestServer::start().await;
    let other = server
        .http
        .put(server.url("/api/vaults/other/config/file"))
        .query(&[("path", ".obsidian/app.json")])
        .bearer_auth(NOTES_ONLY)
        .body("{}")
        .send()
        .await
        .unwrap()
        .status();
    assert!(other == StatusCode::NOT_FOUND || other == StatusCode::FORBIDDEN, "{other}");
    assert_eq!(server.put_config(".obsidian/app.json", "{}", NOTES_ONLY).await, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn plugin_and_theme_folders_can_be_moved_to_the_trash() {
    let server = TestServer::start().await;
    assert_eq!(server.put_config(".obsidian/plugins/calendar/main.js", "x", ALL).await, StatusCode::NO_CONTENT);
    let trash = |path: &'static str| {
        server
            .http
            .post(server.url("/api/vaults/notes/config/trash"))
            .bearer_auth(ALL)
            .json(&json!({ "path": path }))
            .send()
    };
    assert_eq!(trash(".obsidian/plugins/calendar").await.unwrap().status(), StatusCode::NO_CONTENT);
    assert!(!server.notes.path().join(".obsidian/plugins/calendar").exists());
    assert!(server.notes.path().join(".trash").is_dir());
    for path in [".obsidian/app.json", ".obsidian", ".obsidian/plugins", "Home.md", ".obsidian/plugins/../../Home.md"] {
        let status = trash(path).await.unwrap().status();
        assert!(status.is_client_error(), "{path}: {status}");
    }
    assert!(server.notes.path().join("Home.md").exists());
    assert!(server.notes.path().join(".obsidian/app.json").exists());
}
