//! EmeraldMD server: serves vault folders to EmeraldMD clients over HTTP, with
//! a WebSocket that pushes changes. All vault logic is `emerald_core`'s
//! `VaultSession`, the same code the desktop app runs locally.

pub mod api;
pub mod auth;
pub mod config;
mod events;
pub mod vaults;

use std::collections::HashMap;
use std::sync::Arc;

use tokio::net::TcpListener;

use crate::auth::Authenticator;
use crate::config::Config;
use crate::vaults::SharedVault;

pub use api::router;

#[derive(Clone)]
pub struct AppState {
    pub(crate) vaults: Arc<HashMap<String, Arc<SharedVault>>>,
    pub(crate) auth: Arc<Authenticator>,
    pub(crate) origins: Arc<Vec<String>>,
    pub(crate) max_body_bytes: usize,
    pub(crate) shutdown: tokio::sync::watch::Receiver<bool>,
}

/// A running server's state, and the switch that closes its event streams.
pub struct Server {
    pub state: AppState,
    shutdown: tokio::sync::watch::Sender<bool>,
}

impl Server {
    /// Opens and indexes every configured vault and starts watching them.
    pub fn new(config: &Config) -> Result<Self, String> {
        config.validate().map_err(|e| e.to_string())?;
        let epoch = auth::random_hex(8);
        let mut vaults = HashMap::new();
        for vault in &config.vaults {
            let shared = SharedVault::open(vault, &epoch)?;
            tracing::info!(id = %vault.id, path = %vault.path.display(), "serving vault");
            vaults.insert(vault.id.clone(), shared);
        }
        let (shutdown, shutdown_rx) = tokio::sync::watch::channel(false);
        let state = AppState {
            vaults: Arc::new(vaults),
            auth: Arc::new(Authenticator::new(&config.tokens)),
            origins: Arc::new(config.origins()),
            max_body_bytes: config.max_body_mb * 1024 * 1024,
            shutdown: shutdown_rx,
        };
        Ok(Self { state, shutdown })
    }

    /// Serves until `stop` resolves, then closes the event streams.
    pub async fn serve(self, listener: TcpListener, stop: impl Future<Output = ()> + Send + 'static) -> std::io::Result<()> {
        let app = router(self.state.clone());
        let shutdown = self.shutdown;
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                stop.await;
                let _ = shutdown.send(true);
            })
            .await
    }
}
