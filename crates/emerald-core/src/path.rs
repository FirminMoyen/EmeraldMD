//! Vault paths are forward-slash separated and relative to the vault root,
//! with no leading or trailing slash. The root folder itself is `/`.
//! Kept in sync with `packages/core/src/path.ts`.

use unicode_normalization::UnicodeNormalization;

pub fn normalize_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut last_was_slash = false;
    for ch in path.chars() {
        let ch = match ch {
            '\\' => '/',
            '\u{a0}' | '\u{202f}' => ' ',
            c => c,
        };
        if ch == '/' {
            if !last_was_slash {
                out.push('/');
            }
            last_was_slash = true;
        } else {
            out.push(ch);
            last_was_slash = false;
        }
    }
    let normalized: String = out.trim_matches('/').nfc().collect();
    if normalized.is_empty() { "/".to_owned() } else { normalized }
}

pub fn parent_path(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..i],
        None => "/",
    }
}

pub fn file_name(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

/// Splits `Note.md` into `("Note", "md")`. Dotfiles have no extension.
pub fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    }
}

pub fn is_markdown(path: &str) -> bool {
    split_extension(file_name(path)).1.eq_ignore_ascii_case("md")
}

/// Any segment starting with `.` (config folder, `.trash`, `.git`, dotfiles).
pub fn is_hidden(path: &str) -> bool {
    path.split('/').any(|segment| segment.starts_with('.'))
}

/// Resolves `relative` (which may contain `.` and `..`) against a vault folder.
/// Returns `None` if it climbs above the vault root.
pub fn resolve_relative(folder: &str, relative: &str) -> Option<String> {
    let mut segments: Vec<&str> = if folder == "/" { Vec::new() } else { folder.split('/').collect() };
    for segment in relative.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            s => segments.push(s),
        }
    }
    Some(normalize_path(&segments.join("/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_separators_and_edges() {
        assert_eq!(normalize_path("//a\\b//c/"), "a/b/c");
        assert_eq!(normalize_path(""), "/");
        assert_eq!(normalize_path("/"), "/");
        assert_eq!(normalize_path("a\u{a0}b"), "a b");
        // "é" as e + combining acute is composed to a single code point.
        assert_eq!(normalize_path("e\u{301}.md"), "\u{e9}.md");
    }

    #[test]
    fn splits_names() {
        assert_eq!(parent_path("a/b/c.md"), "a/b");
        assert_eq!(parent_path("c.md"), "/");
        assert_eq!(file_name("a/b/c.md"), "c.md");
        assert_eq!(split_extension("c.tar.gz"), ("c.tar", "gz"));
        assert_eq!(split_extension(".hidden"), (".hidden", ""));
        assert!(is_markdown("a/Note.MD"));
        assert!(is_hidden("a/.obsidian/app.json"));
        assert!(!is_hidden("a/b.md"));
    }

    #[test]
    fn resolves_relative_paths() {
        assert_eq!(resolve_relative("a/b", "../c").as_deref(), Some("a/c"));
        assert_eq!(resolve_relative("/", "./x").as_deref(), Some("x"));
        assert_eq!(resolve_relative("a", "../../x"), None);
    }
}
