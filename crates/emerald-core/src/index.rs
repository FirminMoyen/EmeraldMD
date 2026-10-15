//! In-memory index of a vault: file entries, parsed metadata, and resolved
//! links. Link resolution is mirrored in `packages/core/src/link-resolver.ts`;
//! both are tested against `fixtures/link-resolution.json`.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

use crate::metadata::{CachedMetadata, linkpath};
use crate::path::{file_name, normalize_path, parent_path, resolve_relative};
use crate::vault::{EntryKind, FileEntry};

/// Outgoing links of one note: target path (or unresolved linkpath) -> count.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct LinkSets {
    pub resolved: BTreeMap<String, u32>,
    pub unresolved: BTreeMap<String, u32>,
}

#[derive(Default)]
pub struct VaultIndex {
    entries: HashMap<String, FileEntry>,
    /// Files only, keyed by lower-cased vault path.
    by_lower_path: HashMap<String, String>,
    /// Files only, keyed by lower-cased file name (with extension).
    by_lower_name: HashMap<String, Vec<String>>,
    metadata: HashMap<String, CachedMetadata>,
    links: HashMap<String, LinkSets>,
}

impl VaultIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn entry(&self, path: &str) -> Option<&FileEntry> {
        self.entries.get(path)
    }

    pub fn entries(&self) -> impl Iterator<Item = &FileEntry> {
        self.entries.values()
    }

    pub fn metadata(&self, path: &str) -> Option<&CachedMetadata> {
        self.metadata.get(path)
    }

    pub fn all_metadata(&self) -> &HashMap<String, CachedMetadata> {
        &self.metadata
    }

    pub fn link_sets(&self, path: &str) -> Option<&LinkSets> {
        self.links.get(path)
    }

    pub fn all_links(&self) -> &HashMap<String, LinkSets> {
        &self.links
    }

    /// Adds or replaces an entry. Returns true if the path was not indexed before.
    pub fn upsert_entry(&mut self, entry: FileEntry) -> bool {
        let path = entry.path.clone();
        let is_file = entry.kind == EntryKind::File;
        let is_new = self.entries.insert(path.clone(), entry).is_none();
        if is_new && is_file {
            self.by_lower_path.insert(path.to_lowercase(), path.clone());
            self.by_lower_name.entry(file_name(&path).to_lowercase()).or_default().push(path);
        }
        is_new
    }

    pub fn set_metadata(&mut self, path: &str, metadata: CachedMetadata) {
        self.metadata.insert(path.to_owned(), metadata);
    }

    /// `path` itself plus, for a folder, everything below it.
    pub fn paths_under(&self, path: &str) -> Vec<String> {
        let prefix = format!("{path}/");
        let mut paths: Vec<String> =
            self.entries.keys().filter(|k| *k == path || k.starts_with(&prefix)).cloned().collect();
        paths.sort();
        paths
    }

    /// Removes `path` (and its descendants). Returns the removed paths, children before parents.
    pub fn remove(&mut self, path: &str) -> Vec<String> {
        let mut removed = self.paths_under(path);
        removed.reverse();
        for p in &removed {
            self.forget(p);
        }
        removed
    }

    fn forget(&mut self, path: &str) -> Option<FileEntry> {
        let entry = self.entries.remove(path)?;
        if entry.kind == EntryKind::File {
            self.by_lower_path.remove(&path.to_lowercase());
            let name = file_name(path).to_lowercase();
            if let Some(list) = self.by_lower_name.get_mut(&name) {
                list.retain(|p| p != path);
                if list.is_empty() {
                    self.by_lower_name.remove(&name);
                }
            }
        }
        self.metadata.remove(path);
        self.links.remove(path);
        Some(entry)
    }

    /// Re-keys `from` (and its descendants) to `to`, keeping metadata.
    pub fn rename(&mut self, from: &str, to: &str) {
        for old in self.paths_under(from) {
            let new = format!("{to}{}", &old[from.len()..]);
            let metadata = self.metadata.remove(&old);
            let links = self.links.remove(&old);
            if let Some(mut entry) = self.forget(&old) {
                entry.path = new.clone();
                self.upsert_entry(entry);
            }
            if let Some(m) = metadata {
                self.metadata.insert(new.clone(), m);
            }
            if let Some(l) = links {
                self.links.insert(new, l);
            }
        }
    }

    /// Resolves a linkpath (no `#subpath`) written in `source` to a file path.
    ///
    /// Rules, in order (all comparisons ignore case):
    /// 1. `./x` and `../x` are relative to the source's folder, and only that.
    /// 2. An exact vault path, with or without the `.md` extension.
    /// 3. Otherwise every file whose name (bare link) or path suffix (link with `/`)
    ///    matches, with or without `.md`. Ties prefer a file in the source's
    ///    folder, then the shortest path (UTF-16 length), then the lowest path.
    pub fn resolve(&self, linkpath: &str, source: &str) -> Option<&str> {
        let linkpath = linkpath.trim();
        if linkpath.is_empty() {
            return None;
        }
        if linkpath.starts_with("./") || linkpath.starts_with("../") {
            let target = resolve_relative(parent_path(source), linkpath)?;
            return self.lookup_path(&target);
        }
        let linkpath = normalize_path(linkpath);
        if let Some(path) = self.lookup_path(&linkpath) {
            return Some(path);
        }
        let lower = linkpath.to_lowercase();
        let lower_md = format!("{lower}.md");
        let candidates: Vec<&String> = if lower.contains('/') {
            let (suffix, suffix_md) = (format!("/{lower}"), format!("/{lower_md}"));
            self.by_lower_path
                .iter()
                .filter(|(key, _)| key.ends_with(&suffix) || key.ends_with(&suffix_md))
                .map(|(_, path)| path)
                .collect()
        } else {
            self.by_lower_name.get(&lower).into_iter().chain(self.by_lower_name.get(&lower_md)).flatten().collect()
        };
        best_candidate(candidates, parent_path(source))
    }

    fn lookup_path(&self, path: &str) -> Option<&str> {
        if self.entries.get(path).is_some_and(|e| e.kind == EntryKind::File) {
            return self.entries.get(path).map(|e| e.path.as_str());
        }
        let lower = path.to_lowercase();
        self.by_lower_path.get(&lower).or_else(|| self.by_lower_path.get(&format!("{lower}.md"))).map(String::as_str)
    }

    fn compute_links(&self, source: &str) -> Option<LinkSets> {
        let metadata = self.metadata.get(source)?;
        let mut sets = LinkSets::default();
        for text in metadata.link_texts() {
            let path = linkpath(text);
            if path.is_empty() {
                continue;
            }
            match self.resolve(path, source) {
                Some(target) => *sets.resolved.entry(target.to_owned()).or_default() += 1,
                None => *sets.unresolved.entry(path.to_owned()).or_default() += 1,
            }
        }
        Some(sets)
    }

    /// Recomputes one note's outgoing links. Returns true if they changed.
    pub fn relink(&mut self, source: &str) -> bool {
        match self.compute_links(source) {
            Some(sets) if self.links.get(source) != Some(&sets) => {
                self.links.insert(source.to_owned(), sets);
                true
            }
            Some(_) => false,
            None => self.links.remove(source).is_some(),
        }
    }

    /// Recomputes every note's links (needed when files appear, disappear or
    /// move). Returns the sources whose links changed.
    pub fn relink_all(&mut self) -> Vec<String> {
        let sources: Vec<String> = self.metadata.keys().cloned().collect();
        let mut changed: Vec<String> = sources.into_iter().filter(|s| self.relink(s)).collect();
        changed.sort();
        changed
    }

    /// Notes that link to `target`, sorted by path.
    pub fn backlinks(&self, target: &str) -> Vec<String> {
        let mut sources: Vec<String> =
            self.links.iter().filter(|(_, sets)| sets.resolved.contains_key(target)).map(|(s, _)| s.clone()).collect();
        sources.sort();
        sources
    }
}

fn best_candidate<'a>(mut candidates: Vec<&'a String>, folder: &str) -> Option<&'a str> {
    candidates.sort_by(|a, b| {
        let (a_here, b_here) = (parent_path(a) == folder, parent_path(b) == folder);
        b_here
            .cmp(&a_here)
            .then_with(|| a.encode_utf16().count().cmp(&b.encode_utf16().count()))
            .then_with(|| a.cmp(b))
    });
    candidates.first().map(|s| s.as_str())
}
