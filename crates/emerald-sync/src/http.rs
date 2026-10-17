//! [`Remote`] over an emeraldmd-server's HTTP API (`docs/self-hosting.md`).

use std::time::Duration;

use reqwest::Url;
use reqwest::blocking::{Client, RequestBuilder, Response};
use serde_json::json;

use crate::engine::{Remote, SyncError};
use crate::manifest::Manifest;

/// Header that stops the server from echoing our own changes back over its event stream.
const CLIENT_HEADER: &str = "X-EmeraldMD-Client";

pub struct HttpRemote {
    client: Client,
    base: Url,
    vault: String,
    token: String,
    client_id: String,
}

fn remote_error(message: impl Into<String>) -> SyncError {
    SyncError::Remote(message.into())
}

impl HttpRemote {
    /// `base_url` is the server's address (e.g. `https://notes.example.com`),
    /// `client_id` identifies this device's event-stream connection, if any.
    pub fn new(base_url: &str, vault: &str, token: &str, client_id: &str) -> Result<Self, SyncError> {
        let base = Url::parse(base_url).map_err(|e| remote_error(format!("invalid server address {base_url:?}: {e}")))?;
        if base.cannot_be_a_base() {
            return Err(remote_error(format!("invalid server address {base_url:?}")));
        }
        let client = Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| remote_error(e.to_string()))?;
        Ok(Self { client, base, vault: vault.to_owned(), token: token.to_owned(), client_id: client_id.to_owned() })
    }

    /// `endpoint` may have several segments (`events/ticket`).
    fn url(&self, endpoint: &str) -> Url {
        let mut url = self.base.clone();
        url.path_segments_mut()
            .expect("checked in new")
            .pop_if_empty()
            .extend(["api", "vaults", self.vault.as_str()])
            .extend(endpoint.split('/'));
        url
    }

    fn send(&self, request: RequestBuilder) -> Result<Response, SyncError> {
        let response = request
            .bearer_auth(&self.token)
            .header(CLIENT_HEADER, &self.client_id)
            .send()
            .map_err(|e| remote_error(e.to_string()))?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let detail = response
            .json::<serde_json::Value>()
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned))
            .unwrap_or_default();
        Err(remote_error(format!("{status} {detail}").trim().to_owned()))
    }
}

impl HttpRemote {
    /// A one-time ticket that opens the vault's event stream.
    pub(crate) fn events_ticket(&self) -> Result<String, SyncError> {
        #[derive(serde::Deserialize)]
        struct Ticket {
            ticket: String,
        }
        let response = self.send(self.client.post(self.url("events/ticket")))?;
        Ok(response.json::<Ticket>().map_err(|e| remote_error(e.to_string()))?.ticket)
    }

    /// The event stream's WebSocket address for `ticket`, leaving out this client's own changes.
    pub(crate) fn events_url(&self, ticket: &str) -> Url {
        let mut url = self.url("events");
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme).expect("http(s) and ws(s) are interchangeable");
        url.query_pairs_mut().append_pair("ticket", ticket).append_pair("client", &self.client_id);
        url
    }
}

impl Remote for HttpRemote {
    fn manifest(&mut self) -> Result<Manifest, SyncError> {
        self.send(self.client.get(self.url("manifest")))?.json().map_err(|e| remote_error(e.to_string()))
    }

    fn read(&mut self, path: &str) -> Result<Vec<u8>, SyncError> {
        let response = self.send(self.client.get(self.url("raw")).query(&[("path", path)]))?;
        Ok(response.bytes().map_err(|e| remote_error(e.to_string()))?.to_vec())
    }

    fn write(&mut self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        self.send(self.client.put(self.url("raw")).query(&[("path", path)]).body(data.to_vec()))?;
        Ok(())
    }

    fn trash(&mut self, path: &str) -> Result<(), SyncError> {
        self.send(self.client.post(self.url("trash")).json(&json!({ "path": path })))?;
        Ok(())
    }
}
