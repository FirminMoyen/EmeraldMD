//! Decides what to do with every path by comparing three manifests: the
//! state both sides agreed on at the last sync (base), the local vault, and
//! the server. The rule of thumb is that no change is ever lost: an edit wins
//! over a deletion, and when both sides changed a file differently the result
//! is a merge or, failing that, a conflict copy.

use serde::Serialize;

use crate::manifest::{FileState, Manifest};

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "action", content = "path", rename_all = "kebab-case")]
pub enum Action {
    /// Local file is new or changed; the server's copy is unchanged.
    Upload(String),
    /// Server file is new or changed; the local copy is unchanged.
    Download(String),
    /// Deleted locally, unchanged on the server.
    DeleteRemote(String),
    /// Deleted on the server, unchanged locally.
    DeleteLocal(String),
    /// Changed on both sides and mergeable as text.
    Merge(String),
    /// Changed on both sides and not mergeable: the server's version keeps
    /// the path and the local version is kept under a new name.
    ConflictCopy(String),
    /// Both sides already agree (same content, or both deleted); only the
    /// base needs updating.
    Agree(String),
}

impl Action {
    pub fn path(&self) -> &str {
        match self {
            Self::Upload(p)
            | Self::Download(p)
            | Self::DeleteRemote(p)
            | Self::DeleteLocal(p)
            | Self::Merge(p)
            | Self::ConflictCopy(p)
            | Self::Agree(p) => p,
        }
    }
}

/// Extensions merged line by line; everything else is treated as binary.
const TEXT_EXTENSIONS: &[&str] = &["md", "txt", "canvas", "base", "csv", "json", "css", "js", "html", "svg"];

pub fn is_text(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').is_some_and(|(_, ext)| TEXT_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

fn same(a: Option<&FileState>, b: Option<&FileState>) -> bool {
    a.map(|s| &s.hash) == b.map(|s| &s.hash)
}

pub fn plan(base: &Manifest, local: &Manifest, remote: &Manifest) -> Vec<Action> {
    let mut paths: Vec<&String> = base.keys().chain(local.keys()).chain(remote.keys()).collect();
    paths.sort();
    paths.dedup();
    paths
        .into_iter()
        .filter_map(|path| {
            let (b, l, r) = (base.get(path), local.get(path), remote.get(path));
            let path = path.clone();
            let (local_changed, remote_changed) = (!same(b, l), !same(b, r));
            Some(match (local_changed, remote_changed) {
                (false, false) => return None,
                (true, false) if l.is_none() => Action::DeleteRemote(path),
                (true, false) => Action::Upload(path),
                (false, true) if r.is_none() => Action::DeleteLocal(path),
                (false, true) => Action::Download(path),
                (true, true) if same(l, r) => Action::Agree(path),
                // An edit wins over a deletion, on either side.
                (true, true) if l.is_none() => Action::Download(path),
                (true, true) if r.is_none() => Action::Upload(path),
                (true, true) if b.is_some() && is_text(&path) => Action::Merge(path),
                (true, true) => Action::ConflictCopy(path),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(files: &[(&str, &str)]) -> Manifest {
        files.iter().map(|(p, h)| (p.to_string(), FileState { hash: h.to_string(), size: 1 })).collect()
    }

    #[test]
    fn covers_every_case() {
        let base = manifest(&[
            ("same.md", "a"),
            ("local-edit.md", "a"),
            ("remote-edit.md", "a"),
            ("local-del.md", "a"),
            ("remote-del.md", "a"),
            ("both-same.md", "a"),
            ("both-text.md", "a"),
            ("both-bin.png", "a"),
            ("both-del.md", "a"),
            ("del-vs-edit.md", "a"),
            ("edit-vs-del.md", "a"),
        ]);
        let local = manifest(&[
            ("same.md", "a"),
            ("local-edit.md", "b"),
            ("remote-edit.md", "a"),
            ("remote-del.md", "a"),
            ("both-same.md", "b"),
            ("both-text.md", "b"),
            ("both-bin.png", "b"),
            ("edit-vs-del.md", "b"),
            ("new-local.md", "x"),
            ("new-both.md", "x"),
        ]);
        let remote = manifest(&[
            ("same.md", "a"),
            ("local-edit.md", "a"),
            ("remote-edit.md", "c"),
            ("local-del.md", "a"),
            ("both-same.md", "b"),
            ("both-text.md", "c"),
            ("both-bin.png", "c"),
            ("del-vs-edit.md", "c"),
            ("new-remote.md", "y"),
            ("new-both.md", "y"),
        ]);
        let actions = plan(&base, &local, &remote);
        assert_eq!(
            actions,
            [
                Action::ConflictCopy("both-bin.png".into()),
                // Deleted on both sides: only the base changes.
                Action::Agree("both-del.md".into()),
                Action::Agree("both-same.md".into()),
                Action::Merge("both-text.md".into()),
                Action::Download("del-vs-edit.md".into()),
                Action::Upload("edit-vs-del.md".into()),
                Action::DeleteRemote("local-del.md".into()),
                Action::Upload("local-edit.md".into()),
                // Created on both sides with different content: no base to merge from.
                Action::ConflictCopy("new-both.md".into()),
                Action::Upload("new-local.md".into()),
                Action::Download("new-remote.md".into()),
                Action::DeleteLocal("remote-del.md".into()),
                Action::Download("remote-edit.md".into()),
            ]
        );
    }

    #[test]
    fn text_detection() {
        assert!(is_text("a/Note.MD"));
        assert!(is_text("board.canvas"));
        assert!(!is_text("photo.png"));
        assert!(!is_text("Makefile"));
    }
}
