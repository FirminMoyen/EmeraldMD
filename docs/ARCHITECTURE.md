# EmeraldMD — Architecture & Roadmap

EmeraldMD is an open-source, local-first Markdown knowledge base that is
**compatible with Obsidian vaults, community plugins and themes**, and can open
a vault from the local disk or from a self-hosted EmeraldMD server.

Targets: Linux, macOS, Windows, iOS/iPadOS, Android.

---

## 1. Clean-room policy (read first)

EmeraldMD is an independent implementation. Obsidian is proprietary software;
copying, translating or "porting" its code would make this project
un-distributable. The rules:

**Allowed sources**

| Source | Why it's OK |
|---|---|
| `obsidian` npm package (`obsidian.d.ts`, MIT, github.com/obsidianmd/obsidian-api) | The published plugin API contract. Used as-is as our type surface. |
| Public docs (docs.obsidian.md, plugin dev docs, CSS variable reference) | Describe interfaces and behavior. |
| JSON Canvas spec (jsoncanvas.org, MIT) | Open file format for `.canvas`. |
| Open-source plugins/themes (each under its own license) | Observing which APIs they call is how we prioritise compat work. |
| Black-box behavior of the installed app | File formats in `.obsidian/`, DOM class names and CSS variable names themes rely on, UI behavior. |
| Third-party OSS libraries Obsidian also ships | CodeMirror 6, MathJax, Mermaid, pdf.js, moment, Prism, i18next, PixiJS, Readability: we depend on them directly under their own licenses. |

**Not allowed**

- Copying, translating or paraphrasing code from `app.js`, `main.js`,
  `app.css` or any other part of the Obsidian bundle.
- Committing decompiled or de-minified Obsidian code, or REA output that
  contains it, to this repository.
- Using the Obsidian name or logo as branding. We may say "compatible with
  Obsidian plugins" (nominative use).

**How REA is used:** only to establish *interface facts*: which modules the
plugin runtime receives, which DOM structure and class names themes target,
which files in `.obsidian/` the app reads and writes, and how behavior differs
between versions. Findings go into `docs/compat/` as plain-language
descriptions of the interface, never as code.

---

## 2. Findings that shape the design

Observed with REA (`analyze_javascript_application`, evidence
`ev_7c160cf9…54fd`) on Obsidian 1.12.7 for macOS, plus the public API package:

- **Electron 39.8.3.** The renderer has **no preload script and no
  `contextBridge`**: plugins run in the renderer with Node integration, and
  desktop plugins routinely `require('fs')`, `require('path')` and
  `require('electron')`.
- **42 main-process IPC handlers.** The window and OS integration surface is
  small.
- **Bundled libraries:** CodeMirror 6 (plus CodeMirror 5 legacy modes for
  code-block highlighting, and Vim mode), MathJax, Mermaid, pdf.js, moment,
  Prism, PixiJS (graph view), i18next, Readability. The plugin API re-exports
  some of these: `moment`, and the `@codemirror/*` and `@lezer/*` modules that
  plugins mark as externals.
- **Public API package:** `obsidian@1.14.4` (MIT). It is the authoritative
  contract for `Plugin`, `Vault`, `Workspace`, `MetadataCache`, `Editor`,
  `MarkdownRenderer`, `Setting`, `Modal`, `requestUrl` and the rest.

Consequence: **plugin compatibility requires a JavaScript and DOM runtime with
CodeMirror 6.** Desktop-only plugins additionally expect Node built-ins. A
fully native UI (SwiftUI, WinUI, GTK, Compose, egui) cannot run existing
plugins.

---

## 3. Architecture: Rust core, web UI

EmeraldMD is a **Tauri v2** application. Tauri v2 covers Linux, macOS,
Windows, iOS/iPadOS and Android with one shell.

- **Rust** owns everything below the UI: vault I/O, file watching, the
  metadata index (links, tags, headings, blocks, frontmatter), link resolution,
  backlinks, search, sync, and the self-hosted server. The desktop app, the
  mobile app and the server share the same crates.
- **TypeScript** in the system webview owns everything plugins and themes
  touch: the `obsidian` module, the DOM, CodeMirror 6 and CSS.
- The plugin API is synchronous in places (`getAbstractFileByPath`,
  `metadataCache.getFileCache`, …). The TS layer therefore keeps an
  **in-memory mirror** of the file tree and metadata. Rust fills it with a
  snapshot when the vault opens and keeps it current with change events.

