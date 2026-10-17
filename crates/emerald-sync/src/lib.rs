//! Offline-first sync between a local vault and an EmeraldMD server.
//!
//! Each pass compares three manifests (last agreed base, local, server),
//! plans an action per path ([`plan::plan`]) and applies it. Edits always win
//! over deletions; text changed on both sides is merged line by line; when
//! that is impossible the server's version keeps the path and the local one
//! is saved as a conflict copy. Nothing is deleted permanently: deletions go
//! to the vault's `.trash` on both sides.

pub mod engine;
#[cfg(feature = "http")]
pub mod events;
#[cfg(feature = "http")]
pub mod http;
pub mod manifest;
pub mod merge;
pub mod plan;

pub use engine::{Remote, SyncError, SyncReport, SyncState, sync_once};
pub use manifest::{FileState, HashCache, Manifest, hash_bytes};
pub use plan::Action;
#[cfg(feature = "http")]
pub use events::watch_changes;
#[cfg(feature = "http")]
pub use http::HttpRemote;
