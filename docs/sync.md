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

All need the usual bearer token.

## Status

- Done: the engine, the server endpoints, the HTTP client
  (`emerald_sync::HttpRemote`, feature `http`), and tests that sync two real
  vaults through a running server.
- Next: a "Synced" option in the desktop app's Connect to server dialog that
  runs a pass on open, after local edits (debounced) and when the server's
  event stream reports a change; then syncing `.obsidian/` settings as an
  opt-in.
