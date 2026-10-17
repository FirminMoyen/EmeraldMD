//! EmeraldMD server: serves vault folders to EmeraldMD clients over HTTP, with
//! a WebSocket that pushes changes. All vault logic is `emerald_core`'s
//! `VaultSession`, the same code the desktop app runs locally.

pub mod api;
pub mod auth;
pub mod config;
mod events;
pub mod limits;
pub mod net;
pub mod paths;
pub mod tokens;
pub mod vaults;

use std::collections::HashMap;
use std::fmt;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, RwLock};

use tokio::net::TcpListener;

use crate::auth::{Authenticator, Tickets};
use crate::config::Config;
use crate::limits::{FailureLimiter, StreamCounter};
use crate::net::IpNet;
use crate::vaults::SharedVault;

pub use api::router;

/// The part of the state that a config reload replaces.
pub(crate) struct Live {
    pub vaults: HashMap<String, Arc<SharedVault>>,
    pub auth: Arc<Authenticator>,
    pub origins: Vec<String>,
    pub trusted_proxies: Vec<IpNet>,
}

#[derive(Clone)]
pub struct AppState {
    live: Arc<RwLock<Arc<Live>>>,
    pub(crate) failures: Arc<FailureLimiter>,
    pub(crate) tickets: Arc<Tickets>,
    pub(crate) streams: Arc<StreamCounter>,
    pub(crate) max_body_bytes: usize,
    pub(crate) shutdown: tokio::sync::watch::Receiver<bool>,
    /// Bumped after every reload, so open event streams re-check their access.
    pub(crate) reloads: Arc<tokio::sync::watch::Sender<u64>>,
    reloading: Arc<Mutex<()>>,
}

/// What a reload changed, for the log.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReloadSummary {
    pub tokens: usize,
    pub vaults_added: Vec<String>,
    pub vaults_removed: Vec<String>,
    pub vaults_reopened: Vec<String>,
    /// Settings that only take effect after a restart.
    pub needs_restart: Vec<&'static str>,
}

impl fmt::Display for ReloadSummary {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} token(s)", self.tokens)?;
        for (label, ids) in [("added", &self.vaults_added), ("removed", &self.vaults_removed), ("reopened", &self.vaults_reopened)] {
            if !ids.is_empty() {
                write!(f, "; vaults {label}: {}", ids.join(", "))?;
            }
        }
        Ok(())
    }
}

fn live_from(config: &Config, vaults: HashMap<String, Arc<SharedVault>>) -> Live {
    Live {
        vaults,
        auth: Arc::new(Authenticator::new(&config.tokens)),
        origins: config.origins(),
        trusted_proxies: config.trusted_proxies(),
    }
}

impl AppState {
    pub(crate) fn live(&self) -> Arc<Live> {
        self.live.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Applies a new config without a restart: tokens, vaults, allowed
    /// origins and trusted proxies. Vaults whose entry is unchanged keep their
    /// index and event history; new or changed ones are opened (and indexed)
    /// before anything is switched, so a vault that fails to open leaves the
    /// old config in place. Tokens are replaced as a whole: revoked ones stop
    /// working at once (their cached verifications are dropped), and event
    /// streams whose token was revoked, or whose vault is gone, are closed.
    ///
    /// Blocking (it indexes new vaults); call it from a blocking thread.
    /// The listen address and `max_body_mb` need a restart.
    pub fn reload(&self, config: &Config) -> Result<ReloadSummary, String> {
        config.validate_entries().map_err(|e| e.to_string())?;
        let _reloading = self.reloading.lock().unwrap_or_else(|e| e.into_inner());
        let current = self.live();
        let mut summary = ReloadSummary { tokens: config.tokens.len(), ..ReloadSummary::default() };
        let mut vaults = HashMap::new();
        for vault in &config.vaults {
            let shared = match current.vaults.get(&vault.id) {
                Some(existing) if existing.config == *vault => existing.clone(),
                existing => {
                    let opened = SharedVault::open(vault)?;
                    if existing.is_some() {
                        summary.vaults_reopened.push(vault.id.clone());
                    } else {
                        summary.vaults_added.push(vault.id.clone());
                    }
                    opened
                }
            };
            vaults.insert(vault.id.clone(), shared);
        }
        let mut gone: Vec<Arc<SharedVault>> = Vec::new();
        for (id, old) in &current.vaults {
            match vaults.get(id) {
                Some(new) if Arc::ptr_eq(new, old) => {}
                Some(_) => gone.push(old.clone()),
                None => {
                    summary.vaults_removed.push(id.clone());
                    gone.push(old.clone());
                }
            }
        }
        if config.max_body_mb * 1024 * 1024 != self.max_body_bytes {
            summary.needs_restart.push("max_body_mb");
        }
        if config.max_streams_per_token != self.streams.max_per_token() {
            summary.needs_restart.push("max_streams_per_token");
        }
        summary.vaults_removed.sort();
        let live = live_from(config, vaults);
        live.auth.keep_verified(&current.auth);
        *self.live.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(live);
        for vault in gone {
            vault.close();
        }
        self.reloads.send_modify(|n| *n += 1);
        Ok(summary)
    }
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
        let mut vaults = HashMap::new();
        for vault in &config.vaults {
            let shared = SharedVault::open(vault)?;
            tracing::info!(id = %vault.id, path = %vault.path.display(), "serving vault");
            vaults.insert(vault.id.clone(), shared);
        }
        let (shutdown, shutdown_rx) = tokio::sync::watch::channel(false);
        let state = AppState {
            live: Arc::new(RwLock::new(Arc::new(live_from(config, vaults)))),
            failures: Arc::new(FailureLimiter::default()),
            tickets: Arc::new(Tickets::default()),
            streams: StreamCounter::new(config.max_streams_per_token),
            max_body_bytes: config.max_body_mb * 1024 * 1024,
            shutdown: shutdown_rx,
            reloads: Arc::new(tokio::sync::watch::channel(0).0),
            reloading: Arc::new(Mutex::new(())),
        };
        Ok(Self { state, shutdown })
    }

    /// Serves until `stop` resolves, then closes the event streams.
    pub async fn serve(self, listener: TcpListener, stop: impl Future<Output = ()> + Send + 'static) -> std::io::Result<()> {
        let app = router(self.state.clone());
        let shutdown = self.shutdown;
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async move {
                stop.await;
                let _ = shutdown.send(true);
            })
            .await
    }
}
