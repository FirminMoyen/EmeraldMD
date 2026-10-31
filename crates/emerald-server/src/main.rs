//! `emeraldmd-server`: serve vaults, manage access tokens, check health.

use std::io::{BufRead, IsTerminal, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use emerald_server::Server;
use emerald_server::auth::{hash_token, new_token};
use emerald_server::config::Config;
use emerald_server::tokens;
use tracing_subscriber::EnvFilter;

const USAGE: &str = "\
emeraldmd-server: serve EmeraldMD vaults to the EmeraldMD app

Usage:
  emeraldmd-server [serve]                       Serve the configured vaults
  emeraldmd-server token add NAME [--vault ID]... [--read-only]
                                                 Create a token, print it once, and add its
                                                 hash to the config file (all vaults unless
                                                 --vault is given; --read-only: it can only read)
  emeraldmd-server token list                    List tokens: names and vaults, never hashes
  emeraldmd-server token revoke NAME             Remove a token from the config file
  emeraldmd-server token new                     Print a new random token and its hash
  emeraldmd-server token hash                    Read a token from stdin and print its hash
  emeraldmd-server healthcheck [ADDRESS]         Exit 0 if the server answers on /healthz
                                                 (default: the configured address)

Every command reads the config file given with --config FILE or EMERALDMD_CONFIG.
Environment variables EMERALDMD_BIND, EMERALDMD_VAULTS, EMERALDMD_TOKEN_HASHES,
EMERALDMD_ALLOWED_ORIGINS and EMERALDMD_TRUSTED_PROXIES add to it; see
docs/self-hosting.md. Log verbosity follows RUST_LOG (default: info).

A running server reloads its tokens, vaults, allowed origins and trusted
proxies when it receives SIGHUP (`kill -HUP <pid>`, `docker kill -s HUP <name>`).";

struct Args {
    config: Option<PathBuf>,
    vaults: Vec<String>,
    read_only: bool,
    words: Vec<String>,
}

fn parse_args(raw: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut args = Args { config: None, vaults: Vec::new(), read_only: false, words: Vec::new() };
    let mut raw = raw.peekable();
    while let Some(arg) = raw.next() {
        let mut value = |flag: &str| match arg.strip_prefix(&format!("{flag}=")) {
            Some(value) => Ok(value.to_owned()),
            None => raw.next().ok_or_else(|| format!("{flag} needs a value")),
        };
        if arg == "--config" || arg.starts_with("--config=") {
            args.config = Some(PathBuf::from(value("--config")?));
        } else if arg == "--vault" || arg.starts_with("--vault=") {
            args.vaults.push(value("--vault")?);
        } else if arg == "--read-only" {
            args.read_only = true;
        } else {
            args.words.push(arg);
        }
    }
    args.config = args.config.or_else(|| std::env::var_os("EMERALDMD_CONFIG").map(PathBuf::from));
    Ok(args)
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

fn main() -> ExitCode {
    let result = parse_args(std::env::args().skip(1)).and_then(run);
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: Args) -> Result<(), String> {
    let words: Vec<&str> = args.words.iter().map(String::as_str).collect();
    if (!args.vaults.is_empty() || args.read_only) && !matches!(words.as_slice(), ["token", "add", _]) {
        return Err("--vault and --read-only only apply to `token add`".into());
    }
    let config = args.config.as_deref();
    match words.as_slice() {
        ["-h" | "--help" | "help", ..] => {
            println!("{USAGE}");
            Ok(())
        }
        ["-V" | "--version"] => {
            println!("emeraldmd-server {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        [] | ["serve"] => serve(args.config),
        ["token", "add", name] => token_add(need_file(config)?, name, &args.vaults, args.read_only),
        ["token", "list"] => token_list(config),
        ["token", "revoke", name] => token_revoke(need_file(config)?, name),
        ["token", "new"] => {
            let token = new_token();
            println!("token: {token}\nhash:  {}", hash_token(&token));
            eprintln!("\nGive the token to the app and put only the hash in the server config.");
            Ok(())
        }
        ["token", "hash"] => read_token().map(|token| println!("{}", hash_token(&token))),
        ["healthcheck"] => healthcheck(None, config),
        ["healthcheck", address] => healthcheck(Some(address), config),
        _ => Err(format!("unknown arguments: {}\n\n{USAGE}", args.words.join(" "))),
    }
}

fn need_file(config: Option<&Path>) -> Result<&Path, String> {
    config.ok_or_else(|| "this command edits the config file; give it with --config FILE or EMERALDMD_CONFIG".into())
}

const RELOAD_HINT: &str = "The running server picks this up when it receives SIGHUP (`kill -HUP <pid>`, \
                           `docker kill -s HUP <container>`) or restarts.";

fn token_add(file: &Path, name: &str, vaults: &[String], read_only: bool) -> Result<(), String> {
    let token = tokens::add(file, name, vaults, read_only, env)?;
    let scope = if vaults.is_empty() { "every vault".to_owned() } else { format!("vaults {}", vaults.join(", ")) };
    let scope = if read_only { format!("{scope}, read-only") } else { scope };
    // The token alone on stdout, so `token add laptop > laptop.token` works.
    eprintln!("New token {name:?} for {scope}. It is shown only this once:\n");
    println!("{token}");
    eprintln!("\nIts hash was added to {}. {RELOAD_HINT}", file.display());
    Ok(())
}

fn token_list(config: Option<&Path>) -> Result<(), String> {
    let tokens = tokens::list(config, env)?;
    if tokens.is_empty() {
        eprintln!("No tokens. Create one with `emeraldmd-server token add <name>`.");
        return Ok(());
    }
    let width = tokens.iter().map(|t| t.name.len()).max().unwrap_or(0).max(4);
    println!("{:width$}  VAULTS", "NAME");
    for token in tokens {
        let vaults = token.vaults.map_or_else(|| "all".to_owned(), |ids| ids.join(", "));
        let source = if token.from_env { "  (EMERALDMD_TOKEN_HASHES)" } else { "" };
        let access = if token.read_only { "  (read-only)" } else { "" };
        println!("{:width$}  {vaults}{access}{source}", token.name);
    }
    Ok(())
}

fn token_revoke(file: &Path, name: &str) -> Result<(), String> {
    let left = tokens::revoke(file, name, env)?;
    eprintln!("Revoked {name:?}. {RELOAD_HINT}");
    if left == 0 {
        eprintln!("No tokens are left: nobody can sign in, and the server will not start until you add one.");
    }
    Ok(())
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

/// `GET /healthz` over plain HTTP, for Docker's HEALTHCHECK: the image has no
/// shell or curl, so the binary checks itself.
fn healthcheck(address: Option<&str>, config: Option<&Path>) -> Result<(), String> {
    let address = match address {
        Some(address) => address.parse::<SocketAddr>().map_err(|_| format!("{address:?} is not an address like 127.0.0.1:8484"))?,
        None => {
            let mut bind = Config::read(config, env).map_err(|e| e.to_string())?.bind;
            if bind.ip().is_unspecified() {
                bind.set_ip(if bind.is_ipv4() { IpAddr::V4(Ipv4Addr::LOCALHOST) } else { IpAddr::V6(Ipv6Addr::LOCALHOST) });
            }
            bind
        }
    };
    let timeout = Duration::from_secs(3);
    let failed = |e: std::io::Error| format!("{address}: {e}");
    let mut stream = TcpStream::connect_timeout(&address, timeout).map_err(failed)?;
    stream.set_read_timeout(Some(timeout)).map_err(failed)?;
    stream.set_write_timeout(Some(timeout)).map_err(failed)?;
    write!(stream, "GET /healthz HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n").map_err(failed)?;
    let mut response = Vec::new();
    stream.take(4096).read_to_end(&mut response).map_err(failed)?;
    let response = String::from_utf8_lossy(&response);
    let status = response.lines().next().unwrap_or_default();
    if status.starts_with("HTTP/1.1 200") {
        println!("ok");
        Ok(())
    } else {
        Err(format!("{address} answered {status:?}"))
    }
}

fn serve(config_file: Option<PathBuf>) -> Result<(), String> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        // No color codes in `docker logs` or journald.
        .with_ansi(std::io::stdout().is_terminal())
        .init();
    let config = Config::load(config_file.as_deref(), env).map_err(|e| e.to_string())?;
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    runtime.block_on(async {
        let server = Server::new(&config)?;
        let listener = tokio::net::TcpListener::bind(config.bind).await.map_err(|e| format!("cannot listen on {}: {e}", config.bind))?;
        let address = listener.local_addr().map_err(|e| e.to_string())?;
        tracing::info!("listening on http://{address}");
        #[cfg(unix)]
        tokio::spawn(reload_on_hangup(server.state.clone(), config_file, config.bind));
        server.serve(listener, shutdown_signal()).await.map_err(|e| e.to_string())?;
        // Lets the event streams send their close frames.
        tokio::time::sleep(Duration::from_millis(200)).await;
        tracing::info!("stopped");
        Ok(())
    })
}

/// Re-reads the config on SIGHUP. A config that does not load is logged and
/// ignored, and the server keeps running with the previous one.
#[cfg(unix)]
async fn reload_on_hangup(state: emerald_server::AppState, config_file: Option<PathBuf>, bind: SocketAddr) {
    use tokio::signal::unix::{SignalKind, signal};
    let mut hangups = match signal(SignalKind::hangup()) {
        Ok(hangups) => hangups,
        Err(err) => return tracing::warn!("cannot listen for SIGHUP, config reload is off: {err}"),
    };
    while hangups.recv().await.is_some() {
        tracing::info!("SIGHUP: reloading the configuration");
        let (state, file) = (state.clone(), config_file.clone());
        let reloaded = tokio::task::spawn_blocking(move || {
            let config = Config::read(file.as_deref(), env).map_err(|e| e.to_string())?;
            let mut summary = state.reload(&config)?;
            if config.bind != bind {
                summary.needs_restart.push("bind");
            }
            Ok::<_, String>(summary)
        })
        .await;
        match reloaded {
            Ok(Ok(summary)) => {
                tracing::info!("configuration reloaded: {summary}");
                if summary.tokens == 0 {
                    tracing::warn!("no tokens are configured: every request is refused until one is added");
                }
                if !summary.needs_restart.is_empty() {
                    tracing::warn!("changes to {} take effect after a restart", summary.needs_restart.join(", "));
                }
            }
            Ok(Err(err)) => tracing::error!("reload failed, still using the previous configuration: {err}"),
            Err(err) => tracing::error!("reload failed, still using the previous configuration: {err}"),
        }
    }
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
