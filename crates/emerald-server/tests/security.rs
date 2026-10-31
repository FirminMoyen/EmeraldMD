//! Security behavior over real HTTP: headers, error bodies, size limits,
//! rate limiting of failed logins, event stream limits, and the path policy
//! on every endpoint.

mod common;

use std::time::Duration;

use common::{ALL, NOTES_ONLY, SPARE, TestServer, next_frame, next_message, upserted_paths};
use futures_util::SinkExt;
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

async fn error_of(response: reqwest::Response) -> (StatusCode, String) {
    let status = response.status();
    assert_eq!(response.headers()["content-type"], "application/json", "{status}");
    let body: Value = response.json().await.unwrap();
    (status, body["error"].as_str().unwrap_or_else(|| panic!("no error message: {body}")).to_owned())
}

#[tokio::test]
async fn health_check_needs_no_token_and_says_nothing_else() {
    let server = TestServer::start().await;
    let response = server.http.get(server.url("/healthz")).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.json::<Value>().await.unwrap(), json!({ "status": "ok" }));
    // Only that exact path is open.
    assert_eq!(server.http.get(server.url("/healthz/")).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert_eq!(server.http.get(server.url("/api/vaults")).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn every_response_carries_security_headers() {
    let server = TestServer::start().await;
    let responses = [
        server.http.get(server.url("/healthz")).send().await.unwrap(),
        server.get("/api/vaults").send().await.unwrap(),
        server.get("/api/vaults/notes/files?path=Home.md").send().await.unwrap(),
        server.http.get(server.url("/api/vaults")).send().await.unwrap(),
        server.get("/no/such/route").send().await.unwrap(),
        server
            .http
            .request(reqwest::Method::OPTIONS, server.url("/api/vaults"))
            .header("Origin", "tauri://localhost")
            .header("Access-Control-Request-Method", "GET")
            .send()
            .await
            .unwrap(),
    ];
    for response in responses {
        let headers = response.headers();
        let status = response.status();
        assert_eq!(headers["x-content-type-options"], "nosniff", "{status}");
        assert_eq!(headers["x-frame-options"], "DENY", "{status}");
        assert_eq!(headers["referrer-policy"], "no-referrer", "{status}");
        assert!(headers["content-security-policy"].to_str().unwrap().contains("default-src 'none'"), "{status}");
        assert_eq!(headers["cache-control"], "no-store", "{status}");
        assert!(headers.get("server").is_none());
    }
}

#[tokio::test]
async fn errors_are_json_without_server_paths() {
    let server = TestServer::start().await;
    let root = server.notes.path().canonicalize().unwrap().display().to_string();
    let cases = [
        (server.get("/no/such/route"), StatusCode::NOT_FOUND),
        (server.get("/api/vaults/notes/files"), StatusCode::BAD_REQUEST),
        (server.get("/api/vaults/notes/files?path=Missing.md"), StatusCode::NOT_FOUND),
        (server.get("/api/vaults/notes/files?path=Projects"), StatusCode::BAD_REQUEST),
        (server.get("/api/vaults/notes/files?path=..%2F..%2Fetc%2Fpasswd"), StatusCode::BAD_REQUEST),
        (server.get("/api/vaults/notes/raw?path=a%00b.md"), StatusCode::BAD_REQUEST),
        (server.get("/api/vaults/nope/snapshot"), StatusCode::NOT_FOUND),
        (server.http.delete(server.url("/api/vaults/notes/files")).bearer_auth(ALL), StatusCode::METHOD_NOT_ALLOWED),
        (
            server.http.post(server.url("/api/vaults/notes/files")).bearer_auth(ALL).header("content-type", "application/json").body("{nope"),
            StatusCode::BAD_REQUEST,
        ),
    ];
    for (request, expected) in cases {
        let (status, message) = error_of(request.send().await.unwrap()).await;
        assert_eq!(status, expected, "{message}");
        assert!(!message.is_empty());
        assert!(!message.contains(&root) && !message.contains("/private/") && !message.contains("/tmp"), "{message}");
    }
}

#[tokio::test]
async fn bodies_are_limited_on_every_route() {
    let server = TestServer::start_with(|config, _| config.max_body_mb = 1).await;
    let put = |size: usize| {
        server.http.put(server.url("/api/vaults/notes/raw?path=Big.bin")).bearer_auth(ALL).body(vec![b'x'; size]).send()
    };
    assert_eq!(put(512 * 1024).await.unwrap().status(), StatusCode::OK);
    // The server answers 413 without reading the body; under load it may close the
    // connection while the client is still sending, which also means refused.
    match put(1024 * 1024 + 1).await {
        Ok(response) => assert_eq!(error_of(response).await.0, StatusCode::PAYLOAD_TOO_LARGE),
        Err(err) => assert!(err.is_request() || err.is_body(), "{err}"),
    }
    assert!(!server.notes.path().join("Big.bin").metadata().is_ok_and(|m| m.len() > 1024 * 1024));
    let note = json!({ "path": "Long.md", "data": "y".repeat(512 * 1024) });
    assert_eq!(server.post("/api/vaults/notes/files", note).await.0, StatusCode::OK);
    // Routes that only carry paths take small bodies.
    let padded = json!({ "path": "Folder", "padding": "z".repeat(100 * 1024) });
    let (status, _) = error_of(server.http.post(server.url("/api/vaults/notes/folders")).bearer_auth(ALL).json(&padded).send().await.unwrap()).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    for route in ["rename", "trash", "events/ticket"] {
        let response = server.http.post(server.url(&format!("/api/vaults/notes/{route}"))).bearer_auth(ALL).json(&padded).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE, "{route}");
    }
}

#[tokio::test]
async fn failed_logins_are_rate_limited_per_client() {
    let server = TestServer::start().await;
    assert_eq!(server.status("/api/vaults", ALL).await, StatusCode::OK);
    for _ in 0..10 {
        assert_eq!(server.status("/api/vaults", "wrong").await, StatusCode::UNAUTHORIZED);
    }
    let limited = server.http.get(server.url("/api/vaults")).bearer_auth("wrong").send().await.unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    let retry: u64 = limited.headers()["retry-after"].to_str().unwrap().parse().unwrap();
    assert!((1..=6).contains(&retry), "{retry}");
    let (_, message) = error_of(limited).await;
    assert!(message.contains("too many failed"));

    // A token this server has already verified keeps working from the same address...
    assert_eq!(server.status("/api/vaults", ALL).await, StatusCode::OK);
    // ...but a new one has to wait like any other guess, and so do tickets.
    assert_eq!(server.status("/api/vaults", SPARE).await, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(server.events("notes", "ticket=guess", None).await.unwrap_err(), StatusCode::TOO_MANY_REQUESTS);
    // Requests without credentials cost nothing and are simply refused.
    assert_eq!(server.http.get(server.url("/api/vaults")).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn forwarded_for_is_ignored_unless_the_proxy_is_trusted() {
    let spoofing = TestServer::start().await;
    for i in 0..10 {
        let response = spoofing.http.get(spoofing.url("/api/vaults")).bearer_auth("wrong").header("X-Forwarded-For", format!("198.51.100.{i}")).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let response = spoofing.http.get(spoofing.url("/api/vaults")).bearer_auth("wrong").header("X-Forwarded-For", "198.51.100.99").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS, "a client cannot pick a fresh address");

    let proxied = TestServer::start_with(|config, _| config.trusted_proxies = vec!["127.0.0.1".into()]).await;
    let from = |client: &'static str, token: &'static str| {
        proxied.http.get(proxied.url("/api/vaults")).bearer_auth(token).header("X-Forwarded-For", format!("6.6.6.6, {client}")).send()
    };
    for _ in 0..10 {
        assert_eq!(from("203.0.113.7", "wrong").await.unwrap().status(), StatusCode::UNAUTHORIZED);
    }
    assert_eq!(from("203.0.113.7", "wrong").await.unwrap().status(), StatusCode::TOO_MANY_REQUESTS);
    // Another client behind the same proxy is not affected.
    assert_eq!(from("203.0.113.8", "wrong").await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert_eq!(from("203.0.113.8", SPARE).await.unwrap().status(), StatusCode::OK);
}

#[tokio::test]
async fn event_streams_are_limited_per_token() {
    let server = TestServer::start_with(|config, _| config.max_streams_per_token = 2).await;
    let first = server.events("notes", "", Some(ALL)).await.unwrap();
    let _second = server.events("notes", "", Some(ALL)).await.unwrap();
    assert_eq!(server.events("notes", "", Some(ALL)).await.unwrap_err(), StatusCode::TOO_MANY_REQUESTS);
    // Tickets count against the token they were issued for.
    let ticket: Value = server.http.post(server.url("/api/vaults/notes/events/ticket")).bearer_auth(ALL).send().await.unwrap().json().await.unwrap();
    let ticket = ticket["ticket"].as_str().unwrap();
    assert_eq!(server.events("notes", &format!("ticket={ticket}"), None).await.unwrap_err(), StatusCode::TOO_MANY_REQUESTS);
    // Other tokens have their own allowance.
    let _other = server.events("notes", "", Some(NOTES_ONLY)).await.unwrap();

    drop(first);
    let mut reopened = None;
    for _ in 0..100 {
        if let Ok(ws) = server.events("notes", "", Some(ALL)).await {
            reopened = Some(ws);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(reopened.is_some(), "a closed stream frees its slot");
}

#[tokio::test]
async fn event_streams_refuse_large_client_messages() {
    let server = TestServer::start().await;
    let mut ws = server.events("notes", "", Some(ALL)).await.unwrap();
    // Small messages are ignored...
    ws.send(Message::text("hello")).await.unwrap();
    server.post("/api/vaults/notes/folders", json!({ "path": "Still open" })).await;
    assert_eq!(upserted_paths(&next_message(&mut ws).await["update"]), ["Still open"]);
    // ...a large one ends the stream.
    let _ = ws.send(Message::text("x".repeat(64 * 1024))).await;
    loop {
        match next_frame(&mut ws).await {
            None | Some(Message::Close(_)) => break,
            Some(Message::Ping(_) | Message::Pong(_)) => {}
            Some(other) => panic!("stream still open: {other:?}"),
        }
    }
}

/// Every endpoint that takes a path refuses `..`, and hidden paths outside
/// the config folder.
#[tokio::test]
async fn every_endpoint_refuses_paths_outside_the_vault() {
    let server = TestServer::start().await;
    std::fs::create_dir_all(server.notes.path().join(".trash")).unwrap();
    std::fs::write(server.notes.path().join(".trash/Old.md"), "deleted").unwrap();
    std::fs::create_dir_all(server.notes.path().join(".git")).unwrap();
    std::fs::write(server.notes.path().join(".git/config"), "url = https://user:secret@example.com").unwrap();
    let escape = server.outside.path().join("escape.md");

    for path in ["../escape.md", "Projects/../../escape.md", "..\\escape.md", "./Home.md"] {
        let query = [("path", path)];
        let read = server.get("/api/vaults/notes/files").query(&query).send().await.unwrap();
        assert_eq!(read.status(), StatusCode::BAD_REQUEST, "read {path}");
        let raw = server.get("/api/vaults/notes/raw").query(&query).send().await.unwrap();
        assert_eq!(raw.status(), StatusCode::BAD_REQUEST, "raw {path}");
        let put = server.http.put(server.url("/api/vaults/notes/files")).bearer_auth(ALL).query(&query).body("x").send().await.unwrap();
        assert_eq!(put.status(), StatusCode::BAD_REQUEST, "put {path}");
        let put_raw = server.http.put(server.url("/api/vaults/notes/raw")).bearer_auth(ALL).query(&query).body("x").send().await.unwrap();
        assert_eq!(put_raw.status(), StatusCode::BAD_REQUEST, "put raw {path}");
        for (route, body) in [
            ("files", json!({ "path": path, "data": "x" })),
            ("folders", json!({ "path": path })),
            ("rename", json!({ "from": "Home.md", "to": path })),
            ("rename", json!({ "from": path, "to": "Moved.md" })),
            ("trash", json!({ "path": path })),
        ] {
            let (status, _) = server.post(&format!("/api/vaults/notes/{route}"), body.clone()).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{route} {body}");
        }
    }
    assert!(!escape.exists() && server.notes.path().join("Home.md").exists());

    // Hidden files: only the config folder can be read.
    for path in [".trash/Old.md", ".git/config", "Projects/.hidden"] {
        for route in ["files", "raw"] {
            let response = server.get(&format!("/api/vaults/notes/{route}")).query(&[("path", path)]).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{route} {path}");
        }
    }
    let config = server.get("/api/vaults/notes/raw").query(&[("path", ".obsidian/app.json")]).send().await.unwrap();
    assert_eq!(config.text().await.unwrap(), "{}");
    for (route, body) in [
        ("files", json!({ "path": ".git/hooks/post-checkout", "data": "x" })),
        ("folders", json!({ "path": ".ssh" })),
        ("rename", json!({ "from": "Home.md", "to": ".trash/Home.md" })),
    ] {
        assert_eq!(server.post(&format!("/api/vaults/notes/{route}"), body).await.0, StatusCode::BAD_REQUEST, "{route}");
    }
    assert_eq!(server.post("/api/vaults/notes/trash", json!({ "path": ".obsidian" })).await.0, StatusCode::NOT_FOUND);
    // Listings never show hidden files.
    let manifest: Value = server.get("/api/vaults/notes/manifest").send().await.unwrap().json().await.unwrap();
    assert!(manifest.as_object().unwrap().keys().all(|k| !k.starts_with('.')), "{manifest}");
    let found: Value = server.get("/api/vaults/notes/search?q=secret").send().await.unwrap().json().await.unwrap();
    assert_eq!(found["totalFiles"], 0);

    // A leading slash is a vault path, not an OS path; a NUL byte is refused.
    let (status, update) = server.post("/api/vaults/notes/files", json!({ "path": "/Rooted.md" })).await;
    assert_eq!((status, upserted_paths(&update)), (StatusCode::OK, vec!["Rooted.md"]));
    assert!(server.notes.path().join("Rooted.md").exists());
    assert_eq!(server.post("/api/vaults/notes/files", json!({ "path": "a\u{0}b.md" })).await.0, StatusCode::BAD_REQUEST);
    // A Windows drive prefix never leaves the vault: refused on Windows, a plain folder name elsewhere.
    let (status, _) = server.post("/api/vaults/notes/files", json!({ "path": "C:/Drive.md" })).await;
    if cfg!(windows) {
        assert_eq!(status, StatusCode::BAD_REQUEST);
    } else {
        assert_eq!(status, StatusCode::OK);
        assert!(server.notes.path().join("C:/Drive.md").exists());
    }
}

/// Symbolic links that lead out of the vault folder are neither followed
/// nor listed, on every endpoint.
#[cfg(unix)]
#[tokio::test]
async fn symlinks_out_of_the_vault_are_not_followed() {
    use std::os::unix::fs::symlink;
    let outside_dir = tempfile::tempdir().unwrap();
    let outside = outside_dir.path().to_owned();
    std::fs::write(outside.join("secret.md"), "# Secret\nTOPSECRET [[Home]]\n").unwrap();
    let server = TestServer::start_with(|_, notes| {
        symlink(&outside, notes.join("Linked")).unwrap();
        symlink(outside.join("secret.md"), notes.join("Secret link.md")).unwrap();
        symlink(outside.join("missing.md"), notes.join("Dangling.md")).unwrap();
        symlink(notes.join("Projects"), notes.join("Alias")).unwrap();
        symlink(&outside, notes.join(".obsidian/plugins")).unwrap();
    })
    .await;
    let outside = outside_dir.path();
    let before: Vec<_> = std::fs::read_dir(outside).unwrap().map(|e| e.unwrap().file_name()).collect();

    // Listings
    let snapshot: Value = server.get("/api/vaults/notes/snapshot").send().await.unwrap().json().await.unwrap();
    let files: Vec<&str> = snapshot["files"].as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap()).collect();
    assert_eq!(files, ["Alias", "Alias/Plan.md", "Home.md", "Projects", "Projects/Plan.md"], "links inside the vault still work");
    let text = snapshot.to_string();
    assert!(!text.contains("Linked") && !text.contains("Secret link") && !text.contains("TOPSECRET"), "{text}");
    let manifest: Value = server.get("/api/vaults/notes/manifest").send().await.unwrap().json().await.unwrap();
    let keys: Vec<&String> = manifest.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["Alias/Plan.md", "Home.md", "Projects/Plan.md"]);
    let found: Value = server.get("/api/vaults/notes/search?q=TOPSECRET").send().await.unwrap().json().await.unwrap();
    assert_eq!((found["totalFiles"].as_u64(), found["files"].as_array().unwrap().len()), (Some(0), 0));
    let by_name: Value = server.get("/api/vaults/notes/search?q=file%3Asecret").send().await.unwrap().json().await.unwrap();
    assert_eq!(by_name["totalFiles"], 0, "{by_name}");
    let limited: Value = server.get("/api/vaults/notes/search?q=file%3Aplan&limit=1").send().await.unwrap().json().await.unwrap();
    assert_eq!((limited["totalFiles"].as_u64(), limited["files"].as_array().unwrap().len()), (Some(2), 1));

    // Reads
    for path in ["Linked/secret.md", "Secret link.md", ".obsidian/plugins/secret.md"] {
        for route in ["files", "raw"] {
            let response = server.get(&format!("/api/vaults/notes/{route}")).query(&[("path", path)]).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{route} {path}");
            assert!(!response.text().await.unwrap().contains("TOPSECRET"));
        }
    }
    let alias = server.get("/api/vaults/notes/files").query(&[("path", "Alias/Plan.md")]).send().await.unwrap();
    assert_eq!(alias.text().await.unwrap(), "# Plan\n");

    // Writes
    for path in ["Linked/new.md", "Linked/Sub/new.md", "Secret link.md", "Dangling.md"] {
        let query = [("path", path)];
        for route in ["files", "raw"] {
            let put = server.http.put(server.url(&format!("/api/vaults/notes/{route}"))).bearer_auth(ALL).query(&query).body("pwned").send().await.unwrap();
            assert_eq!(put.status(), StatusCode::BAD_REQUEST, "put {route} {path}");
        }
        assert_eq!(server.post("/api/vaults/notes/files", json!({ "path": path, "data": "x" })).await.0, StatusCode::BAD_REQUEST, "create {path}");
    }
    assert_eq!(server.post("/api/vaults/notes/folders", json!({ "path": "Linked/Sub" })).await.0, StatusCode::BAD_REQUEST);
    for body in [json!({ "from": "Home.md", "to": "Linked/Home.md" }), json!({ "from": "Linked/secret.md", "to": "Stolen.md" })] {
        assert_eq!(server.post("/api/vaults/notes/rename", body.clone()).await.0, StatusCode::BAD_REQUEST, "{body}");
    }
    assert_eq!(server.post("/api/vaults/notes/trash", json!({ "path": "Secret link.md" })).await.0, StatusCode::BAD_REQUEST);
    let after: Vec<_> = std::fs::read_dir(outside).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(before, after, "nothing was created outside the vault");
    assert_eq!(std::fs::read_to_string(outside.join("secret.md")).unwrap(), "# Secret\nTOPSECRET [[Home]]\n");
    assert!(!outside.join("missing.md").exists());

    // Event stream: changes behind the link are not pushed.
    let mut ws = server.events("notes", "", Some(ALL)).await.unwrap();
    std::fs::write(outside.join("secret2.md"), "TOPSECRET").unwrap();
    std::fs::write(outside.join("secret.md"), "TOPSECRET changed").unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    server.post("/api/vaults/notes/files", json!({ "path": "Visible.md" })).await;
    let message = next_message(&mut ws).await;
    assert_eq!(upserted_paths(&message["update"]), ["Visible.md"], "{message}");

    // A .trash folder that leads outside is not used.
    symlink(outside, server.notes.path().join(".trash")).unwrap();
    assert_eq!(server.post("/api/vaults/notes/trash", json!({ "path": "Home.md" })).await.0, StatusCode::BAD_REQUEST);
    assert!(server.notes.path().join("Home.md").exists() && !outside.join("Home.md").exists());
}

#[tokio::test]
async fn revoked_tokens_cannot_redeem_tickets() {
    let server = TestServer::start().await;
    let response: Value = server.http.post(server.url("/api/vaults/notes/events/ticket")).bearer_auth(NOTES_ONLY).send().await.unwrap().json().await.unwrap();
    let ticket = response["ticket"].as_str().unwrap().to_owned();
    let mut config = server.config.clone();
    config.tokens.retain(|t| t.name != "notes");
    server.reload(config).await.unwrap();
    assert_eq!(server.events("notes", &format!("ticket={ticket}"), None).await.unwrap_err(), StatusCode::UNAUTHORIZED);
    // Tickets of tokens that are still configured survive the reload.
    let response: Value = server.http.post(server.url("/api/vaults/notes/events/ticket")).bearer_auth(ALL).send().await.unwrap().json().await.unwrap();
    let ticket = response["ticket"].as_str().unwrap().to_owned();
    server.reload(server.config.clone()).await.unwrap();
    assert!(server.events("notes", &format!("ticket={ticket}"), None).await.is_ok());
}
