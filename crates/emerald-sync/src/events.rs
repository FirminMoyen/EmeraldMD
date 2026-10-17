//! Change notifications from an emeraldmd-server's event stream, so a synced
//! copy can sync as soon as the server vault changes instead of on a timer.
//!
//! The stream (`GET /api/vaults/{id}/events`, a WebSocket opened with a
//! one-time ticket) carries every change; here they only signal "something
//! changed", and the sync pass works out what. Changes this client made
//! itself (same `X-EmeraldMD-Client` id) are not echoed back.

use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::engine::SyncError;
use crate::http::HttpRemote;

/// How often a blocked read wakes up to check whether to stop.
const READ_TIMEOUT: Duration = Duration::from_secs(2);
/// Reconnection delays, doubling from the first to the last.
const FIRST_RETRY: Duration = Duration::from_secs(1);
const MAX_RETRY: Duration = Duration::from_secs(60);

fn remote_error(message: impl Into<String>) -> SyncError {
    SyncError::Remote(message.into())
}

/// Calls `on_change` when the server vault changes (and once after each
/// connection, for what happened while disconnected) until `stop` is set.
/// `connect` makes the client for each connection (so a new token is picked
/// up); after errors it reconnects, waiting longer each time, up to a minute.
/// `on_error` hears why a connection failed, for logs.
pub fn watch_changes(
    mut connect: impl FnMut() -> Result<HttpRemote, SyncError>,
    stop: &AtomicBool,
    mut on_change: impl FnMut(),
    mut on_error: impl FnMut(&SyncError),
) {
    let mut delay = FIRST_RETRY;
    while !stop.load(Ordering::SeqCst) {
        match connect().and_then(|remote| stream(&remote, stop, &mut on_change)) {
            // Closed by the server (restart, resync): reconnect soon.
            Ok(()) => delay = FIRST_RETRY,
            Err(err) => on_error(&err),
        }
        sleep_unless_stopped(delay, stop);
        delay = (delay * 2).min(MAX_RETRY);
    }
}

fn sleep_unless_stopped(duration: Duration, stop: &AtomicBool) {
    let step = Duration::from_millis(200);
    let mut slept = Duration::ZERO;
    while slept < duration && !stop.load(Ordering::SeqCst) {
        thread::sleep(step);
        slept += step;
    }
}

/// One connection: returns when the server closes it or `stop` is set.
fn stream(remote: &HttpRemote, stop: &AtomicBool, on_change: &mut impl FnMut()) -> Result<(), SyncError> {
    let url = remote.events_url(&remote.events_ticket()?);
    let (mut socket, _) = tungstenite::connect(url.as_str()).map_err(|e| remote_error(format!("event stream: {e}")))?;
    set_read_timeout(&mut socket);
    on_change();
    loop {
        if stop.load(Ordering::SeqCst) {
            let _ = socket.close(None);
            return Ok(());
        }
        match socket.read() {
            Ok(Message::Text(_)) => on_change(),
            Ok(Message::Close(_)) => return Ok(()),
            // Pings are answered by tungstenite on the next read or write.
            Ok(_) => {}
            Err(tungstenite::Error::Io(err)) if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => return Ok(()),
            Err(err) => return Err(remote_error(format!("event stream: {err}"))),
        }
    }
}

fn set_read_timeout(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>) {
    let tcp = match socket.get_mut() {
        MaybeTlsStream::Plain(tcp) => tcp,
        MaybeTlsStream::Rustls(tls) => tls.get_mut(),
        _ => return,
    };
    let _ = tcp.set_read_timeout(Some(READ_TIMEOUT));
}
