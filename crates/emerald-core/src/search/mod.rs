//! Vault search with Obsidian's query syntax (see `docs/search.md`).
//!
//! A query is parsed ([`query::parse`]), compiled into regular expressions
//! once, then evaluated against every file in parallel. Matches are reported
//! as UTF-16 ranges, like the metadata positions, so the webview can use them
//! directly.

pub mod query;

use std::cell::OnceCell;
use std::sync::{Arc, LazyLock};

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::metadata::CachedMetadata;
use crate::path::file_name;
use crate::vault::FileEntry;
use query::{Operator, Query, Term};

/// At most this many matches are reported per file.
pub const MAX_MATCHES_PER_FILE: usize = 100;
/// Longer lines are shortened around the match in results.
const MAX_LINE_CONTEXT: usize = 300;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct SearchError {
    pub message: String,
    /// Character index in the query, when the problem has a location.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<usize>,
}

impl std::fmt::Display for SearchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.position {
            Some(p) => write!(f, "{} (at character {})", self.message, p + 1),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for SearchError {}

impl From<query::ParseError> for SearchError {
    fn from(err: query::ParseError) -> Self {
        Self { message: err.message, position: Some(err.position) }
    }
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SearchSort {
    /// File path, A to Z.
    #[default]
    PathAsc,
    PathDesc,
    ModifiedNewest,
    ModifiedOldest,
    CreatedNewest,
    CreatedOldest,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    /// Like prefixing the whole query with `match-case:`.
    pub case_sensitive: bool,
    pub sort: SearchSort,
    /// Maximum number of files returned.
    pub limit: Option<usize>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// Zero-based line of the match start.
    pub line: usize,
    /// UTF-16 offsets in the document.
    pub from: usize,
    pub to: usize,
    /// The line's text (shortened around the match when very long).
    pub line_text: String,
    /// UTF-16 offsets of the match inside `line_text`.
    pub text_from: usize,
    pub text_to: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileResult {
    pub path: String,
    /// The file name or path matched (as opposed to, or besides, the content).
    pub name_matched: bool,
    pub matches: Vec<SearchMatch>,
    /// Matches found in total; `matches` holds at most [`MAX_MATCHES_PER_FILE`].
    pub match_count: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub files: Vec<SearchFileResult>,
    /// Matching files before `limit` was applied.
    pub total_files: usize,
}

/// A file prepared for searching.
pub struct SearchDoc<'a> {
    pub entry: &'a FileEntry,
    /// Empty for files that are not Markdown.
    pub content: Arc<str>,
    pub metadata: Option<&'a CachedMetadata>,
}

/// A compiled query, ready to run against many files.
pub struct Matcher {
    root: Compiled,
}

enum Compiled {
    Text(Regex),
    Tag(TagPattern),
    And(Vec<Compiled>),
    Or(Vec<Compiled>),
    Not(Box<Compiled>),
    Name(Box<Compiled>),
    Path(Box<Compiled>),
    Content(Box<Compiled>),
    Unit(Unit, Box<Compiled>),
    Property { name: String, value: Option<Box<Compiled>> },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Unit {
    Line,
    Block,
    Section,
    Task(TaskFilter),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TaskFilter {
    Any,
    Todo,
    Done,
}

enum TagPattern {
    /// Lower-cased, without `#`: matches the tag and its nested tags.
    Name(String),
    Regex(Regex),
}

impl TagPattern {
    fn matches(&self, tag: &str) -> bool {
        let tag = tag.trim_start_matches('#');
        match self {
            Self::Name(name) => {
                let tag = tag.to_lowercase();
                tag == *name || tag.strip_prefix(name.as_str()).is_some_and(|rest| rest.starts_with('/'))
            }
            Self::Regex(re) => re.is_match(tag),
        }
    }
}

fn compile_regex(pattern: &str, case_sensitive: bool) -> Result<Regex, SearchError> {
    RegexBuilder::new(pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| SearchError { message: format!("invalid regular expression /{pattern}/: {e}"), position: None })
}

fn compile(query: &Query, case_sensitive: bool) -> Result<Compiled, SearchError> {
    let all = |parts: &[Query]| parts.iter().map(|q| compile(q, case_sensitive)).collect::<Result<Vec<_>, _>>();
    let boxed = |q: &Query| compile(q, case_sensitive).map(Box::new);
    Ok(match query {
        Query::Term(Term::Word(text) | Term::Phrase(text)) => Compiled::Text(compile_regex(&regex::escape(text), case_sensitive)?),
        Query::Term(Term::Regex(pattern)) => Compiled::Text(compile_regex(pattern, case_sensitive)?),
        Query::And(parts) => Compiled::And(all(parts)?),
        Query::Or(parts) => Compiled::Or(all(parts)?),
        Query::Not(inner) => Compiled::Not(boxed(inner)?),
        Query::Op(op, inner) => match op {
            Operator::File => Compiled::Name(boxed(inner)?),
            Operator::Path => Compiled::Path(boxed(inner)?),
            Operator::Content => Compiled::Content(boxed(inner)?),
            Operator::Tag => compile_tag(inner)?,
            Operator::Line => Compiled::Unit(Unit::Line, boxed(inner)?),
            Operator::Block => Compiled::Unit(Unit::Block, boxed(inner)?),
            Operator::Section => Compiled::Unit(Unit::Section, boxed(inner)?),
            Operator::Task => Compiled::Unit(Unit::Task(TaskFilter::Any), boxed(inner)?),
            Operator::TaskTodo => Compiled::Unit(Unit::Task(TaskFilter::Todo), boxed(inner)?),
            Operator::TaskDone => Compiled::Unit(Unit::Task(TaskFilter::Done), boxed(inner)?),
            Operator::MatchCase => compile(inner, true)?,
            Operator::IgnoreCase => compile(inner, false)?,
        },
        Query::Property { name, value } => Compiled::Property {
            name: name.to_lowercase(),
            value: value.as_deref().map(|v| compile(v, case_sensitive).map(Box::new)).transpose()?,
        },
    })
}

/// `tag:` takes tag names (with or without `#`), regexes, and AND/OR/NOT of those.
fn compile_tag(query: &Query) -> Result<Compiled, SearchError> {
    let all = |parts: &[Query]| parts.iter().map(compile_tag).collect::<Result<Vec<_>, _>>();
    Ok(match query {
        Query::Term(Term::Word(name) | Term::Phrase(name)) => {
            Compiled::Tag(TagPattern::Name(name.trim_start_matches('#').to_lowercase()))
        }
        // Tags are case-insensitive, like in Obsidian.
        Query::Term(Term::Regex(pattern)) => Compiled::Tag(TagPattern::Regex(compile_regex(pattern, false)?)),
        Query::And(parts) => Compiled::And(all(parts)?),
        Query::Or(parts) => Compiled::Or(all(parts)?),
        Query::Not(inner) => Compiled::Not(Box::new(compile_tag(inner)?)),
        Query::Op(..) | Query::Property { .. } => {
            return Err(SearchError { message: "tag: only accepts tag names, like tag:#project".into(), position: None });
        }
    })
}

impl Matcher {
    pub fn new(query: &str, options: &SearchOptions) -> Result<Self, SearchError> {
        let parsed = query::parse(query)?;
        Ok(Self { root: compile(&parsed, options.case_sensitive)? })
    }

    /// Matches in `doc`, or `None` if the file does not match.
    pub fn search(&self, doc: &SearchDoc) -> Option<SearchFileResult> {
        let ctx = DocContext::new(doc);
        let scope = Scope { text: ScopeText::Content { start: 0, end: doc.content.len() }, whole_file: true };
        let hits = ctx.eval(&self.root, &scope)?;
        Some(ctx.result(hits))
    }
}

#[derive(Default)]
struct Hits {
    /// Byte ranges in the document content.
    ranges: Vec<(usize, usize)>,
    name: bool,
}

impl Hits {
    fn absorb(&mut self, other: Hits) {
        self.ranges.extend(other.ranges);
        self.name |= other.name;
    }
}

#[derive(Clone, Copy)]
enum ScopeText<'s> {
    /// A byte range of the document content.
    Content { start: usize, end: usize },
    Name,
    Path,
    Value(&'s str),
}

#[derive(Clone, Copy)]
struct Scope<'s> {
    text: ScopeText<'s>,
    /// Bare terms also look at the path, and frontmatter is in reach.
    whole_file: bool,
}

struct Line {
    /// Byte range without the line break.
    start: usize,
    end: usize,
}

static TASK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[(.)\][ \t]?").expect("valid regex"));
static HEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#{1,6}[ \t]").expect("valid regex"));

struct DocContext<'d> {
    doc: &'d SearchDoc<'d>,
    name: &'d str,
    lines: OnceCell<Vec<Line>>,
}

impl<'d> DocContext<'d> {
    fn new(doc: &'d SearchDoc<'d>) -> Self {
        Self { doc, name: file_name(&doc.entry.path), lines: OnceCell::new() }
    }

