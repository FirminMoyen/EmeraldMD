# Milestone: macOS app + self-hosting

Current focus. Everything else (mobile, Windows/Linux packaging) waits until
this list is done. Ticked items have been checked in the running app or with
end-to-end tests; the rest is in priority order within each section.

## macOS app

### Notes and files

- [x] Open an existing Obsidian vault as it is; file tree; new note and
      folder; rename; move to `.trash`
- [x] Live reload of changes made outside the app
- [x] YAML frontmatter shown as properties in the editor
- [x] Reading view (⌘E) rendering Markdown with plugin post-processors
      (Dataview checked in the app)
- [x] Live Preview: Markdown syntax hidden away from the cursor, task
      checkboxes, bullets, rendered links (click to follow), images, embeds,
      callouts and tables; source mode toggle (checked in the app, default
      theme and Minimal)
- [x] Callouts, highlights, embedded notes and sections
- [x] Math (MathJax), Mermaid diagrams and footnotes, in the reading view
      and Live Preview
- [x] Images and attachments: real binary files, image embeds, paste and
      drag-and-drop into notes, attachment folder setting
- [x] File tree: drag-and-drop move, context menu (new note here, rename,
      move to, delete, reveal in Finder, copy path) extended by plugins
      (`file-menu`), rename in place; links are rewritten when notes move
- [x] Back/forward history (⌥⌘←/→, header buttons, mouse buttons)
- [ ] Tabs and splits in the main area
- [x] Hover preview of links (page preview): reading view on hover, editor
      with ⌘, sections and blocks, `hover-link` from plugins
- [x] Daily notes and templates (core plugins, with their settings and
      the `{{date}}`/`{{time}}`/`{{title}}` variables)
- [ ] Bookmarks, properties editor

### Navigation and core panes

- [x] Search pane (Obsidian query syntax), quick switcher (⌘O), command
      palette (⌘P)
- [x] Backlinks, outline, tags, graph view (⌘G), local graph
- [x] Canvas files (`.canvas`): view and edit
- [ ] Unlinked mentions in backlinks

### Plugins and appearance

- [x] Community plugins from `.obsidian/plugins` with restricted mode
      (15 of 16 popular plugins pass the smoke tests)
- [x] Browse and install plugins from the community list (README, download
      counts); update them; uninstall to the vault's `.trash`
- [x] Themes and CSS snippets from `.obsidian/themes` and `.obsidian/snippets`
      (checked with Minimal, Things, AnuPpuccin, Blue Topaz and Border);
      snippets reload when edited on disk
- [x] Settings → Appearance: light/dark/system, accent colour, theme, fonts,
      font size, ribbon, snippets
- [x] Browse and install themes from the community list (screenshots,
      light/dark filter)
- [x] Settings: editor (default modes, line width, strict line breaks, line
      numbers, spellcheck, brackets, indentation), files and links (deletion
      prompt, new note location, link format and updates, attachments),
      hotkeys (recorded, stored in hotkeys.json, conflicts shown)
- [ ] Vim key bindings

### Native macOS

- [x] App menu (EmeraldMD, File, Edit, View, Window) with standard
      shortcuts; ⌘W closes the note, ⌘Q saves before quitting, ⌘, opens
      settings
- [x] Window size, position and workspace (open note, sidebars) restored
- [ ] Large vaults: 10,000 notes open in a few seconds; typing stays smooth
- [ ] Signed and notarized DMG (needs an Apple Developer account: owner)

## Self-hosting

- [x] `emeraldmd-server`: vaults over HTTP with a live WebSocket, Argon2
      tokens scoped to vaults, Docker image, HTTPS guide
- [x] Online remote vaults in the app (Connect to server, token in Keychain)
- [x] Sync engine (offline copy, three-way merge, conflict copies) and its
      server endpoints
- [x] Search on remote vaults (server endpoint)
- [x] Synced mode in the app: choose a local folder, sync on open, after
      edits and every minute; status and conflict notices
- [x] Synced mode: sync immediately on server events (event stream)
- [ ] `.obsidian` settings and plugins for remote and synced vaults
- [x] Server operations: health endpoint, token management CLI (list,
      revoke), Docker Compose example
- [ ] Published server image (registry account: owner)
- [ ] End-to-end check in the real app: connect, live edits from two
      devices, offline edits then reconnect
- [x] Hardening: rate limits, request size limits, trusted-proxy client
      addresses, symlink-safe path handling
- [ ] Security review of the whole server and the app's server client,
      dependency audit
