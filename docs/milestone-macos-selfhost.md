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
- [x] Images, audio, video and PDFs open in tabs (Obsidian's `image`,
      `audio`, `video` and `pdf` views; PDFs in the system's viewer) and
      embed in notes as images, players and PDF frames (`#page=`, `#height=`),
      in the reading view and Live Preview (checked in the app)
- [x] File tree: drag-and-drop move, context menu (new note here, rename,
      move to, delete, reveal in Finder, copy path) extended by plugins
      (`file-menu`), rename in place; links are rewritten when notes move
- [x] Back/forward history (⌥⌘←/→, header buttons, mouse buttons)
- [x] File recovery (core plugin, on by default): snapshots of notes on this
      device when they open or change, at most one per interval (5 min),
      kept 7 days; local history with the changes since a version, Copy and
      Restore (command, file menu, settings)
- [x] Tabs in the main area: each tab keeps its note, cursor, undo history,
      scroll, reading/editing mode and back/forward history; ⌘T, ⌘W, ⇧⌘T,
      ⌃Tab, ⌘1–9, ⌘-click or middle click for a new tab; canvas and plugin
      views in tabs (`getLeaf('tab')`); open tabs restored with the vault
- [x] Pinned tabs (tab menu, "Toggle pin", `leaf.setPinned`): a pin in
      place of the close button; notes opened from a pinned tab open next to
      it; ⌘W and "Close others" leave it; kept with the layout and in
      Obsidian's `workspace.json` format
- [x] Splits in the main area: split right or down (commands, tab menu,
      View menu, or by dropping a tab on a pane's edge), nested, resizable
      by dragging, each pane with its own tabs and editor; tabs dragged to
      reorder them or move them to another pane; files open in the current
      pane; `getLeaf('split')`,
      `splitActiveLeaf`, `createLeafBySplit` and `iterateRootLeaves` for
      plugins; the layout and sizes come back with the vault
- [x] Hover preview of links (page preview): reading view on hover, editor
      with ⌘, sections and blocks, `hover-link` from plugins
- [x] Daily notes and templates (core plugins, with their settings and
      the `{{date}}`/`{{time}}`/`{{title}}` variables)
- [x] Note composer (core plugin): merge a note into another (properties
      merged, links redirected), extract a selection or a heading's section
      into a new or existing note, leaving a link, an embed or nothing
- [x] Slash commands, Random note and Unique note creator (core plugins,
      off by default as in Obsidian)
- [x] Audio recorder (core plugin, off by default): records from the
      microphone, saves `Recording <time>.m4a` (or `.webm`) as an attachment
      and embeds it at the cursor; ribbon button, commands, timer in the
      status bar (not tried with a real microphone)
- [x] Slides (core plugin, off by default): a note presented full screen,
      one slide per part between `---` lines, from the slide with the
      cursor; arrows, Space, Page Up/Down, Home/End, Escape
- [x] Obsidian's layouts: a vault opened here for the first time gets the
      tabs and splits Obsidian left in `workspace.json`; `getLayout` and
      `changeLayout` use that format; Workspaces (core plugin) saves and
      loads named layouts in `workspaces.json`, readable by Obsidian
- [x] Bases (core plugin, on by default): `.base` files as tables, cards
      and lists, with Obsidian's formula language (filters, formulas,
      summaries), sorting, grouping and limits; the toolbar (views, results
      copied as Markdown or CSV, sort, filters, properties, formulas, new
      note matching the filters) writes back the file in Obsidian's format;
      note properties edited in table cells; embeds (`![[x.base#View]]`)
      and `base` code blocks with `this`; plugins' view types
      (`registerBasesView`) and the `Value` classes of the typings
- [x] Live Preview renders the code blocks plugins draw (`base`,
      Dataview…), with an edit button for their source
- [x] Bookmarks (core plugin, `.obsidian/bookmarks.json`, groups, follow
      renames, left sidebar pane, file menu item)
- [x] Properties editor: frontmatter as properties in Live Preview and the
      reading view (text, list, number, checkbox, date, date & time, tags,
      aliases), types in `.obsidian/types.json`, rename/add/remove, "Add file
      property" (⌘;), "Properties in document" setting (visible, hidden,
      source)

### Navigation and core panes