    fn text(&self) -> &str {
        &self.doc.content
    }

    fn lines(&self) -> &[Line] {
        self.lines.get_or_init(|| {
            let text = self.text();
            let mut lines = Vec::new();
            let mut start = 0;
            for piece in text.split('\n') {
                let end = start + piece.strip_suffix('\r').unwrap_or(piece).len();
                lines.push(Line { start, end });
                start += piece.len() + 1;
            }
            lines
        })
    }

    fn line_of(&self, byte: usize) -> usize {
        self.lines().partition_point(|l| l.start <= byte).saturating_sub(1)
    }

    /// Byte ranges of the units of `kind` inside `[start, end)`.
    fn units(&self, unit: Unit, start: usize, end: usize) -> Vec<(usize, usize)> {
        let text = self.text();
        let lines = self.lines().iter().filter(|l| l.start >= start && l.end <= end);
        match unit {
            Unit::Line => lines.map(|l| (l.start, l.end)).collect(),
            Unit::Task(filter) => lines
                .filter_map(|l| {
                    let caps = TASK.captures(&text[l.start..l.end])?;
                    let done = caps.get(1)?.as_str() != " ";
                    let keep = match filter {
                        TaskFilter::Any => true,
                        TaskFilter::Todo => !done,
                        TaskFilter::Done => done,
                    };
                    let text_start = l.start + caps.get(0)?.end();
                    keep.then_some((text_start, l.end))
                })
                .collect(),
            Unit::Block | Unit::Section => {
                let mut units = Vec::new();
                let mut current: Option<(usize, usize)> = None;
                for l in lines {
                    let line = &text[l.start..l.end];
                    let boundary = match unit {
                        Unit::Block => line.trim().is_empty(),
                        _ => HEADING.is_match(line),
                    };
                    if boundary {
                        units.extend(current.take());
                        if unit == Unit::Block {
                            continue;
                        }
                    }
                    current = Some(current.map_or((l.start, l.end), |(s, _)| (s, l.end)));
                }
                units.extend(current);
                units
            }
        }
    }

