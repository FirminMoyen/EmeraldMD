# Contributing to EmeraldMD

## Clean-room rules

EmeraldMD reimplements behavior that Obsidian users and plugins depend on,
without using Obsidian's code. This is what keeps the project legally
distributable, so pull requests that break these rules cannot be merged.

- **Do not** copy, translate or paraphrase code from Obsidian's application
  bundle (`app.js`, `main.js`, `app.css`, …), and do not commit decompiled or
  de-minified output of it.
- **Do** work from public sources: the MIT-licensed
  [`obsidian` API typings](https://github.com/obsidianmd/obsidian-api), the
  public documentation, the [JSON Canvas spec](https://jsoncanvas.org), open
  plugin and theme source code under its own license, and black-box
  observation of how the app behaves.
- Write down interface findings (file formats, DOM class names, behavior) in
  plain language under `docs/compat/`, and cite how you observed them.

See section 1 of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Code conventions

- Link resolution exists twice: `crates/emerald-core/src/index.rs` and
  `packages/core/src/link-resolver.ts`. The plugin API needs it synchronously
  in the webview. Change both together and add a case to
  `fixtures/link-resolution.json`.
- Metadata types follow `CachedMetadata` in the plugin API typings. Positions
  are UTF-16 offsets.
- Never delete user files permanently. Removal goes to the vault's `.trash`.
- Before opening a PR, run `npm test` and `npm run typecheck`, and run
  `cargo clippy --workspace --all-targets` with no warnings.
