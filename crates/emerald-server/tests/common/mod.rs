//! A server on a random port with two vaults ("notes" and "other") and three
//! tokens, plus a folder outside the vaults for symlink tests.

#![allow(dead_code)]

use std::time::Duration;

use argon2::password_hash::PasswordHasher;
use argon2::{Algorithm, Argon2, Params, Version};
use emerald_server::config::{Config, TokenConfig, VaultConfig};
use emerald_server::{AppState, Server};
use futures_util::StreamExt;
use reqwest::StatusCode;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub const ALL: &str = "token-for-every-vault";
pub const NOTES_ONLY: &str = "token-for-notes";
/// Valid, but not used by the harness, so the server has not verified it yet.
pub const SPARE: &str = "spare-token";

pub type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Cheap argon2 parameters keep the tests fast; the server reads them from the hash.
pub fn quick_hash(token: &str) -> String {
    let params = Params::new(8, 1, 1, None).unwrap();
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hash_password(token.as_bytes()).unwrap().to_string()
}

pub struct TestServer {
    pub base: String,
    pub http: reqwest::Client,
    pub notes: tempfile::TempDir,
    pub other: tempfile::TempDir,
    /// Not served; symlinks in the vaults point here.
    pub outside: tempfile::TempDir,
    pub config: Config,
    pub state: AppState,
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
    pub async fn start() -> Self {
        Self::start_with(|_, _| {}).await
    }

    /// `prepare` gets the config and the notes folder before the server starts.
    pub async fn start_with(prepare: impl FnOnce(&mut Config, &std::path::Path)) -> Self {
        let notes = tempfile::tempdir().unwrap();
        std::fs::write(notes.path().join("Home.md"), "# Home\n\nSee [[Plan]].\n").unwrap();
        std::fs::create_dir(notes.path().join("Projects")).unwrap();
        std::fs::write(notes.path().join("Projects/Plan.md"), "# Plan\n").unwrap();
        std::fs::create_dir(notes.path().join(".obsidian")).unwrap();
        std::fs::write(notes.path().join(".obsidian/app.json"), "{}").unwrap();
        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join("Other.md"), "").unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.md"), "# Secret\nTOPSECRET [[Home]]\n").unwrap();

        let mut config = Config {
            vaults: vec![
                VaultConfig { id: "notes".into(), path: notes.path().to_owned(), name: Some("My notes".into()) },
                VaultConfig { id: "other".into(), path: other.path().to_owned(), name: None },
            ],
            tokens: vec![
                TokenConfig { name: "all".into(), hash: quick_hash(ALL), vaults: None },
                TokenConfig { name: "notes".into(), hash: quick_hash(NOTES_ONLY), vaults: Some(vec!["notes".into()]) },
                TokenConfig { name: "spare".into(), hash: quick_hash(SPARE), vaults: None },
            ],
            ..Config::default()
        };
        prepare(&mut config, notes.path());
        let server = Server::new(&config).unwrap();
        let state = server.state.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(server.serve(listener, async {
            let _ = stopped.await;
        }));
        Self { base, http: reqwest::Client::new(), notes, other, outside, config, state, stop: Some(stop) }
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    pub fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.http.get(self.url(path)).bearer_auth(ALL)
    }

    pub async fn status(&self, path: &str, token: &str) -> StatusCode {
        self.http.get(self.url(path)).bearer_auth(token).send().await.unwrap().status()
    }

    pub async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        let response = self.http.post(self.url(path)).bearer_auth(ALL).header("X-EmeraldMD-Client", "test").json(&body).send().await.unwrap();
        (response.status(), response.json().await.unwrap())
    }

    /// Applies a new config like SIGHUP does.
    pub async fn reload(&self, config: Config) -> Result<emerald_server::ReloadSummary, String> {
        let state = self.state.clone();
        tokio::task::spawn_blocking(move || state.reload(&config)).await.unwrap()
    }

    pub async fn events(&self, vault: &str, query: &str, token: Option<&str>) -> Result<Ws, StatusCode> {
        let url = format!("{}/api/vaults/{vault}/events?{query}", self.base.replace("http://", "ws://"));
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

/// The next text message, skipping pings. Panics on close or after 10 s.
pub async fn next_message(ws: &mut Ws) -> Value {
    loop {
        match next_frame(ws).await {
            Some(Message::Text(text)) => return serde_json::from_str(&text).unwrap(),
            Some(Message::Ping(_) | Message::Pong(_)) => {}
            other => panic!("unexpected message: {other:?}"),
        }
    }
}

/// The next frame, or `None` once the stream has ended.
pub async fn next_frame(ws: &mut Ws) -> Option<Message> {
    tokio::time::timeout(Duration::from_secs(10), ws.next()).await.expect("nothing within 10 s")?.ok()
}

/// The close frame's code, skipping anything sent before it.
pub async fn close_code(ws: &mut Ws) -> Option<u16> {
    loop {
        match next_frame(ws).await? {
            Message::Close(frame) => return frame.map(|f| f.code.into()),
            _ => continue,
        }
    }
}

pub fn upserted_paths(update: &Value) -> Vec<&str> {
    update["upserted"].as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap()).collect()
}
