//! HTTP routes. Every mutation answers with the same `VaultUpdate` JSON that
//! the desktop app's Tauri commands return, so clients apply it the same way.
//!
//! Every route but `/healthz` needs a token. Errors are `{"error": message}`
//! JSON, with no server paths or internal details in them, and every
//! response carries security headers.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request, State};
use axum::http::header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, RETRY_AFTER, WWW_AUTHENTICATE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use emerald_core::{VaultError, VaultSession, VaultUpdate};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;

use crate::AppState;
use crate::auth::{Principal, TICKET_TTL, Verdict};
use crate::events;
use crate::net::client_ip;
use crate::paths;
use crate::vaults::SharedVault;

/// Identifies the client making a change, so its own changes are not pushed
/// back to it over the event stream.
pub const CLIENT_HEADER: HeaderName = HeaderName::from_static("x-emeraldmd-client");

/// Unauthenticated liveness check for Docker and reverse proxies.
pub const HEALTH_PATH: &str = "/healthz";

/// Bodies of requests that only carry paths (folders, rename, trash).
const SMALL_BODY: usize = 64 * 1024;

/// Sent with every response. The API serves user files and JSON, never pages:
/// nothing may be sniffed, framed, cached or run as a document.
const SECURITY_HEADERS: [(&str, &str); 5] = [
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "DENY"),
    ("referrer-policy", "no-referrer"),
    ("content-security-policy", "default-src 'none'; frame-ancestors 'none'; sandbox"),
    ("cross-origin-resource-policy", "same-origin"),
];

pub fn router(state: AppState) -> Router {
    // Read on every request, so a reload can change the allowed origins.
    let origins = state.clone();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin, _| {
            origin.to_str().is_ok_and(|origin| origins.live().origins.iter().any(|allowed| allowed == origin))
        }))
        .allow_methods([Method::GET, Method::PUT, Method::POST])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE, CLIENT_HEADER])
        .max_age(Duration::from_secs(600));
    let body_limit = state.max_body_bytes;
    // Refuses larger declared bodies up front, whether or not the route reads its body.
    let small = || RequestBodyLimitLayer::new(SMALL_BODY);

    Router::new()
        .route(HEALTH_PATH, get(healthz))
        .route("/api/vaults", get(list_vaults))
        .route("/api/vaults/{id}/snapshot", get(snapshot))
        .route("/api/vaults/{id}/files", get(read_file).put(write_file).post(create_file))
        .route("/api/vaults/{id}/raw", get(read_raw).put(write_raw))
        .route("/api/vaults/{id}/manifest", get(manifest))
        .route("/api/vaults/{id}/search", get(search))
        .route("/api/vaults/{id}/folders", post(create_folder).layer(small()))
        .route("/api/vaults/{id}/rename", post(rename).layer(small()))
        .route("/api/vaults/{id}/trash", post(trash).layer(small()))
        .route("/api/vaults/{id}/config/list", get(config_list))
        .route("/api/vaults/{id}/config/stat", get(config_stat))
        .route("/api/vaults/{id}/config/file", axum::routing::put(config_write))
        .route("/api/vaults/{id}/config/folders", post(config_folder).layer(small()))
        .route("/api/vaults/{id}/config/trash", post(config_trash).layer(small()))
        .route("/api/vaults/{id}/history", get(history_versions))
        .route("/api/vaults/{id}/history/raw", get(history_raw))
        .route("/api/vaults/{id}/history/deleted", get(history_deleted))
        .route("/api/vaults/{id}/events/ticket", post(events_ticket).layer(small()))
        .route("/api/vaults/{id}/events", get(events::stream))
        // Applies to every route and to unknown paths alike.
        .layer(middleware::from_fn_with_state(state.clone(), authenticate))
        // Bodies are buffered by the extractors up to this size; larger
        // declared bodies are refused before anything is read.
        .layer(DefaultBodyLimit::max(body_limit))
        .layer(RequestBodyLimitLayer::new(body_limit))
        // Method and path only: queries hold vault paths and event tickets.
        .layer(TraceLayer::new_for_http().make_span_with(|request: &Request| {
            tracing::info_span!("request", method = %request.method(), path = %request.uri().path())
        }))
        .layer(CatchPanicLayer::custom(|_| ApiError::internal().into_response()))
        // Preflight requests carry no credentials and are answered here.
        .layer(cors)
        // Outermost, so that every response passes through it.
        .layer(middleware::from_fn(finish_response))
        .with_state(state)
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
    retry_after: Option<Duration>,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self { status, message: message.into(), retry_after: None }
    }

    fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "missing or invalid token")
    }

    /// Details go to the log, never to the client.
    fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
    }

    pub(crate) fn too_many(message: &str, retry_after: Duration) -> Self {
        Self { retry_after: Some(retry_after), ..Self::new(StatusCode::TOO_MANY_REQUESTS, message) }
    }

    fn unknown_vault(id: &str) -> Self {
        Self::new(StatusCode::NOT_FOUND, format!("unknown vault: {id}"))
    }
}

