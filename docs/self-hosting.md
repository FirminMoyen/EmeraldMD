# Self-hosting EmeraldMD

`emeraldmd-server` serves one or more vault folders to the EmeraldMD app over
HTTP, and pushes every change to connected apps over a WebSocket. A vault on
the server is an ordinary folder of Markdown files, so an existing Obsidian
vault can be served as it is, and you can keep editing it with other tools:
the server watches the folder and forwards outside changes too.

This is the first slice of self-hosting: the app reads and writes straight to
the server ("remote, online" in [ARCHITECTURE.md](ARCHITECTURE.md#vault-access-modes)),
so it needs a connection. Offline editing with a local copy and three-way
merge is the next slice. Until then, when two apps edit the same note at the
same moment, the last save wins.

## 1. Create an access token

Every request needs a bearer token. The server only stores an argon2id hash of
each token, never the token itself.

```bash
emeraldmd-server token new
```

It prints a random token (`emd_…`) and its hash. Keep the token for the app;
put the hash in the config. To hash a token you made yourself, pipe it into
`emeraldmd-server token hash`.

With Docker, run the same commands in the image:

```bash
docker run --rm emeraldmd-server token new
```

Make one token per device so you can revoke them one by one: remove the hash
from the config and restart the server.

## 2. Configure

The server reads a TOML file given with `--config FILE` or `EMERALDMD_CONFIG`:

```toml
# Address to listen on. Keep it on localhost (or a private Docker network)
# and put an HTTPS reverse proxy in front; see section 4.
bind = "127.0.0.1:8484"

# Largest note the server accepts, in MiB.
max_body_mb = 64

# Browser origins allowed to call the API, besides the EmeraldMD app itself
# (tauri://localhost, http://tauri.localhost, https://tauri.localhost).
allowed_origins = []

[[vaults]]
id = "notes"                  # used in URLs: letters, digits, - and _
path = "/srv/vaults/notes"
name = "Notes"                # optional, shown in the app; defaults to the folder name

[[vaults]]
id = "work"
path = "/srv/vaults/work"

[[tokens]]
name = "laptop"
hash = "$argon2id$v=19$m=19456,t=2,p=1$…"

[[tokens]]
name = "work-phone"
hash = "$argon2id$v=19$m=19456,t=2,p=1$…"
vaults = ["work"]             # optional: limit the token to these vaults
```

Environment variables add to the file, or replace it entirely:

| Variable | Meaning |
|---|---|
| `EMERALDMD_CONFIG` | Path of the TOML file (same as `--config`) |
| `EMERALDMD_BIND` | Listen address, e.g. `0.0.0.0:8484` |
| `EMERALDMD_VAULTS` | Extra vaults as `id=path` pairs separated by `;`, e.g. `notes=/vaults/notes;work=/vaults/work` |
| `EMERALDMD_TOKEN_HASHES` | Extra token hashes separated by whitespace; each may open every vault |
| `EMERALDMD_ALLOWED_ORIGINS` | Extra CORS origins, comma-separated |
| `RUST_LOG` | Log level, e.g. `info` (default) or `emerald_server=debug,tower_http=debug` |

The server refuses to start without at least one vault and one token, or if a
token entry holds something that is not an argon2 hash.

Vault rules are the same as in the desktop app: hidden files and folders
(`.obsidian`, `.trash`, dotfiles) are not listed, deleting moves things to the
vault's `.trash` folder, and no path can escape the vault folder.

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

Run it with your vaults and config mounted. The image runs as an unprivileged
user; pass `--user` with the owner of the vault files so the server can write
them:

```bash
docker run -d --name emeraldmd \
  --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:8484:8484 \
  -v /srv/vaults:/vaults \
  -v /srv/emeraldmd/emeraldmd-server.toml:/config/emeraldmd-server.toml:ro \
  -e EMERALDMD_CONFIG=/config/emeraldmd-server.toml \
  --restart unless-stopped \
  emeraldmd-server
```

In the config used in the container, vault paths are container paths
(`/vaults/notes`), and `bind` should be `0.0.0.0:8484` (the image sets
`EMERALDMD_BIND` to that). Publishing the port on `127.0.0.1` keeps it
reachable only through the reverse proxy on the same host.

Without a config file, the environment is enough. With Docker Compose, write
each `$` in a hash as `$$`:

```yaml
services:
  emeraldmd:
    image: emeraldmd-server
    user: "1000:1000"
    environment:
      EMERALDMD_VAULTS: "notes=/vaults/notes"
      EMERALDMD_TOKEN_HASHES: "$$argon2id$$v=19$$m=19456,t=2,p=1$$…"
    volumes:
      - /srv/vaults:/vaults
    ports:
      - "127.0.0.1:8484:8484"
    restart: unless-stopped
```

`docker stop` sends SIGTERM; the server finishes open requests and closes the
event streams before exiting.

File watching relies on the host's file system notifications. On a Linux host
changes made outside the container are seen at once. Docker Desktop on macOS
and Windows may not forward them from bind mounts; changes made through the
server are always pushed.

## 4. HTTPS

Tokens travel in every request, so anything other than `localhost` must be
served over HTTPS. Run the server on localhost or a private network and put a
reverse proxy in front. The proxy has to pass WebSocket upgrades for
`/api/vaults/{id}/events`.

### Caddy

Caddy gets and renews certificates by itself and proxies WebSockets without
extra settings:

```caddyfile
notes.example.com {
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

## 5. Connect the app

On the start screen, or with the server button next to the vault switcher, choose
**Connect to server**, enter the server's URL (`https://notes.example.com`) and
a token. If the token can open several vaults, pick one. The app remembers the
server and vault; the token goes to the operating system's keychain (macOS
Keychain, Windows Credential Manager, the Secret Service on Linux), not to the
app's settings file.

## API

For other clients and scripts. Every request carries
`Authorization: Bearer <token>`. Paths are vault paths (`Folder/Note.md`).
Errors are `{"error": "message"}` with status 400 (bad path), 401 (missing or
invalid token), 404 (unknown vault or file), 409 (already exists), 422 (not
UTF-8 text) or 500.

| Request | Body | Response |
|---|---|---|
| `GET /api/vaults` | | `[{"id", "name"}]` the token may open |
| `GET /api/vaults/{id}/snapshot` | | Files, metadata and links (the app's `VaultSnapshot`), plus `epoch` and `version` |
| `GET /api/vaults/{id}/files?path=` | | The file's text |
| `PUT /api/vaults/{id}/files?path=` | The new text | `VaultUpdate` |
| `POST /api/vaults/{id}/files` | `{"path", "data"}` | `VaultUpdate`; 409 if it exists |
| `POST /api/vaults/{id}/folders` | `{"path"}` | `VaultUpdate` |
| `POST /api/vaults/{id}/rename` | `{"from", "to"}` | `VaultUpdate` |
| `POST /api/vaults/{id}/trash` | `{"path"}` | `VaultUpdate` (moved to `.trash`) |
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
restarted, or the client was away for more than 1024 changes). After a resync
the client reloads the snapshot.
