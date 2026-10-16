//! Three-way text merge for files changed on both sides.

/// The merged text, or `None` when the two edits overlap and cannot be
/// combined automatically.
pub fn merge_text(base: &str, local: &str, remote: &str) -> Option<String> {
    if local == remote {
        return Some(local.to_owned());
    }
    if local == base {
        return Some(remote.to_owned());
    }
    if remote == base {
        return Some(local.to_owned());
    }
    diffy::merge(base, local, remote).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combines_edits_to_different_lines() {
        let base = "# Title\n\nfirst\nsecond\nthird\n";
        let local = "# Title\n\nfirst, edited here\nsecond\nthird\n";
        let remote = "# Title\n\nfirst\nsecond\nthird\nfourth from the server\n";
        assert_eq!(
            merge_text(base, local, remote).as_deref(),
            Some("# Title\n\nfirst, edited here\nsecond\nthird\nfourth from the server\n")
        );
    }

    #[test]
    fn overlapping_edits_do_not_merge() {
        assert_eq!(merge_text("a\nb\n", "a\nlocal\n", "a\nremote\n"), None);
    }

    #[test]
    fn one_sided_and_identical_edits() {
        assert_eq!(merge_text("a", "a", "b").as_deref(), Some("b"));
        assert_eq!(merge_text("a", "b", "a").as_deref(), Some("b"));
        assert_eq!(merge_text("a", "c", "c").as_deref(), Some("c"));
    }
}
