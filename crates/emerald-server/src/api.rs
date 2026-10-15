//! HTTP routes. Every mutation answers with the same `VaultUpdate` JSON that
//! the desktop app's Tauri commands return, so clients apply it the same way.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE, WWW_AUTHENTICATE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use emerald_core::{VaultError, VaultSession, VaultUpdate};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::AppState;
use crate::auth::{Principal, TICKET_TTL};
use crate::events;
use crate::vaults::SharedVault;

/// Identifies the client making a change, so its own changes are not pushed
/// back to it over the event stream.
pub const CLIENT_HEADER: HeaderName = HeaderName::from_static("x-emeraldmd-client");

pub fn router(state: AppState) -> Router {
    let origins: Vec<HeaderValue> = state.origins.iter().filter_map(|o| HeaderValue::from_str(o).ok()).collect();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::PUT, Method::POST])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE, CLIENT_HEADER])
        .max_age(std::time::Duration::from_secs(600));
    let body_limit = state.max_body_bytes;

    Router::new()
        .route("/api/vaults", get(list_vaults))
        .route("/api/vaults/{id}/snapshot", get(snapshot))
        .route("/api/vaults/{id}/files", get(read_file).put(write_file).post(create_file))
        .route("/api/vaults/{id}/raw", get(read_raw).put(write_raw))
        .route("/api/vaults/{id}/manifest", get(manifest))
        .route("/api/vaults/{id}/folders", post(create_folder))
        .route("/api/vaults/{id}/rename", post(rename))
        .route("/api/vaults/{id}/trash", post(trash))
        .route("/api/vaults/{id}/events/ticket", post(events_ticket))
        .route("/api/vaults/{id}/events", get(events::stream))
        // Applies to every route and to unknown paths alike.
        .layer(middleware::from_fn_with_state(state.clone(), authenticate))
        .layer(DefaultBodyLimit::max(body_limit))
        .layer(TraceLayer::new_for_http())
        // Outermost: preflight requests carry no credentials and are answered here.
        .layer(cors)
        .with_state(state)
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }

    fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "missing or invalid token")
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
            VaultError::OutsideVault(_) | VaultError::NotAFolder(_) => StatusCode::BAD_REQUEST,
            VaultError::Io(io) => match io.kind() {
                std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
                std::io::ErrorKind::InvalidData => StatusCode::UNPROCESSABLE_ENTITY,
                std::io::ErrorKind::IsADirectory | std::io::ErrorKind::NotADirectory => StatusCode::BAD_REQUEST,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            },
        };
        Self::new(status, err.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (self.status, Json(json!({ "error": self.message }))).into_response();
        if self.status == StatusCode::UNAUTHORIZED {
            response.headers_mut().insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        }
        response
    }
}

type ApiResult<T> = Result<T, ApiError>;

/// Requires `Authorization: Bearer <token>` on every request. The event
/// stream also accepts `?ticket=` because browsers cannot set headers on a
/// WebSocket.
async fn authenticate(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    let bearer = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
        .map(|t| t.trim().to_owned());
    let principal = match bearer {
        Some(token) if !token.is_empty() => state.auth.verify(&token).await,
        _ if request.uri().path().ends_with("/events") => ticket_param(request.uri()).and_then(|t| state.auth.redeem_ticket(&t)),
        _ => None,
    };
    match principal {
        Some(principal) => {
            request.extensions_mut().insert(principal);
            next.run(request).await
        }
        None => ApiError::unauthorized().into_response(),
    }
}

#[derive(Deserialize)]
struct TicketParam {
    ticket: String,
}

fn ticket_param(uri: &axum::http::Uri) -> Option<String> {
    Query::<TicketParam>::try_from_uri(uri).ok().map(|q| q.0.ticket)
}

impl AppState {
    pub(crate) fn vault(&self, principal: &Principal, id: &str) -> ApiResult<Arc<SharedVault>> {
        // Vaults a token cannot open look the same as vaults that do not exist.
        if !principal.can_open(id) {
            return Err(ApiError::unknown_vault(id));
        }
        self.vaults.get(id).cloned().ok_or_else(|| ApiError::unknown_vault(id))
    }
}

/// Runs blocking vault I/O off the async workers.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> emerald_core::vault::Result<T> + Send + 'static) -> ApiResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, format!("task failed: {e}")))?
        .map_err(ApiError::from)
}

fn origin(headers: &HeaderMap) -> Option<String> {
    headers.get(CLIENT_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

async fn mutate(
    vault: Arc<SharedVault>,
    headers: &HeaderMap,
    f: impl FnOnce(&mut VaultSession) -> emerald_core::vault::Result<VaultUpdate> + Send + 'static,
) -> ApiResult<Json<VaultUpdate>> {
    let origin = origin(headers);
    blocking(move || vault.mutate(origin, f)).await.map(Json)
}

#[derive(Serialize)]
struct VaultInfo {
    id: String,
    name: String,
}

async fn list_vaults(State(state): State<AppState>, Extension(principal): Extension<Arc<Principal>>) -> Json<Vec<VaultInfo>> {
    let mut vaults: Vec<VaultInfo> = state
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
    let snapshot = tokio::task::spawn_blocking(move || vault.snapshot())
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, format!("task failed: {e}")))?;
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
    mutate(vault, &headers, move |s| s.write(&query.path, &data)).await
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
    mutate(vault, &headers, move |s| s.write_bytes(&query.path, &data)).await
}

/// Every visible file with its SHA-256, so sync clients can tell what changed.
async fn manifest(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
) -> ApiResult<Json<emerald_sync::Manifest>> {
    let vault = state.vault(&principal, &id)?;
    blocking(move || vault.manifest()).await.map(Json)
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
    mutate(vault, &headers, move |s| s.create(&body.path, &body.data)).await
}

#[derive(Deserialize)]
struct PathBody {
    path: String,
}

async fn create_folder(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PathBody>,
) -> ApiResult<Json<VaultUpdate>> {
    let vault = state.vault(&principal, &id)?;
    mutate(vault, &headers, move |s| s.create_folder(&body.path)).await
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
    mutate(vault, &headers, move |s| s.rename(&body.from, &body.to)).await
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
    mutate(vault, &headers, move |s| s.trash(&body.path)).await
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
    let ticket = state.auth.issue_ticket(&principal, &vault.id);
    Ok(Json(TicketResponse { ticket, expires_in_secs: TICKET_TTL.as_secs() }))
}
