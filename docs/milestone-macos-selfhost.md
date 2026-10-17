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
- [ ] Reading view (⌘E) rendering Markdown with plugin post-processors
      (Dataview, Tasks, Admonition, …)
- [ ] Live Preview: Markdown syntax hidden away from the cursor, task
      checkboxes, rendered links and image embeds
- [ ] Callouts, math, Mermaid, footnotes, highlights, embedded notes
- [ ] Images and attachments: embeds, paste and drag-and-drop into notes,
      attachment folder setting
- [ ] File tree: drag-and-drop move, context menu (new note here, rename,
      delete, reveal in Finder, copy path), folder rename
- [ ] Tabs and splits in the main area; back/forward history
- [ ] Hover preview of links (page preview)
- [ ] Bookmarks, templates, daily notes, properties editor

### Navigation and core panes

- [x] Search pane (Obsidian query syntax), quick switcher (⌘O), command
      palette (⌘P)
- [x] Backlinks, outline, tags, graph view (⌘G), local graph
- [x] Canvas files (`.canvas`): view and edit
- [ ] Unlinked mentions in backlinks

### Plugins and appearance

- [x] Community plugins from `.obsidian/plugins` with restricted mode
      (15 of 16 popular plugins pass the smoke tests)
- [ ] Browse and install plugins from the community list; update them
- [ ] Themes and CSS snippets from `.obsidian/themes` and `.obsidian/snippets`
- [ ] Settings: appearance (light/dark/system, accent colour, fonts), editor
      (line width, spellcheck, Vim), files and links (new note location,
      link format), hotkeys

### Native macOS

- [ ] App menu (File, Edit, View, Window, Help) with standard shortcuts;
      ⌘W, ⌘Q, ⌘, behave as on macOS
- [ ] Window size, position and workspace (open note, sidebars) restored
- [ ] Large vaults: 10,000 notes open in a few seconds; typing stays smooth
- [ ] Signed and notarized DMG (needs an Apple Developer account: owner)

## Self-hosting

- [x] `emeraldmd-server`: vaults over HTTP with a live WebSocket, Argon2
      tokens scoped to vaults, Docker image, HTTPS guide
- [x] Online remote vaults in the app (Connect to server, token in Keychain)
- [x] Sync engine (offline copy, three-way merge, conflict copies) and its
      server endpoints
- [ ] Search on remote vaults (server endpoint)
- [ ] Synced mode in the app: choose a local folder, sync on open, after
      edits and on server events; status and conflict notices
- [ ] `.obsidian` settings and plugins for remote and synced vaults
- [ ] Server operations: health endpoint, token management CLI (list,
      revoke), Docker Compose example, published image
- [ ] End-to-end check in the real app: connect, live edits from two
      devices, offline edits then reconnect
- [ ] Security review: rate limits, request size limits, path handling,
      dependency audit