```
emeraldmd/
├─ crates/
│  ├─ emerald-core/   Vault paths, file ops, Markdown metadata parser, link index, backlinks
│  ├─ emerald-sync/   (phase 3, next slice) sync protocol + conflict resolution
│  └─ emerald-server/ self-hosted server: `emeraldmd-server` (HTTP + WebSocket, tokens, Docker)
├─ packages/          TypeScript, runs in the webview
│  ├─ core/           Vault/TFile/TFolder/MetadataCache mirror, Events, normalizePath
│  ├─ editor/         CodeMirror 6 source mode (+ live preview later), Vim, `Editor` facade
│  ├─ api/            (phase 1) the `obsidian` module for plugins
│  ├─ plugin-host/    (phase 1) loads .obsidian/plugins, themes, snippets; restricted mode;
│  │                  Node-compat shims (fs, path, …) over Tauri commands
│  └─ core-plugins/   (phase 2) search, graph, backlinks, outline, templates, daily notes, canvas…
├─ apps/
│  └─ desktop/        Tauri app (src-tauri/ = Rust shell, src/ = UI). Mobile targets are added
│                     to the same app with `tauri ios|android init`.
├─ compat/            (phase 1) plugin compatibility harness
└─ docs/
```

### Plugin compatibility under Tauri

| Plugin kind | Expected status |
|---|---|
| Uses only the `obsidian` API (all plugins with `isDesktopOnly: false` must) | ✅ Supported. Mobile Obsidian runs them in WebKit already. |
| Desktop-only, uses `fs` / `path` / `os` / `crypto` / `Buffer` | ⚠️ Node-compat shim backed by Rust commands. Synchronous `fs.*Sync` calls are the hard part. |
| Uses `require('electron')` | ⚠️ Shim for the common subset (`shell.openExternal`, clipboard, dialogs). |
| Spawns processes (`child_process`: Git, Pandoc, shell commands) | ❌ Not supported initially. Possible later through a permission-gated Rust command. |

The compat harness reads each plugin's `isDesktopOnly` flag and the `require`
calls in its bundle to measure these groups, and we prioritise shims by usage.
If desktop-plugin coverage turns out to matter more than footprint, the same
Rust core can be loaded into an Electron shell as a native Node module, with no
core rewrite.

Webview engines: WebView2 (Chromium) on Windows, WKWebView on macOS and
iOS, WebKitGTK on Linux, Android System WebView. WebKitGTK is the weakest
target and gets dedicated CI coverage.

### Vault access modes

| Mode | Backend | Notes |
|---|---|---|
| Local | `emerald-core` on the device | Identical on-disk layout to Obsidian; open an existing vault with no migration. |
| Remote (online) | HTTP client to `emerald-server` (`RemoteBackend`) | Reads and writes go straight to the server. Simple, needs a connection. Implemented; see section 4. |
| Remote (synced) | local `emerald-core` + `emerald-sync` | Local copy plus bidirectional sync with the server. Works offline; conflicts are resolved with three-way merge for text and keep-both for binaries. Next slice of phase 3. |

Server: a single Rust binary or Docker image. It exposes vault directories over
authenticated HTTPS (REST for files, WebSocket for change notifications), and
supports multiple vaults and users with tokens. It can also serve the EmeraldMD
web client.

### Plugin compatibility strategy

1. Implement the **public** `obsidian.d.ts` surface first (pinned version,
   tracked in `packages/api/API_VERSION`).
2. Provide the same `require()` externals: `obsidian`, `@codemirror/*`,
   `@lezer/*`, `moment`, `electron` (desktop shim), and Node built-ins on
   desktop.
3. Popular plugins also use **undocumented internals** (`app.plugins`,
   `app.internalPlugins`, `app.commands`, `app.setting`, `vault.getConfig`,
   …). Prioritise them by usage in the compat corpus. Specify each one from
   black-box behavior and record it in `docs/compat/internals.md`.
4. The `compat/` harness installs the top-N plugins from the public
   community-plugins list and runs load, enable and unload smoke tests in CI,
   publishing a compatibility table.
5. Themes: use the same DOM structure and class names, and the same CSS
   variable names (both documented publicly); load
   `.obsidian/themes/*/theme.css` and `.obsidian/snippets/*.css` unchanged.

---

## 4. Self-hosting (phase 3)

The first slice is the "remote, online" mode: the app talks to the server
for every read and write. Setup and the HTTP API are in
[self-hosting.md](self-hosting.md).