impl From<VaultError> for ApiError {
    fn from(err: VaultError) -> Self {
        let status = match &err {
            VaultError::NotFound(_) => StatusCode::NOT_FOUND,
            VaultError::AlreadyExists(_) => StatusCode::CONFLICT,
            VaultError::OutsideVault(_) | VaultError::NotConfigPath(_) => StatusCode::BAD_REQUEST,
            // Only raised for the vault folder itself, whose path stays on the server.
            VaultError::NotAFolder(_) => return Self::new(StatusCode::BAD_REQUEST, "not a folder"),
            VaultError::Io(io) => match io.kind() {
                std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
                std::io::ErrorKind::InvalidData => StatusCode::UNPROCESSABLE_ENTITY,
                // e.g. a NUL byte in a path
                std::io::ErrorKind::InvalidInput
                | std::io::ErrorKind::InvalidFilename
                | std::io::ErrorKind::IsADirectory
                | std::io::ErrorKind::NotADirectory
                | std::io::ErrorKind::DirectoryNotEmpty => StatusCode::BAD_REQUEST,
                _ => {
                    tracing::error!("vault I/O failed: {err}");
                    return Self::internal();
                }
            },
        };
        // Vault paths only, as the client sent them; never server paths.
        Self::new(status, err.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (self.status, Json(json!({ "error": self.message }))).into_response();
        if self.status == StatusCode::UNAUTHORIZED {
            response.headers_mut().insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        }
        if let Some(wait) = self.retry_after {
            let secs = wait.as_secs_f64().ceil().max(1.0) as u64;
            response.headers_mut().insert(RETRY_AFTER, HeaderValue::from(secs));
        }
        response
    }
}

type ApiResult<T> = Result<T, ApiError>;

/// Adds the security headers, and turns the plain-text errors of axum's
/// extractors, fallbacks and limits into `{"error": …}` JSON.
async fn finish_response(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let status = response.status();
    if status == StatusCode::SWITCHING_PROTOCOLS {
        return response;
    }
    let is_json = response.headers().get(CONTENT_TYPE).is_some_and(|v| v.as_bytes().starts_with(b"application/json"));
    if (status.is_client_error() || status.is_server_error()) && !is_json {
        let (mut parts, body) = response.into_parts();
        let message = if status.is_server_error() {
            "internal server error".to_owned()
        } else {
            let bytes = axum::body::to_bytes(body, 4096).await.unwrap_or_default();
            let text = String::from_utf8_lossy(&bytes).trim().to_owned();
            if text.is_empty() { status.canonical_reason().unwrap_or("error").to_lowercase() } else { text }
        };
        parts.headers.remove(CONTENT_LENGTH);
        parts.headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        response = Response::from_parts(parts, Body::from(json!({ "error": message }).to_string()));
    }
    let headers = response.headers_mut();
    for (name, value) in SECURITY_HEADERS {
        headers.entry(name).or_insert(HeaderValue::from_static(value));
    }
    // Notes are private: no proxy or browser cache may keep them.
    headers.entry(CACHE_CONTROL).or_insert(HeaderValue::from_static("no-store"));
    response
}

async fn healthz() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}

