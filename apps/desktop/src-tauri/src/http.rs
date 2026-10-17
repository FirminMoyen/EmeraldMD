//! `requestUrl` for plugins: HTTP requests made from Rust, so they are not
//! subject to the webview's CORS rules (plugins expect this). Bodies cross
//! the IPC boundary as base64.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    url: String,
    method: Option<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
    content_type: Option<String>,
    /// Base64-encoded request body.
    body: Option<String>,
}

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    /// Base64-encoded response body.
    body: String,
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("EmeraldMD/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| client))
}

pub async fn send(request: HttpRequest) -> Result<HttpResponse, String> {
    let url = reqwest::Url::parse(&request.url).map_err(|e| format!("invalid URL {}: {e}", request.url))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("only http and https URLs are supported: {url}"));
    }
    let method = request.method.as_deref().unwrap_or("GET").to_uppercase();
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut builder = client()?.request(method, url);
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    if let Some(content_type) = &request.content_type {
        builder = builder.header(reqwest::header::CONTENT_TYPE, content_type);
    }
    if let Some(body) = &request.body {
        builder = builder.body(BASE64.decode(body).map_err(|e| format!("invalid request body: {e}"))?);
    }
    let response = builder.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let mut headers = HashMap::new();
    for (name, value) in response.headers() {
        let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
        headers
            .entry(name.as_str().to_owned())
            .and_modify(|v: &mut String| {
                v.push_str(", ");
                v.push_str(&value);
            })
            .or_insert(value);
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    Ok(HttpResponse { status, headers, body: BASE64.encode(bytes) })
}
