//! Version history of a vault's files, as Obsidian Sync keeps it: earlier
//! versions of each file, and files that were deleted, kept for a while
//! (`keep_days`) and readable over the API.
//!
//! Versions live outside the vault folder (`[history] dir`, by default a
//! `history` folder next to the config file), one folder per vault and per
//! file: an `index.json` (the file's path and its versions) and one blob per
//! version, named by its time in milliseconds. A version holds a file's
//! content after a change; changes less than `interval_minutes` apart update
//! the same version, so a burst of edits keeps one version, its last state.
//! Before the server changes or deletes a file it has no version of yet, the
//! file's current content is kept first, so the state before the first change
//! can be restored too.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// How a vault's history is kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorySettings {
    /// Every vault's history goes in a subfolder named after its id.
    pub dir: PathBuf,
    /// Versions older than this are removed.
    pub keep: Duration,
    /// Changes closer together than this update one version.
    pub interval: Duration,
    /// Larger files get no versions.
    pub max_file_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    /// Milliseconds since the epoch; also the blob's name.
    time: u64,
    size: u64,
    hash: String,
    /// The file was deleted at `time`; there is no blob.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    deleted: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Index {
    path: String,
    /// Oldest first.
    versions: Vec<Entry>,
}

impl Index {
    fn last_content(&self) -> Option<&Entry> {
        self.versions.iter().rev().find(|e| !e.deleted)
    }
}

/// A version of a file, as the API lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub time: u64,
    pub size: u64,
}

/// A file that no longer exists but has versions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedFile {
    pub path: String,
    pub deleted_at: u64,
    /// The size of its last version.
    pub size: u64,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        // Versions are the notes' contents: only the server's user may read them.
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// One vault's history.
pub struct History {
    root: PathBuf,
    settings: HistorySettings,
    /// Changes to the history are made one at a time.
    lock: Mutex<()>,
}

