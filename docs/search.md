# Search syntax

EmeraldMD's search follows the query language that Obsidian users already
know, as described in Obsidian's public help. It is implemented in
`crates/emerald-core/src/search` and runs in Rust, on every CPU core.

## Basics

| Query | Finds notes that… |
|---|---|
| `meeting work` | contain both words, anywhere in the note or its path (AND) |
| `meeting OR work` | contain either word. `OR` must be upper-case; AND binds tighter |
| `meeting (work OR home)` | parentheses group terms |
| `-draft` | do **not** contain *draft* (works before any term or operator) |
| `"star wars"` | contain the exact phrase. Use `\"` for a quote inside it |
| `/\d{4}-\d{2}-\d{2}/` | match a regular expression (Rust `regex` syntax, so no look-around) |

Words match as substrings, so `meet` finds *meeting*. Searches ignore case
unless the match-case setting or `match-case:` is used.

## Operators

| Operator | Meaning |
|---|---|
| `file:weekly` | the file **name** matches (not the folder) |
| `path:"Daily notes"` | the full path matches |
| `content:flour` | only the note's text, not its name or path |
| `tag:#project` | the note has the tag or a nested tag (`#project/alpha`), inline or in `tags:` frontmatter. Tags are case-insensitive and not prefixes: `tag:#pro` does not find `#project` |
| `line:(mix flour)` | all terms on the **same line** |
| `block:(mix salt)` | all terms in the same block (lines between blank lines) |
| `section:(oven knead)` | all terms in the same section (from a heading to the next) |
| `task:call` | in the text of a task (`- [ ]`, `- [x]`, `1. [ ]`, …) |
| `task-todo:call` | in an open task (`[ ]`) |
| `task-done:call` | in a finished task: any status other than a space |
| `match-case:HappyCat` | case-sensitive for its operand |
| `ignore-case:flour` | case-insensitive even when match-case is on |
| `[status]` | the note has the property (frontmatter key, any case) |
| `[status:Draft]` | the property's value matches. Lists match if any item does; the value can be any query, e.g. `[status:Draft OR Done]` |

An operator applies to the term, phrase, regex or parenthesised group right
after the colon. Operators can be negated (`-tag:#archive`) and nested
(`line:(task-todo:call OR "ring back")`).

## Results

`VaultSession::search(query, options)` returns the matching files, each with:

- `nameMatched`: the file name or path matched;
- `matches`: line number, UTF-16 offsets in the document, and the line's text,
  with the match position inside it (at most 100 per file; `matchCount` has
  the total).

Options: `caseSensitive`, `sort` (`path-asc` default, `path-desc`,
`modified-newest|oldest`, `created-newest|oldest`) and `limit`.

The desktop app exposes this as the `search_vault` Tauri command. Content is
cached after the first search and kept current by every change, including
changes made outside the app.

## Not supported yet

- `[property:null]` (an empty property value)
- Embedded search results in notes (```` ```query ```` blocks)
- Search inside PDFs and canvas files
