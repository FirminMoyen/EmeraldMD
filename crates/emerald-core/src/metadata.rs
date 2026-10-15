//! Extracts Obsidian-flavored Markdown metadata: frontmatter, headings, links,
//! embeds, tags and block ids. Shapes and field names follow `CachedMetadata`
//! in the public plugin API typings. Positions use UTF-16 code units, so the
//! webview can use them directly as JavaScript string and CodeMirror offsets.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Loc {
    pub line: usize,
    pub col: usize,
    pub offset: usize,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pos {
    pub start: Loc,
    pub end: Loc,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct HeadingCache {
    pub position: Pos,
    pub heading: String,
    pub level: u8,
}

/// A wikilink, Markdown link or embed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceCache {
    pub position: Pos,
    /// Link text without alias, e.g. `Note#Heading`.
    pub link: String,
    /// The link exactly as written in the document.
    pub original: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TagCache {
    pub position: Pos,
    /// Includes the leading `#`.
    pub tag: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BlockCache {
    /// The line carrying the `^id` marker.
    pub position: Pos,
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrontmatterLinkCache {
    /// Property name; list items use `key.index`.
    pub key: String,
    pub link: String,
    pub original: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CachedMetadata {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<ReferenceCache>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub embeds: Vec<ReferenceCache>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<TagCache>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub headings: Vec<HeadingCache>,
    /// Keyed by lower-cased block id.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub blocks: BTreeMap<String, BlockCache>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frontmatter: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frontmatter_position: Option<Pos>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub frontmatter_links: Vec<FrontmatterLinkCache>,
}

impl CachedMetadata {
    /// Link texts of links, embeds and frontmatter links, in that order.
    pub fn link_texts(&self) -> impl Iterator<Item = &str> {
        self.links
            .iter()
            .chain(&self.embeds)
            .map(|l| l.link.as_str())
            .chain(self.frontmatter_links.iter().map(|l| l.link.as_str()))
    }
}

/// The path part of a link text: `Note#Heading` -> `Note`.
pub fn linkpath(linktext: &str) -> &str {
    match linktext.find('#') {
        Some(i) => linktext[..i].trim(),
        None => linktext.trim(),
    }
}

macro_rules! regex {
    ($name:ident, $re:literal) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($re).expect("valid regex"));
    };
}

regex!(FENCE, r"^[ \t]{0,3}(`{3,}|~{3,})");
regex!(HEADING, r"^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$");
regex!(WIKILINK, r"(!?)\[\[([^\[\]\n]+?)\]\]");
regex!(MD_LINK, r"(!?)\[([^\]\n]*)\]\(<?([^)\s<>]+)>?\)");
regex!(URL_SCHEME, r"^[A-Za-z][A-Za-z0-9+.\-]*:");
regex!(TAG, r"(?:^|\s)#([\p{L}\p{N}_/\-]+)");
regex!(BLOCK_ID, r"(?:^|\s)\^([A-Za-z0-9\-]+)[ \t]*$");
regex!(FRONTMATTER_LINK, r"^\[\[([^\[\]\n]+?)\]\]$");

struct Line<'a> {
    /// Without the line terminator.
    text: &'a str,
    number: usize,
    /// UTF-16 offset of the first character in the whole document.
    offset: usize,
}

impl Line<'_> {
    fn loc(&self, byte: usize) -> Loc {
        let col = self.text[..byte].encode_utf16().count();
        Loc { line: self.number, col, offset: self.offset + col }
    }

    fn span(&self, start: usize, end: usize) -> Pos {
        Pos { start: self.loc(start), end: self.loc(end) }
    }
}

fn split_lines(text: &str) -> Vec<Line<'_>> {
    let mut offset = 0;
    text.split('\n')
        .enumerate()
        .map(|(number, raw)| {
            let line = Line { text: raw.strip_suffix('\r').unwrap_or(raw), number, offset };
            offset += raw.encode_utf16().count() + 1;
            line
        })
        .collect()
}

pub fn parse_markdown(text: &str) -> CachedMetadata {
    let lines = split_lines(text);
    let mut cache = CachedMetadata::default();
    let mut body_start = 0;

    if let Some(end) = frontmatter_end(&lines) {
        body_start = end + 1;
        cache.frontmatter_position = Some(Pos { start: lines[0].loc(0), end: lines[end].loc(lines[end].text.len()) });
        let yaml = lines[1..end].iter().map(|l| l.text).collect::<Vec<_>>().join("\n");
        // Invalid YAML leaves the note without frontmatter, as in Obsidian.
        if let Ok(value @ Value::Object(_)) = serde_yaml_ng::from_str::<Value>(&yaml) {
            cache.frontmatter_links = frontmatter_links(&value);
            cache.frontmatter = Some(value);
        }
    }

    let mut fence: Option<(u8, usize)> = None;
    let mut in_comment = false;
    for line in &lines[body_start..] {
        if let Some((ch, len)) = fence {
            if closes_fence(line.text, ch, len) {
                fence = None;
            }
            continue;
        }
        if !in_comment && let Some(run) = FENCE.captures(line.text).and_then(|c| c.get(1)) {
            fence = Some((run.as_str().as_bytes()[0], run.len()));
            continue;
        }
        let masked = mask_code_and_comments(line.text, &mut in_comment);
        parse_line(line, &masked, &mut cache);
    }
    cache
}