impl History {
    pub fn open(settings: &HistorySettings, vault_id: &str) -> io::Result<Self> {
        let root = settings.dir.join(vault_id);
        create_private_dir(&root)?;
        let history = Self { root, settings: settings.clone(), lock: Mutex::new(()) };
        history.prune_all(now_ms());
        Ok(history)
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The folder of a file's history: named by a hash of its path, so any path fits.
    fn dir(&self, path: &str) -> PathBuf {
        self.root.join(&hash(path.as_bytes())[..32])
    }

    fn load(&self, path: &str) -> Index {
        let file = self.dir(path).join("index.json");
        match fs::read(&file).ok().and_then(|data| serde_json::from_slice::<Index>(&data).ok()) {
            Some(index) if index.path == path => index,
            _ => Index { path: path.to_owned(), versions: Vec::new() },
        }
    }

    fn save(&self, index: &Index) -> io::Result<()> {
        let dir = self.dir(&index.path);
        if index.versions.is_empty() {
            return match fs::remove_dir_all(&dir) {
                Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
                _ => Ok(()),
            };
        }
        create_private_dir(&dir)?;
        let tmp = dir.join("index.json.tmp");
        fs::write(&tmp, serde_json::to_vec(index).map_err(io::Error::other)?)?;
        fs::rename(tmp, dir.join("index.json"))
    }

    /// Drops versions older than `keep`, and their blobs.
    fn prune(&self, index: &mut Index, now: u64) {
        let oldest = now.saturating_sub(self.settings.keep.as_millis() as u64);
        let dir = self.dir(&index.path);
        index.versions.retain(|e| {
            if e.time >= oldest {
                return true;
            }
            if !e.deleted {
                let _ = fs::remove_file(dir.join(e.time.to_string()));
            }
            false
        });
    }

    /// Keeps `data` as the file's content after a change at `now`.
    pub fn record(&self, path: &str, data: &[u8], now: u64) -> io::Result<()> {
        if data.len() as u64 > self.settings.max_file_bytes {
            return Ok(());
        }
        let _guard = self.guard();
        let mut index = self.load(path);
        self.prune(&mut index, now);
        let digest = hash(data);
        let dir = self.dir(path);
        let interval = self.settings.interval.as_millis() as u64;
        match index.versions.last_mut() {
            Some(last) if !last.deleted && last.hash == digest => return self.save(&index),
            Some(last) if !last.deleted && now.saturating_sub(last.time) < interval => {
                create_private_dir(&dir)?;
                fs::write(dir.join(last.time.to_string()), data)?;
                last.size = data.len() as u64;
                last.hash = digest;
            }
            last => {
                let time = last.map_or(now, |e| now.max(e.time + 1));
                create_private_dir(&dir)?;
                fs::write(dir.join(time.to_string()), data)?;
                index.versions.push(Entry { time, size: data.len() as u64, hash: digest, deleted: false });
            }
        }
        self.save(&index)
    }

    /// Keeps a file's current content (last changed at `mtime`) if it has no version yet,
    /// before the server changes, moves or deletes it.
    pub fn seed(&self, path: &str, data: &[u8], mtime: u64) -> io::Result<()> {
        if data.len() as u64 > self.settings.max_file_bytes || self.load(path).last_content().is_some() {
            return Ok(());
        }
        // An old mtime starts a version of its own, which the coming change will not overwrite.
        self.record(path, data, mtime.min(now_ms().saturating_sub(self.settings.interval.as_millis() as u64)))
    }

    /// Whether the file has a version: a seed is only needed when it has none.
    pub fn has_versions(&self, path: &str) -> bool {
        self.load(path).last_content().is_some()
    }

    /// Notes that the file was deleted at `now`; its versions stay.
    pub fn mark_deleted(&self, path: &str, now: u64) -> io::Result<()> {
        let _guard = self.guard();
        let mut index = self.load(path);
        match index.versions.last() {
            Some(last) if !last.deleted => {
                let time = now.max(last.time + 1);
                index.versions.push(Entry { time, size: 0, hash: String::new(), deleted: true });
                self.save(&index)
            }
            _ => Ok(()),
        }
    }

    /// Moves the history of `from`, and of everything under it if it is a folder, to `to`.
    pub fn rename(&self, from: &str, to: &str) -> io::Result<()> {
        let _guard = self.guard();
        let prefix = format!("{from}/");
        for index in self.all() {
            let new_path = if index.path == from {
                to.to_owned()
            } else if let Some(rest) = index.path.strip_prefix(&prefix) {
                format!("{to}/{rest}")
            } else {
                continue;
            };
            self.move_index(index, &new_path)?;
        }
        Ok(())
    }

    /// Appends `index`'s versions to those of `to` (which may have some already).
    fn move_index(&self, index: Index, to: &str) -> io::Result<()> {
        let (old_dir, new_dir) = (self.dir(&index.path), self.dir(to));
        let mut target = self.load(to);
        create_private_dir(&new_dir)?;
        for mut entry in index.versions {
            let old_name = entry.time.to_string();
            while target.versions.iter().any(|e| e.time == entry.time) {
                entry.time += 1;
            }
            if !entry.deleted {
                fs::rename(old_dir.join(&old_name), new_dir.join(entry.time.to_string()))?;
            }
            target.versions.push(entry);
        }
        target.versions.sort_by_key(|e| e.time);
        self.save(&target)?;
        match fs::remove_dir_all(&old_dir) {
            Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
            _ => Ok(()),
        }
    }

    /// Every file's index.
    fn all(&self) -> Vec<Index> {
        let Ok(dirs) = fs::read_dir(&self.root) else { return Vec::new() };
        dirs.filter_map(Result::ok)
            .filter_map(|d| fs::read(d.path().join("index.json")).ok())
            .filter_map(|data| serde_json::from_slice::<Index>(&data).ok())
            .collect()
    }

    /// The file's versions, newest first.
    pub fn versions(&self, path: &str) -> Vec<VersionInfo> {
        let index = self.load(path);
        index.versions.iter().rev().filter(|e| !e.deleted).map(|e| VersionInfo { time: e.time, size: e.size }).collect()
    }

    /// The content of the version made at `time`.
    pub fn read(&self, path: &str, time: u64) -> io::Result<Vec<u8>> {
        let index = self.load(path);
        if !index.versions.iter().any(|e| e.time == time && !e.deleted) {
            return Err(io::Error::new(io::ErrorKind::NotFound, "no such version"));
        }
        fs::read(self.dir(path).join(time.to_string()))
    }

    /// Files with versions that no longer exist (`exists` says which do), most recently deleted first.
    pub fn deleted(&self, exists: impl Fn(&str) -> bool) -> Vec<DeletedFile> {
        let mut out: Vec<DeletedFile> = self
            .all()
            .into_iter()
            .filter(|index| !exists(&index.path))
            .filter_map(|index| {
                let last = index.last_content()?;
                let deleted_at = index.versions.last().map_or(last.time, |e| e.time);
                Some(DeletedFile { path: index.path.clone(), deleted_at, size: last.size })
            })
            .collect();
        out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at).then_with(|| a.path.cmp(&b.path)));
        out
    }

    /// Removes old versions from every file's history.
    pub fn prune_all(&self, now: u64) {
        let _guard = self.guard();
        for mut index in self.all() {
            let before = index.versions.len();
            self.prune(&mut index, now);
            if index.versions.len() != before
                && let Err(err) = self.save(&index)
            {
                tracing::warn!(path = %index.path, "could not prune its history: {err}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history(dir: &Path) -> History {
        let settings = HistorySettings {
            dir: dir.to_owned(),
            keep: Duration::from_secs(30 * 86_400),
            interval: Duration::from_secs(300),
            max_file_bytes: 1024,
        };
        History::open(&settings, "notes").unwrap()
    }

    const MIN: u64 = 60_000;

    #[test]
    fn keeps_one_version_per_burst_of_changes() {
        let dir = tempfile::tempdir().unwrap();
        let h = history(dir.path());
        let t = now_ms();
        h.record("A.md", b"one", t).unwrap();
        h.record("A.md", b"two", t + MIN).unwrap();
        h.record("A.md", b"two", t + 2 * MIN).unwrap();
        h.record("A.md", b"three", t + 10 * MIN).unwrap();
        let versions = h.versions("A.md");
        assert_eq!(versions, vec![VersionInfo { time: t + 10 * MIN, size: 5 }, VersionInfo { time: t, size: 3 }]);
        assert_eq!(h.read("A.md", t).unwrap(), b"two");
        assert_eq!(h.read("A.md", t + 10 * MIN).unwrap(), b"three");
        assert_eq!(h.read("A.md", t + MIN).unwrap_err().kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn seeds_the_state_before_the_first_change() {
        let dir = tempfile::tempdir().unwrap();
        let h = history(dir.path());
        let t = now_ms();
        h.seed("A.md", b"before", t - 3_600_000).unwrap();
        h.record("A.md", b"after", t).unwrap();
        // A second seed does nothing: there are versions now.
        h.seed("A.md", b"ignored", t).unwrap();
        let versions = h.versions("A.md");
        assert_eq!(versions.len(), 2);
        assert_eq!(h.read("A.md", versions[1].time).unwrap(), b"before");
    }

    #[test]
    fn lists_deleted_files_and_follows_renames() {
        let dir = tempfile::tempdir().unwrap();
        let h = history(dir.path());
        let t = now_ms();
        h.record("Old/A.md", b"a", t).unwrap();
        h.record("Old/B.md", b"bb", t).unwrap();
        h.record("Keep.md", b"k", t).unwrap();
        h.rename("Old", "New").unwrap();
        assert!(h.versions("Old/A.md").is_empty());
        assert_eq!(h.read("New/A.md", t).unwrap(), b"a");
        h.mark_deleted("New/B.md", t + MIN).unwrap();
        let exists = |p: &str| p == "Keep.md" || p == "New/A.md";
        assert_eq!(h.deleted(exists), vec![DeletedFile { path: "New/B.md".into(), deleted_at: t + MIN, size: 2 }]);
        // Deleted, then written again: its versions continue.
        h.record("New/B.md", b"back", t + 2 * MIN).unwrap();
        assert_eq!(h.versions("New/B.md").len(), 2);
    }

    #[test]
    fn prunes_old_versions_and_skips_big_files() {
        let dir = tempfile::tempdir().unwrap();
        let h = history(dir.path());
        let t = now_ms();
        h.record("Old.md", b"old", t - 40 * 86_400_000).unwrap();
        h.record("Big.bin", &[0; 2048], t).unwrap();
        h.prune_all(t);
        assert!(h.versions("Old.md").is_empty());
        assert!(h.versions("Big.bin").is_empty());
        assert_eq!(fs::read_dir(dir.path().join("notes")).unwrap().count(), 0);
    }
}
