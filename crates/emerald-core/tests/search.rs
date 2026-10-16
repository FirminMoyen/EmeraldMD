use std::fs;
use std::time::Instant;

use emerald_core::{SearchOptions, SearchResults, SearchSort, VaultSession};

const RECIPE: &str = "---
tags: [cooking, recipe/bread]
status: Draft
servings: 4
authors:
  - Ada
  - Grace
---
# Bread

Mix flour and water.
Add salt later.

## Steps
- [ ] buy flour
- [x] heat the oven
1. [ ] knead dough

Notes about #baking/sourdough and Flour.
";

const MEETING: &str = "# Weekly meeting

Discussed the bread project with Ada.
- [ ] send notes 😀 flour
";

fn vault(files: &[(&str, &str)]) -> (tempfile::TempDir, VaultSession) {
    let dir = tempfile::tempdir().unwrap();
    for (path, text) in files {
        let full = dir.path().join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, text).unwrap();
    }
    let session = VaultSession::open(dir.path()).unwrap();
    (dir, session)
}

fn sample() -> (tempfile::TempDir, VaultSession) {
    vault(&[
        ("Recipes/Bread.md", RECIPE),
        ("Meetings/2026-10-16 Weekly.md", MEETING),
        ("Inbox/Empty.md", ""),
        ("Assets/flour.png", "binary"),
    ])
}

fn search(s: &mut VaultSession, query: &str) -> SearchResults {
    s.search(query, &SearchOptions::default()).unwrap_or_else(|e| panic!("{query:?}: {e}"))
}

fn paths(s: &mut VaultSession, query: &str) -> Vec<String> {
    search(s, query).files.into_iter().map(|f| f.path).collect()
}