- [x] Search options as Obsidian's: sort order (name, modified, created),
      collapse all results, copy results (links, paths, with matching
      lines); ```query blocks embed search results in notes (reading view
      and Live Preview)
- [x] Search pane (Obsidian query syntax), quick switcher (⌘O), command
      palette (⌘P) with pinned commands (`command-palette.json`), recent
      ones remembered, and the user's hotkeys
- [x] Backlinks, outline, tags, graph view (⌘G), local graph
- [x] Local graph settings as Obsidian's: depth, incoming, outgoing and
      neighbor links, with the global graph's filters, groups, display and
      forces (kept per vault on this device)
- [x] Outline as Obsidian's: a tree that folds (collapse/expand all), a
      filter, the heading the cursor is under marked, and headings dragged
      onto others to move their sections (one undo step)
- [x] Graph settings as Obsidian's, in `.obsidian/graph.json`: filters
      (search with Obsidian's syntax, tags, attachments, existing files
      only, orphans), colour groups by query, display (arrows, text fade,
      node size, link thickness) and forces
- [x] Canvas files (`.canvas`): view and edit
- [x] Backlinks with the line of each link; unlinked mentions (name and
      aliases, whole words, outside links) turned into links in one click
- [x] Footnotes view ("Footnotes view: Show footnotes"): the open note's
      footnotes in the order they are referenced, rendered, with undefined
      and unreferenced ones marked; a click shows the definition, arrows
      show each reference
- [x] Outgoing links pane: the note's links, those not created yet, and
      unlinked mentions of other notes in its text
- [x] Properties view: all properties of the vault with their counts (a
      click searches `[property]`), and the open note's properties to edit
      in the sidebar

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
- [x] Vim key bindings (`vimMode`, Settings → Editor; `CodeMirrorAdapter.Vim`
      for plugins)
- [x] Obsidian's editing commands: bold ⌘B, italics ⌘I, link ⌘K, checkbox
      ⌘L, comment ⌘/, strikethrough, highlight, code, math, headings,
      lists, quotes, inserts (callout, code and math blocks, table, rule),
      move and delete lines, follow link under cursor (⌥↩); folding of
      headings and lists (arrows on hover, Fold heading / Fold indent)
- [x] Editor context menu as Obsidian's (clipboard, Format, Paragraph and
      Insert submenus) extended by plugins (`editor-menu`); with
      spellcheck on, the system menu with spelling suggestions
- [x] Search and replace in the note (⌘F, ⌥⌘F): a bar at the top of the
      editor with the match count, previous/next, match case, regex,
      Replace and Replace all

### Native macOS

- [x] App menu (EmeraldMD, File, Edit, View, Window) with standard
      shortcuts; ⌘T/⌘W/⇧⌘T for tabs, ⌘Q saves before quitting, ⌘, opens
      settings
- [x] `emeraldmd://` links, like Obsidian's `obsidian://` URIs (scheme in
      Info.plist): `open`, `new` (with `content`, `append`, `silent`),
      `search`, `daily`, and plugins' actions (`registerObsidianProtocolHandler`);
      they start the app if needed; "Copy EmeraldMD URL" in the command
      palette and file menu (checked in the app, running and from a cold start)
- [x] Export to PDF (command, File menu): the note as in the reading view,
      light, with its name as the title, in the system's print dialog
      (Save as PDF)
- [x] Title bar hidden as in Obsidian on macOS: the window buttons sit in
      the row of tab headers (ribbon and first header leave them room, none
      in full screen); empty parts of the header rows move the window;
      Obsidian's `mod-macos`, `is-frameless`, `is-hidden-frameless` and
      `is-fullscreen` body classes for themes
- [x] Window size, position and workspace (open note, sidebars) restored
- [x] Large vaults: 10,000 notes (39 MB) open in about 0.5 s on an M-series
      Mac (index 0.3 s with parallel parsing, UI 60 ms); opening a note takes
      15–50 ms (`cargo run --release -p emerald-core --example open_vault`)
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
- [x] `.obsidian` settings for online server vaults: settings, hotkeys,
      themes and snippets are kept on the server (config endpoints)
- [x] Community plugins in server vaults: loaded from the server's
      `.obsidian/plugins`, installed and updated there, uninstalled to its
      `.trash` (`POST /config/trash`); restricted mode decided per server and
      vault, with a warning that the server holds the code
- [x] Selective sync in synced copies (per device): folders and attachment
      types (images, audio, videos, PDFs, other) left out are neither sent,
      fetched nor deleted, on either side
- [x] `.obsidian` in synced copies (opt-in, per device): settings, themes,
      snippets and plugins; the server's version wins a clash and the local
      one goes to `.trash`; a notice offers to reload
- [x] Server operations: health endpoint, token management CLI (list,
      revoke), Docker Compose example
- [ ] Published server image (registry account: owner)
- [x] End-to-end check in the real app against a local server: online
      vault reopened from the saved list, live edits from another client
      shown within 2 s, edits from the app on the server, offline edits kept
      and saved about 8 s after the server came back (the Connect dialog
      itself, with a token typed and saved to the Keychain, is still to be
      tried by the owner)
- [x] Version history, as Obsidian Sync's: the server keeps earlier
      versions of files (one per 5-minute burst of changes, and the content
      from before the first change) and deleted files, for 30 days, outside
      the vaults (`[history]`); in the app, "Server: Show version history"
      and "Server: Show deleted files" (online and synced vaults) show a
      version, the changes since, and restore it (checked against a local
      server)
- [x] Hardening: rate limits, request size limits, trusted-proxy client
      addresses, symlink-safe path handling
- [x] Security review of the desktop app (docs/security-desktop.md: inert
      notes, command limits, plugin trust) and dependency audits (npm, cargo)
