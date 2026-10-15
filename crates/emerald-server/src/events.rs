//! `GET /api/vaults/{id}/events`: a WebSocket that pushes every change to the
//! vault as `{"type":"update","version":n,"update":VaultUpdate}`, or
//! `{"type":"resync"}` when the client has to reload the snapshot.
//!
//! Query parameters: `epoch` and `since` (from the snapshot) to receive what
//! happened after it, and `client` (the id the client sends as
//! `X-EmeraldMD-Client`) to leave out its own changes.

use std::sync::Arc;
use std::time::Duration;

use axum::Extension;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade, close_code};
use axum::extract::{Path, Query, State};
use axum::response::Response;
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;

use crate::AppState;
use crate::api::ApiError;
use crate::auth::Principal;
use crate::vaults::{Event, SharedVault, StreamMessage};

/// Keeps idle connections alive through proxies, which often drop them after 60 s.
const PING_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
pub struct StreamParams {
    epoch: Option<String>,
    since: Option<u64>,
    client: Option<String>,
}

pub async fn stream(
    State(state): State<AppState>,
    Extension(principal): Extension<Arc<Principal>>,
    Path(id): Path<String>,
    Query(params): Query<StreamParams>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let vault = state.vault(&principal, &id)?;
    let shutdown = state.shutdown.clone();
    tracing::debug!(vault = %id, token = %principal.name, "event stream opened");
    Ok(ws.on_upgrade(move |socket| run(socket, vault, params, shutdown)))
}

async fn run(mut socket: WebSocket, vault: Arc<SharedVault>, params: StreamParams, mut shutdown: tokio::sync::watch::Receiver<bool>) {
    let since = match (&params.epoch, params.since) {
        (Some(epoch), Some(version)) => Some((epoch.as_str(), version)),
        _ => None,
    };
    let subscription = vault.subscribe(since);
    let client = params.client.as_deref();
    let Ok(backlog) = subscription.backlog else {
        return resync(socket).await;
    };
    for event in backlog {
        if !send(&mut socket, &event, client).await {
            return;
        }
    }
    let mut live = subscription.live;
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await;
    loop {
        tokio::select! {
            received = live.recv() => match received {
                Ok(event) => {
                    if !send(&mut socket, &event, client).await {
                        return;
                    }
                }
                // Fell too far behind: the client reloads instead.
                Err(RecvError::Lagged(_)) => return resync(socket).await,
                Err(RecvError::Closed) => return,
            },
            incoming = socket.recv() => match incoming {
                // Clients have nothing to say; pings are answered by axum.
                Some(Ok(Message::Close(_)) | Err(_)) | None => return,
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => {
                if socket.send(Message::Ping(Default::default())).await.is_err() {
                    return;
                }
            }
            _ = shutdown.changed() => {
                let frame = CloseFrame { code: close_code::AWAY, reason: "server shutting down".into() };
                let _ = socket.send(Message::Close(Some(frame))).await;
                return;
            }
        }
    }
}

/// Sends an event unless it came from this client. False if the socket is gone.
async fn send(socket: &mut WebSocket, event: &Event, client: Option<&str>) -> bool {
    if client.is_some() && event.origin.as_deref() == client {
        return true;
    }
    socket.send(Message::Text(event.message.clone())).await.is_ok()
}

async fn resync(mut socket: WebSocket) {
    let message = serde_json::to_string(&StreamMessage::Resync).expect("serializes");
    let _ = socket.send(Message::Text(message.into())).await;
    let _ = socket.send(Message::Close(Some(CloseFrame { code: close_code::NORMAL, reason: "resync".into() }))).await;
}