    fn eval(&self, query: &Compiled, scope: &Scope) -> Option<Hits> {
        match query {
            Compiled::Text(re) => self.eval_text(re, scope),
            Compiled::Tag(pattern) => self.eval_tag(pattern, scope),
            Compiled::And(parts) => {
                let mut hits = Hits::default();
                for part in parts {
                    hits.absorb(self.eval(part, scope)?);
                }
                Some(hits)
            }
            Compiled::Or(parts) => {
                let mut hits: Option<Hits> = None;
                for part in parts {
                    if let Some(found) = self.eval(part, scope) {
                        hits.get_or_insert_default().absorb(found);
                    }
                }
                hits
            }
            Compiled::Not(inner) => match self.eval(inner, scope) {
                Some(_) => None,
                None => Some(Hits::default()),
            },
            Compiled::Name(inner) => self.eval(inner, &Scope { text: ScopeText::Name, whole_file: false }),
            Compiled::Path(inner) => self.eval(inner, &Scope { text: ScopeText::Path, whole_file: false }),
            Compiled::Content(inner) => {
                let text = match scope.text {
                    ScopeText::Content { .. } => scope.text,
                    _ => ScopeText::Content { start: 0, end: self.text().len() },
                };
                self.eval(inner, &Scope { text, whole_file: false })
            }
            Compiled::Unit(unit, inner) => {
                let ScopeText::Content { start, end } = scope.text else { return None };
                let mut hits: Option<Hits> = None;
                for (s, e) in self.units(*unit, start, end) {
                    let unit_scope = Scope { text: ScopeText::Content { start: s, end: e }, whole_file: false };
                    if let Some(found) = self.eval(inner, &unit_scope) {
                        hits.get_or_insert_default().absorb(found);
                    }
                }
                hits
            }
            Compiled::Property { name, value } => {
                if !scope.whole_file {
                    return None;
                }
                let frontmatter = self.doc.metadata?.frontmatter.as_ref()?.as_object()?;
                let (_, found) = frontmatter.iter().find(|(key, _)| key.to_lowercase() == *name)?;
                let Some(value) = value else { return Some(Hits::default()) };
                let mut strings = Vec::new();
                property_strings(found, &mut strings);
                strings
                    .iter()
                    .any(|s| self.eval(value, &Scope { text: ScopeText::Value(s), whole_file: false }).is_some())
                    .then(Hits::default)
            }
        }
    }

