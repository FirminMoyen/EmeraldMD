# Offline sync

Synced mode keeps a full copy of a vault on the device and brings it in line
with an `emeraldmd-server` whenever a sync pass runs. You can work offline;
changes on both sides are reconciled on the next pass. The engine is
`crates/emerald-sync`; the server side is two endpoints of `emeraldmd-server`.

## How a pass works

1. **Scan.** Hash every visible file in the local vault with SHA-256. Hashes
   are cached by modification time and size, so unchanged files are not
   re-read.
2. **Ask the server.** `GET /api/vaults/{id}/manifest` returns every file's
   hash.
3. **Plan.** Compare three manifests: **base** (what both sides agreed on at
   the end of the last pass), **local** and **server**. Each path gets exactly
   one action:

| Local | Server | Action |
|---|---|---|
| changed | unchanged | upload |
| unchanged | changed | download |
| deleted | unchanged | move the server copy to its `.trash` |
| unchanged | deleted | move the local copy to `.trash` |
| changed | deleted, or deleted / changed | **the edit wins**: upload / download it |
| both changed, same content | | nothing to transfer |
| both changed, text | | **three-way merge**, line by line, against the base |
| both changed, merge impossible or binary | | **conflict copy**: the server's version keeps the name, the local one is saved as `Name (conflict 2026-10-16 0912 Laptop).md` on both sides |

4. **Apply.** Each action that succeeds updates the base. A failed action
   (network error, or a file that changed on the server mid-pass) is reported
   and retried next pass, and nothing else is affected.

Nothing is ever deleted permanently. Edits next to each other on adjacent
lines count as overlapping, as in git, and produce a conflict copy rather than
a guess.

Text files (merged line by line): `md txt canvas base csv json css js html svg`.
Everything else is compared as binary.

## Settings, themes and plugins (opt-in)

With **Settings → Sync → Sync settings, themes and plugins** on, a pass also
covers the vault's `.obsidian` folder: settings, hotkeys, themes, CSS
snippets and community plugins. `workspace.json`, `workspace-mobile.json` and
hidden files stay on each device. It is off by default and decided per device:
a device that leaves it off syncs notes only and never touches `.obsidian`.

Settings files are not merged: a line merge of two JSON files can produce one
that no longer parses. When a file changed on both sides, the server's
version is kept and this device's is saved in the vault's `.trash`
(`.trash/app (conflict 2026-10-18 1012 Laptop).json`); a notice says so.
Deletions go to `.trash` on both sides, as for notes.

The client asks for `GET /manifest?config=true`; the server confirms with the
`X-EmeraldMD-Manifest-Config` header. Against an older server without it the
pass stops with "this server cannot sync settings": syncing anyway would read
the missing listing as deletions. Settings received from another device apply
after a reload, which the app offers in a notice; themes and snippets apply at
once.

## Selective sync

Like Obsidian Sync's, each device can leave folders and attachment types out
(Settings → Sync → Selective sync): images, audio, videos, PDFs and other
types. Notes, canvases and bases are always synced, unless their folder is
left out.

A file left out is neither sent, fetched nor deleted, on either side: the
server keeps its copy, and so does this device. Deleting it on one side
while it is left out is not passed on; once it is synced again, the next
pass compares it with the last version both sides agreed on, as usual (a
deletion made meanwhile is then passed on, and an edit wins over a
deletion). The choice is per device, kept with the synced vault in the
app's `synced-vaults.json` (`filter`: `excludedFolders`, `excludedTypes`).

## Where state lives

In the vault's hidden `.emeraldmd/` folder, which the app, the index and sync
itself ignore:

- `sync.json`: the base manifest and the hash cache;
- `sync-base/<sha256>`: the base content of text files, needed for merges.
  Entries no longer referenced are removed after each pass.

## Server endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/vaults/{id}/manifest` | `{ "path": { "hash": "<sha256>", "size": n } }` for every visible file |
| `GET /api/vaults/{id}/raw?path=` | a file's bytes, attachments included |
| `PUT /api/vaults/{id}/raw?path=` | write a file from the request body; returns a `VaultUpdate`, and other clients receive it on the event stream |
| `POST /api/vaults/{id}/trash` | (existing) move to the server's `.trash` |
| `GET /api/vaults/{id}/manifest?config=true` | the manifest with the `.obsidian` files too (settings sync) |
| `PUT /api/vaults/{id}/config/file?path=` | write a `.obsidian` file from the request body |
| `POST /api/vaults/{id}/config/trash` | move a `.obsidian` file or folder to the server's `.trash` |

All need the usual bearer token.

## In the desktop app

**Connect to server**, tick **Keep a synced copy on this Mac**, choose a vault,
then choose where to keep it: the app creates a folder named after the vault
there and opens it like any local vault. The token goes to the macOS Keychain;
synced copies are listed in `synced-vaults.json` in the app's settings folder.

While a synced vault is open, the app syncs:

- when it opens;
- 1.5 s after local edits (in the app or by other programs, through the file
  watcher);
- as soon as another device changes the server vault: the app keeps the
  vault's event stream open (`emerald_sync::watch_changes`) and reconnects
  on its own, waiting up to a minute between tries; its own changes are not
  echoed back;
- every minute, in case the stream is down;
- on **Sync now** (command palette, or a click on the status bar item).

The status bar shows *Syncing…*, *Synced* (hover for when), *Offline* (local
edits are kept and sync later) or *Sign in again* (the server rejected the
token; click to enter a new one). A notice names any conflict copy.

For development, debug builds read the token from `EMERALDMD_DEV_TOKEN` (or
the older `EMERALDMD_DEV_SYNC_TOKEN`) instead of the Keychain, for synced
copies and online vaults alike (`open --env EMERALDMD_DEV_TOKEN=… EmeraldMD.app`),
so a local test server works without Keychain prompts. Release builds ignore it.

## Status

- Done: the engine, the server endpoints, the HTTP client
  (`emerald_sync::HttpRemote`, feature `http`), and tests that sync two real
  vaults through a running server.
- Done in the desktop app: synced copies (see above), checked against a
  local server: first sync, server-to-Mac, Mac-to-server and a same-line
  conflict producing a conflict copy on both sides.
- Done: changes pushed from the server's event stream (with the
  one-minute poll as a fallback), tested against a running server.
- Done: `.obsidian` settings, themes and plugins as an opt-in, tested with
  two vaults through a running server (opt-in per device, deletions, the
  server winning a clash, turning it off), and in the app against a local
  server (a server accent colour applied after the reload notice).