#[test]
fn words_are_and_across_the_file_and_case_insensitive() {
    let (_d, mut s) = sample();
    assert_eq!(paths(&mut s, "mix salt"), ["Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, "FLOUR"), ["Assets/flour.png", "Meetings/2026-10-16 Weekly.md", "Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, "flour -ada"), ["Assets/flour.png"]);
    assert_eq!(paths(&mut s, "knead OR discussed"), ["Meetings/2026-10-16 Weekly.md", "Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, r#""and water""#), ["Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, r#""water and""#), Vec::<String>::new());
    assert_eq!(paths(&mut s, r"/\d{4}-\d{2}-\d{2}/"), ["Meetings/2026-10-16 Weekly.md"]);
}

#[test]
fn file_path_and_content_operators() {
    let (_d, mut s) = sample();
    assert_eq!(paths(&mut s, "file:weekly"), ["Meetings/2026-10-16 Weekly.md"]);
    assert_eq!(paths(&mut s, "file:recipes"), Vec::<String>::new(), "file: is the name, not the folder");
    assert_eq!(paths(&mut s, "path:recipes"), ["Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, "content:flour"), ["Meetings/2026-10-16 Weekly.md", "Recipes/Bread.md"]);
    let png = search(&mut s, "flour");
    let png = png.files.iter().find(|f| f.path == "Assets/flour.png").unwrap();
    assert!(png.name_matched && png.matches.is_empty());
}

#[test]
fn line_block_and_section_scope_their_operands() {
    let (_d, mut s) = sample();
    assert_eq!(paths(&mut s, "line:(mix water)"), ["Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, "line:(mix salt)"), Vec::<String>::new());
    assert_eq!(paths(&mut s, "block:(mix salt)"), ["Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, "block:(mix oven)"), Vec::<String>::new());
    assert_eq!(paths(&mut s, "section:(oven knead)"), ["Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, "section:(mix oven)"), Vec::<String>::new());
}

#[test]
fn tasks() {
    let (_d, mut s) = sample();
    assert_eq!(paths(&mut s, "task:flour"), ["Meetings/2026-10-16 Weekly.md", "Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, "task-done:oven"), ["Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, "task-todo:oven"), Vec::<String>::new());
    assert_eq!(paths(&mut s, "task-todo:knead"), ["Recipes/Bread.md"]);
    // The checkbox itself is not task text, so the "x" of "[x]" is not found.
    assert_eq!(paths(&mut s, "task:x"), Vec::<String>::new());
}

#[test]
fn tags_match_nested_inline_and_frontmatter() {
    let (_d, mut s) = sample();
    assert_eq!(paths(&mut s, "tag:#baking"), ["Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, "tag:baking/sourdough"), ["Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, "tag:#bak"), Vec::<String>::new(), "tags are not prefixes");
    assert_eq!(paths(&mut s, "tag:recipe"), ["Recipes/Bread.md"], "frontmatter tags, nested");
    assert_eq!(paths(&mut s, "tag:(cooking OR nothing)"), ["Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, "-tag:cooking file:md"), ["Inbox/Empty.md", "Meetings/2026-10-16 Weekly.md"]);
    let result = search(&mut s, "tag:#baking");
    let m = &result.files[0].matches[0];
    assert_eq!(&m.line_text[m.text_from..m.text_to], "#baking/sourdough");
}

#[test]
fn properties() {
    let (_d, mut s) = sample();
    assert_eq!(paths(&mut s, "[status]"), ["Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, "[STATUS:draft]"), ["Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, "[status:done]"), Vec::<String>::new());
    assert_eq!(paths(&mut s, "[authors:grace]"), ["Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, "[servings:4]"), ["Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, "[status:Draft OR Done]"), ["Recipes/Bread.md"]);
    assert_eq!(paths(&mut s, "[missing]"), Vec::<String>::new());
}

#[test]
fn match_case() {
    let (_d, mut s) = sample();
    assert_eq!(paths(&mut s, "match-case:Flour"), ["Recipes/Bread.md"]);
    let sensitive = SearchOptions { case_sensitive: true, ..Default::default() };
    let found: Vec<_> = s.search("Flour", &sensitive).unwrap().files.into_iter().map(|f| f.path).collect();
    assert_eq!(found, ["Recipes/Bread.md"]);
    let found: Vec<_> = s.search("ignore-case:Flour", &sensitive).unwrap().files.into_iter().map(|f| f.path).collect();
    assert_eq!(found.len(), 3);
}

#[test]
fn matches_carry_lines_and_utf16_offsets() {
    let (_d, mut s) = sample();
    let result = search(&mut s, "file:weekly flour");
    let file = &result.files[0];
    assert_eq!(file.match_count, 1);
    let m = &file.matches[0];
    assert_eq!(m.line, 3);
    assert_eq!(m.line_text, "- [ ] send notes 😀 flour");
    // "😀" counts as two UTF-16 units.
    assert_eq!((m.text_from, m.text_to), (20, 25));
    let line_offset = MEETING.lines().take(3).map(|l| l.encode_utf16().count() + 1).sum::<usize>();
    assert_eq!((m.from, m.to), (line_offset + 20, line_offset + 25));
}

#[test]
fn sort_and_limit() {
    let (_d, mut s) = sample();
    let options = SearchOptions { sort: SearchSort::PathDesc, limit: Some(2), ..Default::default() };
    let result = s.search("flour", &options).unwrap();
    assert_eq!(result.total_files, 3);
    let found: Vec<_> = result.files.into_iter().map(|f| f.path).collect();
    assert_eq!(found, ["Recipes/Bread.md", "Meetings/2026-10-16 Weekly.md"]);
}

#[test]
fn errors_are_reported() {
    let (_d, mut s) = sample();
    assert_eq!(s.search("(a", &SearchOptions::default()).unwrap_err().position, Some(0));
    let bad_regex = s.search("/(?<=x)y/", &SearchOptions::default()).unwrap_err();
    assert!(bad_regex.message.starts_with("invalid regular expression"), "{}", bad_regex.message);
    assert!(s.search("tag:file:x", &SearchOptions::default()).is_err());
}

#[test]
fn results_follow_changes() {
    let (dir, mut s) = sample();
    assert_eq!(paths(&mut s, "zebra"), Vec::<String>::new());
    s.write("Inbox/Empty.md", "a zebra").unwrap();
    assert_eq!(paths(&mut s, "zebra"), ["Inbox/Empty.md"]);
    s.rename("Inbox", "Archive").unwrap();
    assert_eq!(paths(&mut s, "zebra"), ["Archive/Empty.md"]);
    fs::write(dir.path().join("Archive/Empty.md"), "now a giraffe instead").unwrap();
    s.sync_path("Archive/Empty.md").unwrap();
    assert_eq!(paths(&mut s, "zebra"), Vec::<String>::new());
    assert_eq!(paths(&mut s, "giraffe"), ["Archive/Empty.md"]);
    s.trash("Archive/Empty.md").unwrap();
    assert_eq!(paths(&mut s, "giraffe"), Vec::<String>::new());
}

#[test]
fn searches_a_large_vault_quickly() {
    let dir = tempfile::tempdir().unwrap();
    let notes = 5_000;
    for i in 0..notes {
        let folder = dir.path().join(format!("f{}", i % 50));
        fs::create_dir_all(&folder).unwrap();
        let text = format!(
            "---\ntags: [t{}]\n---\n# Note {i}\n\nLorem ipsum dolor sit amet, consectetur adipiscing elit {i}.\n- [ ] task {i}\nSed do eiusmod tempor #topic{} incididunt.\n",
            i % 7,
            i % 13
        );
        fs::write(folder.join(format!("n{i}.md")), text.repeat(5)).unwrap();
    }
    let mut s = VaultSession::open(dir.path()).unwrap();
    let start = Instant::now();
    let first = search(&mut s, "lorem tag:t3 -line:(tempor 42)");
    let cold = start.elapsed();
    let start = Instant::now();
    let second = search(&mut s, "task-todo:task section:(sit amet) [tags:t1]");
    let warm = start.elapsed();
    assert!(first.total_files > 600 && second.total_files > 600);
    // Generous budgets: tests run unoptimized; release builds are ~10x faster.
    assert!(cold.as_secs_f64() < 10.0, "cold search took {cold:?}");
    assert!(warm.as_secs_f64() < 5.0, "warm search took {warm:?}");
    eprintln!("{notes} notes: cold {cold:?}, warm {warm:?}");
}
