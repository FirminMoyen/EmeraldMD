//! `emeraldmd-server`: serve vaults, or create and hash access tokens.

use std::io::{BufRead, IsTerminal};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use emerald_server::Server;
use emerald_server::auth::{hash_token, new_token};
use emerald_server::config::Config;
use tracing_subscriber::EnvFilter;

const USAGE: &str = "\
emeraldmd-server: serve EmeraldMD vaults to the EmeraldMD app

Usage:
  emeraldmd-server [serve] [--config FILE]   Serve the configured vaults
  emeraldmd-server token new                 Print a new random token and its hash
  emeraldmd-server token hash                Read a token from stdin and print its hash

The config file can also be given with EMERALDMD_CONFIG. Environment variables
EMERALDMD_BIND, EMERALDMD_VAULTS, EMERALDMD_TOKEN_HASHES and
EMERALDMD_ALLOWED_ORIGINS add to it; see docs/self-hosting.md. Log verbosity
follows RUST_LOG (default: info).";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = match args.as_slice() {
        ["-h" | "--help" | "help", ..] => {
            println!("{USAGE}");
            Ok(())
        }
        ["-V" | "--version"] => {
            println!("emeraldmd-server {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        ["token", "new"] => {
            let token = new_token();
            println!("token: {token}\nhash:  {}", hash_token(&token));
            eprintln!("\nGive the token to the app and put only the hash in the server config.");
            Ok(())
        }
        ["token", "hash"] => read_token().map(|token| println!("{}", hash_token(&token))),
        [] | ["serve"] => serve(None),
        ["--config", file] | ["serve", "--config", file] => serve(Some(PathBuf::from(file))),
        _ => Err(format!("unknown arguments: {}\n\n{USAGE}", args.join(" "))),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::FAILURE
        }
    }
}

fn read_token() -> Result<String, String> {
    if std::io::stdin().is_terminal() {
        eprintln!("Paste the token and press Enter:");
    }
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line).map_err(|e| e.to_string())?;
    let token = line.trim();
    if token.is_empty() {
        return Err("no token on stdin".into());
    }
    Ok(token.to_owned())
}

fn serve(config_file: Option<PathBuf>) -> Result<(), String> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        // No color codes in `docker logs` or journald.
        .with_ansi(std::io::stdout().is_terminal())
        .init();
    let config_file = config_file.or_else(|| std::env::var_os("EMERALDMD_CONFIG").map(PathBuf::from));
    let config = Config::load(config_file.as_deref(), |key| std::env::var(key).ok()).map_err(|e| e.to_string())?;
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    runtime.block_on(async {
        let server = Server::new(&config)?;
        let listener = tokio::net::TcpListener::bind(config.bind).await.map_err(|e| format!("cannot listen on {}: {e}", config.bind))?;
        tracing::info!("listening on http://{}", config.bind);
        server.serve(listener, shutdown_signal()).await.map_err(|e| e.to_string())?;
        // Lets the event streams send their close frames.
        tokio::time::sleep(Duration::from_millis(200)).await;
        tracing::info!("stopped");
        Ok(())
    })
}

/// Ctrl-C, or SIGTERM from `docker stop` and service managers.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}
