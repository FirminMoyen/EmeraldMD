//! EmeraldMD core: vault storage, Markdown metadata and the link index.
//! Shared by the desktop/mobile app and the self-hosted server.

pub mod index;
pub mod metadata;
pub mod path;
pub mod session;
pub mod vault;

pub use index::{LinkSets, VaultIndex};
pub use metadata::{CachedMetadata, parse_markdown};
pub use session::{VaultSession, VaultSnapshot, VaultUpdate};
pub use vault::{EntryKind, FileEntry, Vault, VaultError};
