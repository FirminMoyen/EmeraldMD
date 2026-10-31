# Self-hosting EmeraldMD

`emeraldmd-server` serves one or more vault folders to the EmeraldMD app over
HTTP, and pushes every change to connected apps over a WebSocket. A vault on
the server is an ordinary folder of Markdown files, so an existing Obsidian
vault can be served as it is, and you can keep editing it with other tools:
the server watches the folder and forwards outside changes too.

The app can work on a server vault online (every read and write goes to the
server) or keep a synced copy that works offline; see
[ARCHITECTURE.md](ARCHITECTURE.md#vault-access-modes) and [sync.md](sync.md).

The quickest way to run it on the internet, with HTTPS, is the Docker Compose
example in [`examples/`](../examples) (section 4). What the server protects
against, and what it does not, is in [security.md](security.md).

## 1. Configure

The server reads a TOML file given with `--config FILE` or `EMERALDMD_CONFIG`:

```toml
# Address to listen on. Keep it on localhost (or a private Docker network)
# and put an HTTPS reverse proxy in front; see section 5.
bind = "127.0.0.1:8484"

# Largest note or attachment the server accepts, in MiB.
max_body_mb = 64

# Browser origins allowed to call the API, besides the EmeraldMD app itself
# (tauri://localhost, http://tauri.localhost, https://tauri.localhost).
allowed_origins = []

# Reverse proxies whose X-Forwarded-For header names the client: IP addresses
# or CIDR ranges. Failed logins are limited per client, so behind a proxy set
# this, or every client counts as the proxy. Empty: the header is ignored.
trusted_proxies = ["127.0.0.1"]

# Event streams (WebSockets) one token may keep open at once.
max_streams_per_token = 16

[[vaults]]
id = "notes"                  # used in URLs: letters, digits, - and _
path = "/srv/vaults/notes"
name = "Notes"                # optional, shown in the app; defaults to the folder name

[[vaults]]
id = "work"
path = "/srv/vaults/work"

# [[tokens]] entries are added by `emeraldmd-server token add`; see section 2.

# Version history (section 6): earlier versions of files and deleted files,
# kept outside the vaults. On by default.
[history]
# enabled = true
# dir = "/srv/emeraldmd/history"   # default: a `history` folder next to this file
# keep_days = 30                    # versions older than this are removed
# interval_minutes = 5              # changes closer together update one version
# max_file_mb = 10                  # larger files get no versions
```

Environment variables add to the file, or replace it entirely:

| Variable | Meaning |
|---|---|
| `EMERALDMD_CONFIG` | Path of the TOML file (same as `--config`) |
| `EMERALDMD_BIND` | Listen address, e.g. `0.0.0.0:8484` |
| `EMERALDMD_VAULTS` | Extra vaults as `id=path` pairs separated by `;`, e.g. `notes=/vaults/notes;work=/vaults/work` |
| `EMERALDMD_TOKEN_HASHES` | Extra token hashes separated by whitespace; each may open every vault |
| `EMERALDMD_ALLOWED_ORIGINS` | Extra CORS origins, comma-separated |
| `EMERALDMD_TRUSTED_PROXIES` | Extra trusted proxies, comma-separated |
| `EMERALDMD_HISTORY_DIR` | Where version history is kept (replaces `[history] dir`) |
| `RUST_LOG` | Log level, e.g. `info` (default) or `emerald_server=debug,tower_http=debug` |

The server refuses to start without at least one vault and one token, or if a
token entry holds something that is not an argon2 hash.

Vault rules are the same as in the desktop app: hidden files and folders
(`.obsidian`, `.trash`, dotfiles) are not listed, deleting moves things to the
vault's `.trash` folder, and no path can escape the vault folder. On top of
that, the server does not follow symbolic links that lead out of the vault
folder (links within it work), and of the hidden files it serves only the
config folder `.obsidian`.

## 2. Access tokens

Every request needs a bearer token. The server stores only an argon2id hash
of each token, never the token itself. Make one token per device, so you can
revoke them one by one.

```bash
emeraldmd-server token add laptop --config emeraldmd-server.toml
```

It prints a new random token (`emd_…`) once, and appends its hash to the
config file as a `[[tokens]]` entry; comments and formatting in the file are
kept. Give the token to the app. To limit a token to some vaults, repeat
`--vault`:

```bash
emeraldmd-server token add work-phone --vault work
emeraldmd-server token list
emeraldmd-server token revoke work-phone
```

(Here the config file comes from `EMERALDMD_CONFIG`.) `token list` shows
names and vaults, never hashes. `token revoke` removes the entry. A running
server applies both when it reloads its config (section 6); until then, a new
token is refused and a revoked one still works.

The token goes to standard output and the messages to standard error, so
`token add laptop > laptop.token` saves just the token.

To share a vault without letting anyone change it, make a read-only token:

```bash
emeraldmd-server token add family --vault notes --read-only
```

It adds `read_only = true` to the entry. Such a token reads everything a
vault holds (notes, settings, search, version history, live changes), and
every request that would change something is refused with `403`. The app
opens the vault read-only: notes can be read, not edited. It cannot keep a
synced copy, which needs to send changes, so it opens the vault online.

Without a config file, put hashes in `EMERALDMD_TOKEN_HASHES` instead:
`emeraldmd-server token new` prints a token and its hash, and
`emeraldmd-server token hash` hashes a token read from standard input.

## 3. Run

### From source

```bash
cargo run --release -p emerald-server -- --config emeraldmd-server.toml
```

### With Docker

Build the image from the repository root:

```bash
docker build -t emeraldmd-server .
```

Run it with your vaults and config folder mounted. The image runs as an
unprivileged user; pass `--user` with the owner of the vault files so the
server can write them:

```bash
docker run -d --name emeraldmd \
  --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:8484:8484 \
  -v /srv/vaults:/vaults \
  -v /srv/emeraldmd/config:/config \
  -e EMERALDMD_CONFIG=/config/emeraldmd-server.toml \
  --restart unless-stopped \
  emeraldmd-server
```

Mount the folder that holds the config file, not the file alone: `token add`
and `token revoke` write a new file and rename it over the old one, and a
single-file mount keeps showing the old file inside the container. Token
commands run in the same container:

```bash
docker exec emeraldmd emeraldmd-server token add phone
docker kill -s HUP emeraldmd     # reload, see section 6
```

In the config used in the container, vault paths are container paths
(`/vaults/notes`), and `bind` should be `0.0.0.0:8484` (the image sets
`EMERALDMD_BIND` to that). Publishing the port on `127.0.0.1` keeps it
reachable only through a reverse proxy on the same host. Inside the
container, connections through a published port come from a Docker address,
not from `127.0.0.1` (on Linux, the bridge's gateway, `172.17.0.1` by
default): that is the address to list in `trusted_proxies`. A rejected token
is logged with the address the server saw, which shows it if unsure. The
Compose example in section 4 runs the proxy on a network of its own instead.

The image has a `HEALTHCHECK` (`emeraldmd-server healthcheck`), so
`docker ps` shows whether the server answers. `docker stop` sends SIGTERM;
the server finishes open requests and closes the event streams before
exiting.

File watching relies on the host's file system notifications. On a Linux host
changes made outside the container are seen at once. Docker Desktop on macOS
and Windows may not forward them from bind mounts; changes made through the
server are always pushed.

## 4. Docker Compose with HTTPS

[`examples/`](../examples) runs the server behind
[Caddy](https://caddyserver.com), which gets and renews a Let's Encrypt
certificate by itself. You need a domain name pointing at the machine, with
ports 80 and 443 open.

```bash
cp -r examples /srv/emeraldmd && cd /srv/emeraldmd
cp .env.example .env              # set EMERALDMD_DOMAIN, and your uid/gid
mkdir -p vaults/notes             # or move an existing vault there
docker build -t emeraldmd-server /path/to/EmeraldMD   # or set EMERALDMD_IMAGE
docker compose run --rm emeraldmd token add laptop
docker compose up -d
```

`config/emeraldmd-server.toml` serves `vaults/notes` as the vault `notes`;
add more `[[vaults]]` there. The server is not published on any port: only
Caddy reaches it, on a Docker network with a fixed range that the config
lists in `trusted_proxies`. Caddy starts once the server reports healthy.

Afterwards:

```bash
docker compose exec emeraldmd emeraldmd-server token add phone
docker compose exec emeraldmd emeraldmd-server token list
docker compose kill -s HUP emeraldmd      # apply token or vault changes
docker compose logs -f emeraldmd
```

## 5. HTTPS without Compose

Tokens travel in every request, so anything other than `localhost` must be
served over HTTPS. Run the server on localhost or a private network and put a
reverse proxy in front. The proxy has to pass WebSocket upgrades for
`/api/vaults/{id}/events`. List the proxy's address in `trusted_proxies`.

### Caddy

Caddy gets and renews certificates by itself and proxies WebSockets without
extra settings:

```caddyfile
notes.example.com {
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:8484
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name notes.example.com;

    ssl_certificate     /etc/letsencrypt/live/notes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notes.example.com/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;

    # Match max_body_mb.
    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:8484;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSocket event stream
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
    }
}

# In the http block:
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

The server pings each event stream every 30 seconds, which keeps it open
through proxies with idle timeouts of a minute or more.

## 6. Operations

### Reloading the config

Send the server SIGHUP to re-read its config file and environment without a
restart:

```bash
kill -HUP "$(pidof emeraldmd-server)"     # Docker: docker kill -s HUP emeraldmd
```

A reload applies tokens, vaults, `allowed_origins` and `trusted_proxies`:

- New tokens work at once. Revoked tokens stop working at once, their open
  event streams are closed, and tickets they obtained no longer open one.
- New vaults are opened and indexed before anything switches. Removed vaults
  stop being served and their event streams are closed. A vault whose entry
  changed is reopened, and its clients reload their snapshot.
- `bind`, `max_body_mb` and `max_streams_per_token` need a restart; the log
  says so when they changed.

If the new config does not load (a syntax error, a vault folder that does
not exist), the log says why and the server keeps the previous config.
Check the log after a reload, especially after revoking a token.

### Version history

Like Obsidian Sync, the server keeps earlier versions of every file and the
files that were deleted, for `keep_days` (30 by default). In the app, use
"Server: Show version history" on a note, or "Server: Show deleted files", to
look at a version, compare it with the current text, and restore it.

- A version is a file's content after a change. Changes less than
  `interval_minutes` apart (5 by default) update the same version, so a burst
  of typing keeps one version: its last state.
- Before the server first changes or deletes a file, it keeps the content
  the file had, so the state before the first change can be restored too.
- Changes made outside the server (another program, a sync tool) get
  versions as well; renames move a file's versions with it.
- Files larger than `max_file_mb` (10 by default) get no versions. The
  `.obsidian` folder has none either.

Versions are kept in `[history] dir`, outside the vaults: by default a
`history` folder next to the config file (with the Docker example,
`/srv/emeraldmd/config/history`), or `EMERALDMD_HISTORY_DIR`. Without a
config file or that variable, or with `enabled = false`, there is no history.
The folder holds the notes' contents: it is created readable by the server's
user only, and belongs in your backups. Changing `[history]` takes effect on
a reload (the vaults are reopened).

### Health check

`GET /healthz` answers `{"status": "ok"}` without a token and tells nothing
else. `emeraldmd-server healthcheck [ADDRESS]` requests it and exits 0 if the
server answered; without an address it uses the configured `bind`
(`0.0.0.0` becomes `127.0.0.1`). The Docker image uses it as its
`HEALTHCHECK`.

### Limits

| What | Limit |
|---|---|
| Failed logins | Per client address: 10 tries, then one every 6 seconds; `429` with `Retry-After`. Tokens the server has already verified are not affected. |
| Logins being checked | 2 at a time, 32 waiting; beyond that `503` with `Retry-After: 1`. |
| Request bodies | `max_body_mb` (`413` above it); 64 KiB for folders, rename, trash and tickets. |
| Event streams | `max_streams_per_token` per token (`429`); client messages up to 16 KiB. |

Each rejected token is logged at `warn` with the client address, which tools
like fail2ban can watch.

## 7. Connect the app

On the start screen, or with the server button next to the vault switcher, choose
**Connect to server**, enter the server's URL (`https://notes.example.com`) and
a token. If the token can open several vaults, pick one. The app remembers the
server and vault; the token goes to the operating system's keychain (macOS
Keychain, Windows Credential Manager, the Secret Service on Linux), not to the
app's settings file.

An online vault shows changes made elsewhere as they happen (the dot next to
the vault's name is green). If the server becomes unreachable (orange dot):

- edits keep going: notes that cannot be saved say *Not saved yet, retrying*
  in the status bar and are saved again every 15 seconds, and as soon as the
  connection is back (a notice says when everything is saved);
- notes already open stay open; a note not loaded yet says it cannot be
  opened, and opens by itself when the server is back;
- closing the window or quitting asks before dropping changes that could not
  be saved.

To work offline for longer, keep a synced copy instead (see
[sync.md](sync.md)).

## API

For other clients and scripts. Every request but `/healthz` carries
`Authorization: Bearer <token>`. Paths are vault paths (`Folder/Note.md`).
Errors are `{"error": "message"}` with status 400 (bad path), 401 (missing or
invalid token), 404 (unknown vault or file), 409 (already exists), 413 (body
too large), 422 (not UTF-8 text), 429 (too many failed logins or event
streams), 503 (server busy) or 500. Every response carries
`Cache-Control: no-store` and other security headers.

| Request | Body | Response |
|---|---|---|
| `GET /healthz` | | `{"status": "ok"}`, no token needed |
| `GET /api/vaults` | | `[{"id", "name"}]` the token may open, with `"readOnly": true` for a read-only token |
| `GET /api/vaults/{id}/snapshot` | | Files, metadata and links (the app's `VaultSnapshot`), plus `epoch` and `version` (and `readOnly` for a read-only token) |
| `GET /api/vaults/{id}/files?path=` | | The file's text |
| `PUT /api/vaults/{id}/files?path=` | The new text | `VaultUpdate` |
| `POST /api/vaults/{id}/files` | `{"path", "data"}` | `VaultUpdate`; 409 if it exists |
| `GET /api/vaults/{id}/raw?path=` | | The file's bytes, attachments included |
| `PUT /api/vaults/{id}/raw?path=` | The bytes | `VaultUpdate`; Markdown must be UTF-8 |
| `GET /api/vaults/{id}/manifest` | | `{path: {"hash", "size"}}` for every visible file (SHA-256), for sync clients; `?config=true` adds the `.obsidian` files (not `workspace.json`) and the `X-EmeraldMD-Manifest-Config` header |
| `GET /api/vaults/{id}/search?q=` | | Search with Obsidian's query syntax ([search.md](search.md)); also `caseSensitive=true`, `sort` (`path-asc`, `path-desc`, `modified-newest`, `modified-oldest`, `created-newest`, `created-oldest`) and `limit`. `{"files", "totalFiles"}` |
| `POST /api/vaults/{id}/folders` | `{"path"}` | `VaultUpdate` |
| `POST /api/vaults/{id}/rename` | `{"from", "to"}` | `VaultUpdate` |
| `POST /api/vaults/{id}/trash` | `{"path"}` | `VaultUpdate` (moved to `.trash`) |
| `GET /api/vaults/{id}/history?path=` | | `{"versions": [{"time", "size"}]}`, newest first (`time` in ms); `404` when version history is off |
| `GET /api/vaults/{id}/history/raw?path=&time=` | | The bytes of that version |
| `GET /api/vaults/{id}/history/deleted` | | `[{"path", "deletedAt", "size"}]`: deleted files that have versions, most recent first |
| `GET /api/vaults/{id}/config/list?path=` | | `{"files", "folders"}` of a folder in `.obsidian` |
| `GET /api/vaults/{id}/config/stat?path=` | | The entry of a path in `.obsidian`, or `null` |
| `PUT /api/vaults/{id}/config/file?path=` | The new content (text or bytes) | 204; writes a file in `.obsidian` (read it with `GET /files` or `GET /raw`). Not announced on the event stream |
| `POST /api/vaults/{id}/config/folders` | `{"path"}` | 204; creates a folder in `.obsidian` |
| `POST /api/vaults/{id}/config/trash` | `{"path"}` | 204; moves a file or folder inside `.obsidian` (a plugin's folder to uninstall it, a settings file deleted on a synced device) to `.trash`; `.obsidian` itself is refused |
| `POST /api/vaults/{id}/events/ticket` | | `{"ticket", "expiresInSecs"}` |
| `GET /api/vaults/{id}/events` | | WebSocket, see below |

A `VaultUpdate` lists what changed: `renamed` (`[from, to]` pairs), `removed`
paths, `upserted` file entries, and the new `metadata` and `links` of affected
notes. It is the same JSON the desktop app gets from its local core.

**Event stream.** Browsers cannot send headers when opening a WebSocket, so
web clients first get a single-use ticket (valid 30 seconds) and open
`/api/vaults/{id}/events?ticket=…`; other clients can send the
`Authorization` header instead. Further query parameters:

- `epoch` and `since`: the `epoch` and `version` from the snapshot. The server
  first sends the updates the client missed since then.
- `client`: an id the client also sends as the `X-EmeraldMD-Client` header on
  its own changes, which are then not echoed back to it.

Messages are `{"type": "update", "version": n, "update": VaultUpdate}`, or
`{"type": "resync"}` when the server cannot replay what was missed (the server
restarted or reopened the vault, or the client was away for more than 1024
changes). After a resync the client reloads the snapshot. The server closes
the stream with code 1001 when it shuts down or stops serving the vault, and
1008 when the token is revoked.
