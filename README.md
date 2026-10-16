# EmeraldMD

An open-source, local-first Markdown knowledge base. It opens existing Obsidian
vaults as they are and aims to run Obsidian community plugins and themes
unchanged. Vaults can live on your disk or on your own self-hosted server.

Targets: Linux, macOS, Windows, iOS/iPadOS and Android, built on
**Tauri v2 with a Rust core** and a web UI. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, the plugin
compatibility strategy and the roadmap.

![EmeraldMD desktop, phase 0](docs/images/phase0-desktop.jpg)

> EmeraldMD is an independent project and is not affiliated with Obsidian.
> "Compatible with Obsidian plugins" describes interoperability only.

## Status: phase 1 (plugin host) in progress

Community plugins that use only the plugin API load from a vault's
`.obsidian/plugins` folder, honouring `community-plugins.json`: the `obsidian`
module (`packages/api`), a plugin loader with restricted mode
(`packages/plugin-host`), a command palette (Ctrl/Cmd+P) and a settings window
(Ctrl/Cmd+,) with the installed plugins and their setting tabs. 15 of 16 popular
community plugins pass the headless smoke tests; see
[docs/compat/plugins.md](docs/compat/plugins.md). Not yet: themes and CSS
snippets, Node.js and Electron shims for desktop-only plugins, installing plugins
from the community list.

### Phase 0 (foundations)

Implemented on desktop (built and run on macOS so far):

- Open any folder as a vault (existing Obsidian vaults included). Hidden
  folders such as `.obsidian` and `.trash` are left alone.
- File tree, new note/folder, rename via the title field, move to `.trash`
  (nothing is ever deleted permanently).
- CodeMirror 6 Markdown editor with 2-second autosave, and Cmd/Ctrl-click to
  follow `[[wikilinks]]`. Following a link to a missing note creates it.
- Rust index of frontmatter, headings, links, embeds, tags and block ids, with
  link resolution and a backlinks pane.
- Live reload of changes made outside the app (another editor, sync tools,
  Obsidian itself).

Not yet: themes and snippets, live preview and reading view, search, graph,
self-hosted server, mobile builds. See the roadmap.

## Repository layout

| Path | What |
|---|---|
| `crates/emerald-core` | Rust: vault I/O, Markdown metadata parser, link index, `VaultSession` |
| `packages/core` | TypeScript mirror of the vault and metadata cache, with the plugin API's shapes |
| `packages/editor` | CodeMirror 6 editor |
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