/// Requires `Authorization: Bearer <token>` on every request but the health
/// check. The event stream also accepts `?ticket=` because browsers cannot
/// set headers on a WebSocket.
///
/// Credentials that need checking (a token not verified before, or a ticket)
/// are rate-limited per client address; see [`crate::limits::FailureLimiter`].
async fn authenticate(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    if request.uri().path() == HEALTH_PATH {
        return next.run(request).await;
    }
    let live = state.live();
    let peer = request.extensions().get::<ConnectInfo<SocketAddr>>().map_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED), |c| c.0.ip());
    let ip = client_ip(peer, request.headers(), &live.trusted_proxies);
    let bearer = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty());
    let principal = match bearer {
        Some(token) => match live.auth.cached(&token) {
            Some(principal) => Ok(principal),
            None => limited(&state, ip, live.auth.verify(&token)).await,
        },
        None => match ticket_param(&request) {
            Some(ticket) => {
                let redeem = async {
                    match state.tickets.redeem(&ticket) {
                        // The token behind it may have been revoked since.
                        Some((principal, vault)) if live.auth.allows(&principal.key, &vault) => Verdict::Valid(principal),
                        _ => Verdict::Invalid,
                    }
                };
                limited(&state, ip, redeem).await
            }
            None => Err(ApiError::unauthorized()),
        },
    };
    match principal {
        Ok(principal) => {
            request.extensions_mut().insert(principal);
            next.run(request).await
        }
        Err(err) => err.into_response(),
    }
}

/// Checks a credential if `ip` has tries left, and counts it if it was wrong.
async fn limited(state: &AppState, ip: IpAddr, verify: impl Future<Output = Verdict>) -> ApiResult<Arc<Principal>> {
    if let Err(wait) = state.failures.try_acquire(ip) {
        tracing::debug!(%ip, "too many failed authentication attempts");
        return Err(ApiError::too_many("too many failed authentication attempts; try again later", wait));
    }
    match verify.await {
        Verdict::Valid(principal) => {
            state.failures.refund(ip);
            Ok(principal)
        }
        Verdict::Invalid => {
            tracing::warn!(%ip, "rejected an invalid token or ticket");
            Err(ApiError::unauthorized())
        }
        Verdict::Busy => {
            state.failures.refund(ip);
            let mut err = ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "too many logins at once; try again shortly");
            err.retry_after = Some(Duration::from_secs(1));
            Err(err)
        }
    }
}

#[derive(Deserialize)]
struct TicketParam {
    ticket: String,
}

fn ticket_param(request: &Request) -> Option<String> {
    if !request.uri().path().ends_with("/events") {
        return None;
    }
    Query::<TicketParam>::try_from_uri(request.uri()).ok().map(|q| q.0.ticket)
}

impl AppState {
    pub(crate) fn vault(&self, principal: &Principal, id: &str) -> ApiResult<Arc<SharedVault>> {
        // Vaults a token cannot open look the same as vaults that do not exist.
        if !principal.can_open(id) {
            return Err(ApiError::unknown_vault(id));
        }
        self.live().vaults.get(id).cloned().ok_or_else(|| ApiError::unknown_vault(id))
    }
}

/// Runs blocking vault I/O off the async workers.
async fn blocking<T: Send + 'static, E: Into<ApiError> + Send + 'static>(f: impl FnOnce() -> Result<T, E> + Send + 'static) -> ApiResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| {
            tracing::error!("vault task failed: {e}");
            ApiError::internal()
        })?
        .map_err(Into::into)
}

