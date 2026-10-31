//! Selective sync, as in Obsidian Sync: folders and file types a device
//! leaves out. Files left out are neither sent, fetched nor deleted, on
//! either side: the server keeps them, and so does this device. Notes
//! (Markdown), canvases and bases are always synced, unless their folder is
//! left out.

use serde::{Deserialize, Serialize};

use crate::manifest::is_config;

/// Kinds of attachments, by extension.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileType {
    Image,
    Audio,
    Video,
    Pdf,
    /// Any other attachment.
    Other,
}

const IMAGE: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif", "heic", "tif", "tiff", "ico"];
const AUDIO: &[&str] = &["mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus", "aac"];
const VIDEO: &[&str] = &["mp4", "webm", "ogv", "mov", "mkv", "m4v"];
/// Always synced: what the app shows as documents.
const DOCUMENT: &[&str] = &["md", "canvas", "base"];

impl FileType {
    /// The kind of attachment at `path`, or `None` for notes, canvases and bases.
    pub fn of(path: &str) -> Option<Self> {
        let name = path.rsplit('/').next().unwrap_or(path);
        let ext = name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default();
        let ext = ext.as_str();
        if DOCUMENT.contains(&ext) {
            None
        } else if IMAGE.contains(&ext) {
            Some(Self::Image)
        } else if AUDIO.contains(&ext) {
            Some(Self::Audio)
        } else if VIDEO.contains(&ext) {
            Some(Self::Video)
        } else if ext == "pdf" {
            Some(Self::Pdf)
        } else {
            Some(Self::Other)
        }
    }
}

/// What a device leaves out of sync. The default syncs everything.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncFilter {
    /// Folders left out, with everything in them (vault paths).
    pub excluded_folders: Vec<String>,
    /// File types left out.
    pub excluded_types: Vec<FileType>,
}

impl SyncFilter {
    /// Whether `path` is synced. The config folder is not this filter's business.
    pub fn includes(&self, path: &str) -> bool {
        if is_config(path) {
            return true;
        }
        let excluded_folder = self.excluded_folders.iter().any(|folder| {
            let folder = folder.trim_matches('/');
            !folder.is_empty() && path.len() > folder.len() && path.starts_with(folder) && path.as_bytes()[folder.len()] == b'/'
        });
        if excluded_folder {
            return false;
        }
        FileType::of(path).is_none_or(|kind| !self.excluded_types.contains(&kind))
    }

    pub fn is_empty(&self) -> bool {
        self.excluded_folders.iter().all(|f| f.trim_matches('/').is_empty()) && self.excluded_types.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_out_folders_and_file_types() {
        let filter = SyncFilter { excluded_folders: vec!["Archive/".into(), "Big Files".into()], excluded_types: vec![FileType::Video, FileType::Other] };
        assert!(filter.includes("Notes/A.md"));
        assert!(!filter.includes("Archive/Old.md"));
        assert!(!filter.includes("Big Files/x/y.png"));
        // A folder whose name only starts the same way is not left out.
        assert!(filter.includes("Archived.md"));
        assert!(filter.includes("Archive2/A.md"));
        assert!(!filter.includes("clip.MOV"));
        assert!(!filter.includes("data.zip"));
        assert!(filter.includes("photo.jpg"));
        assert!(filter.includes("Board.canvas"));
        assert!(filter.includes("Books.base"));
        // The config folder follows its own setting.
        assert!(filter.includes(".obsidian/app.json"));
        assert!(SyncFilter::default().is_empty());
        assert!(!filter.is_empty());
    }
}