    fn eval_text(&self, re: &Regex, scope: &Scope) -> Option<Hits> {
        let mut hits = Hits::default();
        match scope.text {
            ScopeText::Content { start, end } => {
                let text = &self.text()[start..end];
                hits.ranges.extend(re.find_iter(text).filter(|m| !m.is_empty()).map(|m| (start + m.start(), start + m.end())));
            }
            ScopeText::Name => hits.name = re.is_match(self.name),
            ScopeText::Path => hits.name = re.is_match(&self.doc.entry.path),
            ScopeText::Value(value) => return re.is_match(value).then(Hits::default),
        }
        if scope.whole_file && re.is_match(&self.doc.entry.path) {
            hits.name = true;
        }
        (hits.name || !hits.ranges.is_empty()).then_some(hits)
    }

    fn eval_tag(&self, pattern: &TagPattern, scope: &Scope) -> Option<Hits> {
        let ScopeText::Content { start, end } = scope.text else { return None };
        let metadata = self.doc.metadata?;
        let mut hits = Hits::default();
        let mut found = false;
        for tag in &metadata.tags {
            if !pattern.matches(&tag.tag) {
                continue;
            }
            let Some(range) = self.byte_range(tag.position.start.line, tag.position.start.col, tag.position.end.col) else {
                continue;
            };
            if range.0 >= start && range.1 <= end {
                hits.ranges.push(range);
                found = true;
            }
        }
        if scope.whole_file && !found {
            found = frontmatter_tags(metadata).iter().any(|t| pattern.matches(t));
        }
        found.then_some(hits)
    }

    /// Byte range for UTF-16 columns on one line.
    fn byte_range(&self, line: usize, from_col: usize, to_col: usize) -> Option<(usize, usize)> {
        let l = self.lines().get(line)?;
        let text = &self.text()[l.start..l.end];
        Some((l.start + utf16_to_byte(text, from_col), l.start + utf16_to_byte(text, to_col)))
    }