fn origin(headers: &HeaderMap) -> Option<String> {
    headers.get(CLIENT_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

/// Runs a change; `changes` are the paths it changes or deletes (see [`SharedVault::mutate`]).
async fn mutate(
    vault: Arc<SharedVault>,
    headers: &HeaderMap,
    changes: Vec<String>,
    f: impl FnOnce(&mut VaultSession) -> emerald_core::vault::Result<VaultUpdate> + Send + 'static,
) -> ApiResult<Json<VaultUpdate>> {
    let origin = origin(headers);
    blocking(move || {
        let changes: Vec<&str> = changes.iter().map(String::as_str).collect();
        vault.mutate(origin, &changes, f)
    })
    .await
    .map(Json)
}

#[derive(Serialize)]
struct VaultInfo {
    id: String,
    name: String,
}

async fn list_vaults(State(state): State<AppState>, Extension(principal): Extension<Arc<Principal>>) -> Json<Vec<VaultInfo>> {
    let mut vaults: Vec<VaultInfo> = state
        .live()
        .vaults
        .values()
        .filter(|v| principal.can_open(&v.id))
        .map(|v| VaultInfo { id: v.id.clone(), name: v.name.clone() })
        .collect();
    vaults.sort_by(|a, b| a.id.cmp(&b.id));
    Json(vaults)
}

async fn snapshot(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let vault = state.vault(&principal, &id)?;
    let snapshot = blocking(move || Ok::<_, ApiError>(vault.snapshot())).await?;
    Ok(Json(snapshot).into_response())
}

#[derive(Deserialize)]
struct PathQuery {
    path: String,
}

async fn read_file(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    Query(query): Query<PathQuery>,
) -> ApiResult<Response> {
    let vault = state.vault(&principal, &id)?;
    let text = blocking(move || vault.read(&query.path)).await?;
    Ok(([(CONTENT_TYPE, "text/plain; charset=utf-8")], text).into_response())
}

/// The body is the file's new content, as UTF-8 text.
async fn write_file(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    Query(query): Query<PathQuery>,
    headers: HeaderMap,
    data: String,
) -> ApiResult<Json<VaultUpdate>> {
    let vault = state.vault(&principal, &id)?;
    mutate(vault, &headers, vec![query.path.clone()], move |s| {
        paths::check_writable(s.vault(), &[&query.path])?;
        s.write(&query.path, &data)
    })
    .await
}

/// Any file's bytes, attachments included (used by sync clients).
async fn read_raw(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    Query(query): Query<PathQuery>,
) -> ApiResult<Response> {
    let vault = state.vault(&principal, &id)?;
    let data = blocking(move || vault.read_bytes(&query.path)).await?;
    Ok(([(CONTENT_TYPE, "application/octet-stream")], data).into_response())
}

/// Writes any file from the raw request body. Markdown must be UTF-8.
async fn write_raw(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    Query(query): Query<PathQuery>,
    headers: HeaderMap,
    data: Bytes,
) -> ApiResult<Json<VaultUpdate>> {
    let vault = state.vault(&principal, &id)?;
    mutate(vault, &headers, vec![query.path.clone()], move |s| {
        paths::check_writable(s.vault(), &[&query.path])?;
        s.write_bytes(&query.path, &data)
    })
    .await
}

impl From<crate::vaults::NoHistory> for ApiError {
    fn from(_: crate::vaults::NoHistory) -> Self {
        Self::new(StatusCode::NOT_FOUND, "version history is off on this server")
    }
}

/// A file's earlier versions, newest first: `{"versions": [{"time", "size"}]}`.
async fn history_versions(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    Query(query): Query<PathQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let vault = state.vault(&principal, &id)?;
    let versions = blocking(move || vault.versions(&query.path).map_err(ApiError::from)?.map_err(ApiError::from)).await?;
    Ok(Json(json!({ "versions": versions })))
}

#[derive(Deserialize)]
struct VersionQuery {
    path: String,
    time: u64,
}

/// The bytes of one version of a file.
async fn history_raw(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    Query(query): Query<VersionQuery>,
) -> ApiResult<Response> {
    let vault = state.vault(&principal, &id)?;
    let data = blocking(move || vault.read_version(&query.path, query.time).map_err(ApiError::from)?.map_err(ApiError::from)).await?;
    Ok(([(CONTENT_TYPE, "application/octet-stream")], data).into_response())
}

/// Deleted files that still have versions: `[{"path", "deletedAt", "size"}]`.
async fn history_deleted(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<crate::history::DeletedFile>>> {
    let vault = state.vault(&principal, &id)?;
    blocking(move || vault.deleted_files().map_err(ApiError::from)).await.map(Json)
}

#[derive(Deserialize)]
struct ManifestQuery {
    /// Also list the config folder (`.obsidian`), for clients that sync settings.
    #[serde(default)]
    config: bool,
}

/// Every visible file with its SHA-256, so sync clients can tell what changed.
/// With `?config=true`, also the config folder's files (except
/// `workspace.json`), which the response confirms with a header.
async fn manifest(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    Query(query): Query<ManifestQuery>,
) -> ApiResult<Response> {
    let vault = state.vault(&principal, &id)?;
    let config = query.config;
    let manifest = blocking(move || vault.manifest(config)).await?;
    let mut response = Json(manifest).into_response();
    if config {
        response.headers_mut().insert(emerald_sync::MANIFEST_CONFIG_HEADER, axum::http::HeaderValue::from_static("1"));
    }
    Ok(response)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchQuery {
    q: String,
    #[serde(default)]
    case_sensitive: bool,
    sort: Option<emerald_core::SearchSort>,
    limit: Option<usize>,
}

/// Full-text search with Obsidian's query syntax (docs/search.md). Bad queries are 400s.
async fn search(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    Query(query): Query<SearchQuery>,
) -> ApiResult<Json<emerald_core::SearchResults>> {
    let vault = state.vault(&principal, &id)?;
    let options = emerald_core::SearchOptions {
        case_sensitive: query.case_sensitive,
        sort: query.sort.unwrap_or_default(),
        limit: query.limit,
    };
    blocking(move || vault.search(&query.q, &options).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string())))
        .await
        .map(Json)
}

#[derive(Deserialize)]
struct CreateFile {
    path: String,
    #[serde(default)]
    data: String,
}

async fn create_file(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<CreateFile>,
) -> ApiResult<Json<VaultUpdate>> {
    let vault = state.vault(&principal, &id)?;
    mutate(vault, &headers, Vec::new(), move |s| {
        paths::check_writable(s.vault(), &[&body.path])?;
        s.create(&body.path, &body.data)
    })
    .await
}

#[derive(Deserialize)]
struct PathBody {
    path: String,
}

/// `GET /config/list?path=.obsidian/…`: the files and folders of a config folder.
async fn config_list(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    Query(query): Query<PathQuery>,
) -> ApiResult<Json<emerald_core::ConfigListing>> {
    let vault = state.vault(&principal, &id)?;
    blocking(move || vault.list_config(&query.path)).await.map(Json)
}

/// `GET /config/stat?path=`: the entry, or `null` when there is none.
async fn config_stat(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    Query(query): Query<PathQuery>,
) -> ApiResult<Json<Option<emerald_core::FileEntry>>> {
    let vault = state.vault(&principal, &id)?;
    blocking(move || vault.config_entry(&query.path)).await.map(Json)
}

/// `PUT /config/file?path=`: writes a config file from the body (text, or
/// the bytes of a theme's or plugin's other files). Read it back with `GET /files` or `GET /raw`.
async fn config_write(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    Query(query): Query<PathQuery>,
    data: Bytes,
) -> ApiResult<StatusCode> {
    let vault = state.vault(&principal, &id)?;
    blocking(move || vault.write_config(&query.path, &data)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /config/folders` with `{"path": ".obsidian/…"}`: creates a config folder and its parents.
async fn config_folder(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    Json(body): Json<PathBody>,
) -> ApiResult<StatusCode> {
    let vault = state.vault(&principal, &id)?;
    blocking(move || vault.create_config_folder(&body.path)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /config/trash` with `{"path": ".obsidian/…"}`: moves a file or folder
/// of the config folder (a plugin's folder, to uninstall it; a settings file
/// deleted on another device) to the vault's `.trash`.
async fn config_trash(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    Json(body): Json<PathBody>,
) -> ApiResult<StatusCode> {
    let vault = state.vault(&principal, &id)?;
    blocking(move || vault.trash_config(&body.path)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn create_folder(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PathBody>,
) -> ApiResult<Json<VaultUpdate>> {
    let vault = state.vault(&principal, &id)?;
    mutate(vault, &headers, Vec::new(), move |s| {
        paths::check_writable(s.vault(), &[&body.path])?;
        s.create_folder(&body.path)
    })
    .await
}

#[derive(Deserialize)]
struct RenameBody {
    from: String,
    to: String,
}

async fn rename(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<RenameBody>,
) -> ApiResult<Json<VaultUpdate>> {
    let vault = state.vault(&principal, &id)?;
    mutate(vault, &headers, vec![body.from.clone(), body.to.clone()], move |s| {
        paths::check_writable(s.vault(), &[&body.from, &body.to])?;
        s.rename(&body.from, &body.to)
    })
    .await
}

/// Moves to the vault's `.trash` folder; nothing is deleted permanently.
async fn trash(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PathBody>,
) -> ApiResult<Json<VaultUpdate>> {
    let vault = state.vault(&principal, &id)?;
    mutate(vault, &headers, vec![body.path.clone()], move |s| {
        paths::check_trashable(s.vault(), &body.path)?;
        s.trash(&body.path)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TicketResponse {
    ticket: String,
    expires_in_secs: u64,
}

async fn events_ticket(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
) -> ApiResult<Json<TicketResponse>> {
    let vault = state.vault(&principal, &id)?;
    let ticket = state.tickets.issue(&principal, &vault.id).ok_or_else(|| ApiError::too_many("too many open tickets; try again later", TICKET_TTL))?;
    Ok(Json(TicketResponse { ticket, expires_in_secs: TICKET_TTL.as_secs() }))
}
