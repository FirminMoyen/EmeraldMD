# EmeraldMD

An open-source, local-first Markdown knowledge base. It opens existing Obsidian
vaults as they are and aims to run Obsidian community plugins and themes
unchanged. Vaults can live on your disk or on your own self-hosted server.

Targets: Linux, macOS, Windows, iOS/iPadOS and Android, built on
**Tauri v2 with a Rust core** and a web UI. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, the plugin
compatibility strategy and the roadmap.

> EmeraldMD is an independent project and is not affiliated with Obsidian.
> "Compatible with Obsidian plugins" describes interoperability only.

## Status

The current focus is the **macOS app and self-hosting**; mobile apps and
Windows/Linux packages come after. Progress is tracked item by item in
[docs/milestone-macos-selfhost.md](docs/milestone-macos-selfhost.md).

**Your Obsidian vault, as it is.** Notes and attachments, `.obsidian`
settings, hotkeys, themes and CSS snippets, community plugins (behind
restricted mode, as in Obsidian), and the tabs and splits Obsidian left in
`workspace.json`. Nothing is converted, and deletions go to `.trash`.

**Editing.** Live Preview, source mode and the reading view; properties;
callouts, embeds, math, Mermaid and footnotes; Obsidian's editing commands
(⌘B, ⌘K, ⌘L…), folding, search and replace in the note, the editor menu, Vim
keys, attachments by paste or drop, Export to PDF. Images, audio, video and
PDFs open in tabs and embed as players and frames; code blocks that plugins
draw (Dataview, `base`…) render in Live Preview.

**Finding your way.** Tabs (pinned or not) and splits (drag tabs between
panes), back and forward, hover previews, the quick switcher and command palette, search with
Obsidian's query syntax, backlinks with unlinked mentions, outgoing links,
outline, footnotes, tags, bookmarks, properties views, the graph with Obsidian's graph
settings, canvas files, and Bases (`.base` files as tables, cards and lists of
notes, with Obsidian's formulas and filters).

**Core plugins.** Daily notes, templates, page preview, bookmarks, file
recovery, note composer, workspaces, Bases, slides, audio recorder, slash
commands, random note and unique note creator.

**Plugins and themes.** Browse, install, update and uninstall community
plugins and themes from the community lists.

**macOS.** Native menus with the usual shortcuts, a hidden title bar as in
Obsidian, window and workspace restored, `emeraldmd://` links (like
`obsidian://`: open, new, search, daily, and plugins' actions), large vaults
(10,000 notes open in about half a second).

**Self-hosting.** `emeraldmd-server` serves vault folders over HTTP with a
live WebSocket, tokens scoped to vaults, rate and size limits, a Docker image
and an HTTPS guide ([docs/self-hosting.md](docs/self-hosting.md)). In the app:

- **Online vaults**: edits from other devices appear live; while the server
  is unreachable, edits are kept and saved when it is back. Settings,
  themes and community plugins are stored on the server.
- **Synced copies**: a full offline copy, synced on changes with a
  three-way merge and conflict copies, optionally with `.obsidian`, and
  selective sync of folders and file types ([docs/sync.md](docs/sync.md)).
- **Version history**: like Obsidian Sync, the server keeps earlier versions
  of files and deleted files for 30 days; compare and restore them from the
  app.

**Not yet.** A signed and notarized DMG and a published server image (they
need the owner's accounts), mobile apps, Windows and Linux packages.

## Repository layout

| Path | What |
|---|---|
| `crates/emerald-core` | Rust: vault I/O, Markdown metadata parser, link index, `VaultSession` |
| `crates/emerald-server` | Rust: `emeraldmd-server`, the self-hosted server (`Dockerfile` at the root) |
| `crates/emerald-sync` | Rust: offline sync between a local copy and a server (three-way merge, conflict copies) |
| `packages/core` | TypeScript mirror of the vault and metadata cache, with the plugin API's shapes, and `RemoteBackend` for server vaults |
| `packages/editor` | CodeMirror 6 editor: Live Preview, properties, search, folding |
| `packages/graph` | The graph view: model, force layout, canvas renderer |
| `packages/canvas` | Canvas files (`.canvas`): model and view |
| `packages/api` | The `obsidian` module for plugins, implemented from the public typings |
| `packages/plugin-host` | Loads community plugins: `require`, restricted mode, enable/disable, settings tab |
| `compat/` | Community plugin smoke tests and API coverage report |
| `apps/desktop` | Tauri app: `src-tauri/` (Rust shell) and `src/` (UI) |
| `fixtures/` | Test cases shared by the Rust and TypeScript test suites |

## Development

Requirements: Node.js 22+, Rust (stable) and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

To try a self-hosted vault locally, create a token and start the server
(see [docs/self-hosting.md](docs/self-hosting.md) for the config file):

```bash
cargo run -p emerald-server -- token new
```

```bash
cargo run -p emerald-server -- --config emeraldmd-server.toml
```

`npm test` runs Vitest and `cargo test`. `npm run typecheck` type-checks the
TypeScript. `npm run compat` downloads the pinned community plugins in
`compat/plugins.json` and smoke-tests them headlessly; add `UPDATE_COMPAT_DOCS=1`
to regenerate `docs/compat/plugins.md` and `api-coverage.md`. To try plugins in
the app, `node compat/make-vault.mjs <folder>` creates a vault with them
installed. `npm run build` produces installable bundles in
`target/release/bundle/`.

On macOS with Homebrew's `rustup`, which is keg-only, put it on your `PATH`
first, for example by adding this line to `~/.zshrc`:

```bash
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first, especially the clean-room rules.

## License

[MIT](LICENSE)