fn frontmatter_end(lines: &[Line]) -> Option<usize> {
    if lines.first()?.text.trim_end() != "---" {
        return None;
    }
    lines.iter().skip(1).position(|l| l.text.trim_end() == "---").map(|i| i + 1)
}

fn closes_fence(text: &str, ch: u8, len: usize) -> bool {
    let trimmed = text.trim_start_matches(' ');
    if text.len() - trimmed.len() > 3 {
        return false;
    }
    let run = trimmed.bytes().take_while(|&b| b == ch).count();
    run >= len && trimmed[run..].trim().is_empty()
}

/// Replaces inline code spans and `%%comments%%` with spaces, keeping byte
/// offsets identical, so nothing inside them is picked up as a link or tag.
fn mask_code_and_comments(text: &str, in_comment: &mut bool) -> String {
    let bytes = text.as_bytes();
    let mut out = bytes.to_vec();
    let mut blank = |from: usize, to: usize| out[from..to].fill(b' ');
    let mut comment_start = in_comment.then_some(0);
    let mut i = 0;
    while i < bytes.len() {
        if let Some(start) = comment_start {
            if bytes[i..].starts_with(b"%%") {
                blank(start, i + 2);
                comment_start = None;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        match bytes[i] {
            b'`' => {
                let run = bytes[i..].iter().take_while(|&&b| b == b'`').count();
                match find_backtick_run(bytes, i + run, run) {
                    Some(close) => {
                        blank(i, close + run);
                        i = close + run;
                    }
                    None => i += run,
                }
            }
            b'%' if bytes[i..].starts_with(b"%%") => {
                comment_start = Some(i);
                i += 2;
            }
            _ => i += 1,
        }
    }
    if let Some(start) = comment_start {
        blank(start, bytes.len());
    }
    *in_comment = comment_start.is_some();
    // Only whole ASCII-delimited ranges were blanked, so the bytes stay valid UTF-8.
    String::from_utf8(out).expect("masking preserves UTF-8")
}

fn find_backtick_run(bytes: &[u8], from: usize, len: usize) -> Option<usize> {
    let mut j = from;
    while j < bytes.len() {
        if bytes[j] == b'`' {
            let run = bytes[j..].iter().take_while(|&&b| b == b'`').count();
            if run == len {
                return Some(j);
            }
            j += run;
        } else {
            j += 1;
        }
    }
    None
}

fn parse_line(line: &Line, masked: &str, cache: &mut CachedMetadata) {
    if let Some(c) = HEADING.captures(masked) {
        let text = c.get(2).expect("group");
        let heading = line.text[text.range()].trim();
        if !heading.is_empty() {
            cache.headings.push(HeadingCache {
                position: line.span(0, line.text.len()),
                heading: heading.to_owned(),
                level: c[1].len() as u8,
            });
        }
    }

    for c in WIKILINK.captures_iter(masked) {
        let whole = c.get(0).expect("group");
        let inner = &line.text[c.get(2).expect("group").range()];
        let (link, display) = match inner.split_once('|') {
            Some((link, alias)) => (link.trim(), alias.to_owned()),
            None => (inner.trim(), inner.trim().to_owned()),
        };
        let reference = ReferenceCache {
            position: line.span(whole.start(), whole.end()),
            link: link.to_owned(),
            original: whole.as_str().to_owned(),
            display_text: Some(display),
        };
        if c[1].is_empty() { cache.links.push(reference) } else { cache.embeds.push(reference) }
    }

    for c in MD_LINK.captures_iter(masked) {
        let target = c.get(3).expect("group").as_str();
        if URL_SCHEME.is_match(target) {
            continue;
        }
        let whole = c.get(0).expect("group");
        let reference = ReferenceCache {
            position: line.span(whole.start(), whole.end()),
            link: percent_decode(target),
            original: line.text[whole.range()].to_owned(),
            display_text: Some(line.text[c.get(2).expect("group").range()].to_owned()),
        };
        if c[1].is_empty() { cache.links.push(reference) } else { cache.embeds.push(reference) }
    }

    for c in TAG.captures_iter(masked) {
        let name = c.get(1).expect("group");
        // "#123" is not a tag: at least one non-numeric character is required.
        if name.as_str().chars().all(|ch| ch.is_ascii_digit() || ch == '/') {
            continue;
        }
        cache.tags.push(TagCache {
            position: line.span(name.start() - 1, name.end()),
            tag: format!("#{}", &line.text[name.range()]),
        });
    }

    if let Some(id) = BLOCK_ID.captures(masked).and_then(|c| c.get(1)) {
        let id = &line.text[id.range()];
        cache
            .blocks
            .insert(id.to_lowercase(), BlockCache { position: line.span(0, line.text.len()), id: id.to_owned() });
    }
}

fn frontmatter_links(frontmatter: &Value) -> Vec<FrontmatterLinkCache> {
    let mut out = Vec::new();
    let Value::Object(map) = frontmatter else { return out };
    let mut push = |key: String, value: &str| {
        if let Some(inner) = FRONTMATTER_LINK.captures(value.trim()).and_then(|c| c.get(1)) {
            let inner = inner.as_str();
            let (link, display) = match inner.split_once('|') {
                Some((link, alias)) => (link.trim(), alias.to_owned()),
                None => (inner.trim(), inner.trim().to_owned()),
            };
            out.push(FrontmatterLinkCache {
                key,
                link: link.to_owned(),
                original: value.trim().to_owned(),
                display_text: Some(display),
            });
        }
    };
    for (key, value) in map {
        match value {
            Value::String(s) => push(key.clone(), s),
            Value::Array(items) => {
                for (i, item) in items.iter().enumerate() {
                    if let Value::String(s) = item {
                        push(format!("{key}.{i}"), s);
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    fn hex(b: u8) -> Option<u8> {
        (b as char).to_digit(16).map(|d| d as u8)
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let (Some(hi), Some(lo)) = (bytes.get(i + 1).and_then(|&b| hex(b)), bytes.get(i + 2).and_then(|&b| hex(b)))
        {
            out.push(hi * 16 + lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_in_order_with_links() {
        let md = "---\ntitle: Hello\ntags: [a, b]\nrelated: \"[[Other|alias]]\"\nsee:\n  - \"[[X]]\"\n---\nBody";
        let cache = parse_markdown(md);
        let fm = cache.frontmatter.as_ref().unwrap().as_object().unwrap();
        assert_eq!(fm.keys().collect::<Vec<_>>(), ["title", "tags", "related", "see"]);
        assert_eq!(cache.frontmatter_position.unwrap().end.line, 6);
        let links: Vec<_> = cache.frontmatter_links.iter().map(|l| (l.key.as_str(), l.link.as_str())).collect();
        assert_eq!(links, [("related", "Other"), ("see.0", "X")]);
        assert_eq!(cache.frontmatter_links[0].display_text.as_deref(), Some("alias"));
    }

    #[test]
    fn invalid_yaml_keeps_position_but_no_frontmatter() {
        let cache = parse_markdown("---\nkey: [unclosed\n---\n");
        assert!(cache.frontmatter.is_none());
        assert!(cache.frontmatter_position.is_some());
    }

    #[test]
    fn parses_headings_links_embeds_tags_blocks() {
        let md = "# Title ##\nSee [[Note#Part|the part]] and ![[img.png]].\n[md](Folder/Other%20Note.md) [web](https://x.y/#a)\n#tag/nested #123 text ^block-1";
        let c = parse_markdown(md);
        assert_eq!(c.headings[0].heading, "Title");
        assert_eq!(c.headings[0].level, 1);
        assert_eq!(c.links[0].link, "Note#Part");
        assert_eq!(c.links[0].display_text.as_deref(), Some("the part"));
        assert_eq!(c.links[1].link, "Folder/Other Note.md");
        assert_eq!(c.links.len(), 2);
        assert_eq!(c.embeds[0].link, "img.png");
        assert_eq!(c.tags.iter().map(|t| t.tag.as_str()).collect::<Vec<_>>(), ["#tag/nested"]);
        assert_eq!(c.blocks["block-1"].id, "block-1");
    }

    #[test]
    fn ignores_code_and_comments() {
        let md = "`[[NotALink]]` #real\n```\n[[Fenced]] #no\n```\n%% [[Hidden]]\nstill hidden #no %% [[Shown]]";
        let c = parse_markdown(md);
        assert_eq!(c.links.iter().map(|l| l.link.as_str()).collect::<Vec<_>>(), ["Shown"]);
        assert_eq!(c.tags.iter().map(|t| t.tag.as_str()).collect::<Vec<_>>(), ["#real"]);
    }

    #[test]
    fn positions_are_utf16() {
        // "😀" is two UTF-16 code units and four UTF-8 bytes.
        let c = parse_markdown("😀 [[A]]\r\n[[B]]");
        assert_eq!(c.links[0].position.start.col, 3);
        assert_eq!(c.links[0].position.end.offset, 8);
        assert_eq!(c.links[1].position.start, Loc { line: 1, col: 0, offset: 10 });
    }

    #[test]
    fn linkpath_strips_subpath() {
        assert_eq!(linkpath("Note#Heading"), "Note");
        assert_eq!(linkpath("Note#^block"), "Note");
        assert_eq!(linkpath("#Heading"), "");
    }
}