**Server (`crates/emerald-server`, binary `emeraldmd-server`).** An axum
server that serves one or more vault folders. Each vault is an
`emerald_core::VaultSession`, the same code the desktop app runs locally, so
path checks, hidden-file rules, trash instead of delete, metadata and link
resolution behave identically. Every mutation returns the `VaultUpdate` the
desktop Tauri commands return. A `notify` watcher on each vault turns changes
made outside the server into updates too, as in the desktop shell.

- **Event stream.** `GET /api/vaults/{id}/events` is a WebSocket pushing
  numbered updates. The server keeps the last 1024 per vault. A client
  passes the `epoch` and `version` from its snapshot (or from the last update
  it saw) and gets what it missed; if that is no longer possible (the server
  restarted, which changes the epoch, or the gap is too long) it is told to
  `resync` and reloads the snapshot. Each client sends an id with its
  requests, and its own changes are not echoed back, because it already has
  them from the HTTP response.
- **Auth.** Bearer tokens on every request. The config holds argon2id hashes
  only; a verified token is remembered in memory by its SHA-256 digest, so
  argon2 runs once per token, and at most two verifications run at a time.
  Browsers cannot set headers on a WebSocket, so the app exchanges its token
  for a single-use ticket valid for 30 seconds. Tokens can be limited to some
  vaults; vaults a token cannot open answer 404, like missing ones.
- **CORS** allows the app's webview origins (`tauri://localhost`,
  `http(s)://tauri.localhost`) plus configured extras. TLS is left to a
  reverse proxy.
- **Deployment.** One static binary configured by TOML plus `EMERALDMD_*`
  variables; a multi-stage `Dockerfile` produces a distroless image running
  as an unprivileged user.

**Client (`packages/core/src/remote-backend.ts`).** `RemoteBackend`
implements `VaultBackend` over `fetch`, so the `Vault` mirror and
`MetadataCache` work unchanged. It owns the event stream: ticket, WebSocket,
reconnect with exponential backoff and jitter (0.5 s doubling up to 30 s),
resuming from the last version, and on `resync` it fetches a fresh snapshot
and hands it to the app to rebuild the mirror.

**Desktop (`apps/desktop/src/remote/`, `src-tauri/src/remote.rs`).** "Connect
to server" on the start screen and next to the vault switcher asks for a URL
and a token, then lists the token's vaults. Recent remote vaults are kept in
`remote-vaults.json` in the app's config folder; tokens go to the OS keychain
through the `keyring` crate (macOS Keychain, Windows Credential Manager,
Secret Service on Linux), never to a settings file. The last vault, local or
remote, reopens on start. A dot next to the vault name shows the connection
state. While a remote vault is open, events from the local watcher are
ignored.

**Next slice: offline sync (`emerald-sync`).** A local copy of the vault
opened with `emerald-core`, kept in sync with the server: the event stream
and versions above for server-to-client, a queue of local changes replayed
on reconnect for client-to-server, and conflict handling (three-way merge for
text with the last synced version as base, keep-both for binaries). Until
then, two clients editing the same note at once means the last save wins.
Also later: users and per-user vault access instead of bare tokens, serving
binary files (attachments), a web client served by the server, and mobile.

---

## 5. Roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Foundations** | Monorepo, `emerald-core` (vault, metadata, links), TS vault mirror, CM6 editor (source + live preview), reading view, Tauri desktop shell, file watching | Open an existing Obsidian vault, browse, edit and save notes, follow wikilinks |
| **1. Plugin host** | `obsidian` module, plugin loader, settings tab, restricted mode, themes and snippets, Node-compat shims, compat harness | 25 of the top 50 community plugins load and work |
| **2. Core plugins** | Search, quick switcher, command palette, backlinks, outline, tags, templates, daily notes, bookmarks, properties, page preview, graph | Daily-driver usable on desktop |
| **3. Self-hosting** | `emerald-server`, `emerald-sync`, remote backend, auth, Docker | Same vault edited from two machines through a self-hosted server |
| **4. Mobile** | `tauri ios/android` targets, mobile UI, `Platform.isMobile` plugin path | iOS and Android builds open local and remote vaults |
| **5. Long tail** | Canvas (JSON Canvas), Bases, PDF view, audio/slides, file recovery, i18n, signing and notarisation, auto-update | Feature parity checklist ≥ 90% |

Full parity with Obsidian, which a dedicated team has built for years, is a
long-term goal. The roadmap ships something usable at every phase.