    fn result(&self, hits: Hits) -> SearchFileResult {
        let mut ranges = hits.ranges;
        ranges.sort_unstable();
        let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
        for (s, e) in ranges {
            match merged.last_mut() {
                Some(last) if s <= last.1 => last.1 = last.1.max(e),
                _ => merged.push((s, e)),
            }
        }
        let text = self.text();
        let matches = merged
            .iter()
            .take(MAX_MATCHES_PER_FILE)
            .map(|&(s, e)| {
                let line_index = self.line_of(s);
                let line = &self.lines()[line_index];
                let line_offset = utf16_len(&text[..line.start]);
                let (ctx_start, ctx_end) = context_window(text, line.start, line.end, s, e.min(line.end));
                let line_text = &text[ctx_start..ctx_end];
                let text_from = utf16_len(&text[ctx_start..s]);
                SearchMatch {
                    line: line_index,
                    from: line_offset + utf16_len(&text[line.start..s]),
                    to: line_offset + utf16_len(&text[line.start..e]),
                    line_text: line_text.to_owned(),
                    text_from,
                    text_to: text_from + utf16_len(&text[s..e.min(ctx_end)]),
                }
            })
            .collect();
        SearchFileResult { path: self.doc.entry.path.clone(), name_matched: hits.name, matches, match_count: merged.len() }
    }
}

/// The part of a line shown with a match: the whole line, or about
/// [`MAX_LINE_CONTEXT`] bytes around the match on char boundaries.
fn context_window(text: &str, line_start: usize, line_end: usize, s: usize, e: usize) -> (usize, usize) {
    if line_end - line_start <= MAX_LINE_CONTEXT {
        return (line_start, line_end);
    }
    let half = MAX_LINE_CONTEXT / 2;
    let mut from = s.saturating_sub(half).max(line_start);
    let mut to = (e + half).min(line_end).max(e);
    while !text.is_char_boundary(from) {
        from -= 1;
    }
    while !text.is_char_boundary(to) {
        to += 1;
    }
    (from, to)
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn utf16_to_byte(text: &str, col: usize) -> usize {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units >= col {
            return byte;
        }
        units += ch.len_utf16();
    }
    text.len()
}

/// Text values of a property, flattening lists.
fn property_strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Null => {}
        Value::String(s) => out.push(s.clone()),
        Value::Array(items) => items.iter().for_each(|v| property_strings(v, out)),
        other => out.push(other.to_string()),
    }
}

/// `tags` / `tag` from frontmatter, as a list or a comma/space separated string.
fn frontmatter_tags(metadata: &CachedMetadata) -> Vec<String> {
    let Some(Value::Object(map)) = &metadata.frontmatter else { return Vec::new() };
    let mut tags = Vec::new();
    for (key, value) in map {
        if !matches!(key.to_lowercase().as_str(), "tags" | "tag") {
            continue;
        }
        let mut strings = Vec::new();
        property_strings(value, &mut strings);
        for s in strings {
            tags.extend(s.split([',', ' ']).map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned));
        }
    }
    tags
}

/// Runs `matcher` over `docs` on all CPU cores, then sorts and limits.
pub fn search_docs(matcher: &Matcher, docs: &[SearchDoc], options: &SearchOptions) -> SearchResults {
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).min(docs.len().max(1));
    let chunk = docs.len().div_ceil(threads).max(1);
    let mut found: Vec<(&SearchDoc, SearchFileResult)> = std::thread::scope(|s| {
        let handles: Vec<_> = docs
            .chunks(chunk)
            .map(|part| s.spawn(move || part.iter().filter_map(|d| matcher.search(d).map(|r| (d, r))).collect::<Vec<_>>()))
            .collect();
        handles.into_iter().flat_map(|h| h.join().expect("search thread panicked")).collect()
    });
    let by_path = |a: &SearchDoc, b: &SearchDoc| a.entry.path.to_lowercase().cmp(&b.entry.path.to_lowercase());
    found.sort_by(|(a, _), (b, _)| match options.sort {
        SearchSort::PathAsc => by_path(a, b),
        SearchSort::PathDesc => by_path(b, a),
        SearchSort::ModifiedNewest => b.entry.mtime.cmp(&a.entry.mtime).then_with(|| by_path(a, b)),
        SearchSort::ModifiedOldest => a.entry.mtime.cmp(&b.entry.mtime).then_with(|| by_path(a, b)),
        SearchSort::CreatedNewest => b.entry.ctime.cmp(&a.entry.ctime).then_with(|| by_path(a, b)),
        SearchSort::CreatedOldest => a.entry.ctime.cmp(&b.entry.ctime).then_with(|| by_path(a, b)),
    });
    let total_files = found.len();
    let files = found.into_iter().map(|(_, r)| r).take(options.limit.unwrap_or(usize::MAX)).collect();
    SearchResults { files, total_files }
}
