# Security of the self-hosted server

The desktop app has its own review: [security-desktop.md](security-desktop.md).

A review of `emeraldmd-server` (`crates/emerald-server`) done on 2026-10-17,
before it is run on the internet. It lists what was found, what changed, and
the risks that remain by design. Setup is in [self-hosting.md](self-hosting.md).

## What the server trusts

| Party | Trusted with |
|---|---|
| The operator | The config file, the vault folders, the machine. |
| A token holder | Reading and writing every file in the vaults the token is scoped to, including the config folder `.obsidian` (the app needs it for settings, themes and plugins). Nothing outside those folders, nothing in other vaults. |
| Anyone else on the network | `GET /healthz` only. |
| The reverse proxy | TLS, and naming the client in `X-Forwarded-For`, but only if listed in `trusted_proxies`. |

Tokens are 256-bit random values (`emd_` + 64 hex digits). The config holds
only their argon2id hashes (19 MiB, 2 passes, the OWASP recommendation), so
guessing a token is not a realistic attack. The limits below protect the
server's CPU and memory, and keep logs readable, rather than the tokens.

## Findings and fixes

Each fix has tests; the integration tests start a real server and talk HTTP
and WebSocket to it (`crates/emerald-server/tests/security.rs` and `ops.rs`).

### 1. Symbolic links led out of the vault (high, fixed)

`emerald_core` refuses `..`, `.` and drive prefixes, but it follows symbolic
links, which is right for the desktop app. On the server, a link inside a
vault folder (planted by a sync tool, a git checkout, a careless `ln -s`)
let every token holder read and write wherever it pointed: `/etc`, the
server's home folder, or another vault their token was not scoped to. It
worked on every endpoint: reads, writes, snapshot, manifest, search results
and the event stream.

Fix (`src/paths.rs`): every path a client names must resolve, through any
links, to a location inside the vault folder; for a path that does not exist
yet, the deepest existing part must. Dangling links are refused, since
writing through one would create its target. Listings leave out links that
lead outside and everything below them, with their metadata and the link
targets other notes resolve to. Links that stay inside the vault keep
working. The `.trash` folder is checked too, so a link there cannot make
"delete" move notes out of the vault.

### 2. Hidden files were readable (medium, fixed)

`GET /files` and `GET /raw` read any hidden path: `.git/config` (which often
holds a remote URL with credentials), `.env`, `.trash`. Writes to hidden
paths were already refused.

Fix: hidden paths can be read only inside the config folder `.obsidian`, with
links out of it refused (`Vault::config_path`). Other hidden paths answer
404, as if missing.

### 3. Failed logins were not limited (medium, fixed)

Any client could make the server run argon2 for every request with a made-up
token. Two verifications ran at a time, but requests queued without limit,
holding a connection and a task each, and each wrong token is checked against
every configured hash.

Fix (`src/limits.rs`):

- A token bucket per client address: 10 tries, then one more every 6 seconds.
  Only credentials that need argon2 spend a try (a token the server has not
  verified yet, or a ticket), and a valid one gives it back. Tokens already
  verified skip the bucket, so a phone retrying a revoked token does not lock
  out the laptop on the same network. Limited clients get `429` with
  `Retry-After`. IPv6 clients are counted by their /64, and at most 10,000
  addresses are tracked (beyond that they share one bucket).
- `X-Forwarded-For` is read only when the connection comes from an address in
  `trusted_proxies`, and then the right-most address that is not itself a
  trusted proxy is the client (entries further left are written by the client
  and can be forged).
- At most 32 verifications wait for an argon2 slot; more get `503` with
  `Retry-After: 1` at once.
- Each rejected credential is logged at `warn` with the client address, which
  is enough for fail2ban.

### 4. Cached token digests were compared with `==` (low, fixed)

Verified tokens are remembered by their SHA-256 digest, in a `HashMap`. Its
lookup compares digests byte by byte and stops at the first difference. As
the attacker controls the token and not the digest, the leak was not
exploitable, but nothing required it to stay that way.

Fix: the cache is a short list (one entry per verified token) and every entry
is compared with `subtle::ConstantTimeEq`, without stopping at a match.
Tickets are 256-bit random values looked up in a map; learning anything about
another ticket's hash bucket does not help guess it.

### 5. Errors leaked internals and were not always JSON (low, fixed)

`500` responses carried the I/O error text and, for a crashed task, the panic
message. axum's own rejections (bad query, bad JSON, body too large, unknown
route) were plain text. A NUL byte in a path gave a `500`.

Fix: `500` responses say only "internal server error", and the details go to
the server log. Every error is `{"error": "…"}` with the right status, and
invalid paths are `400`. Messages contain vault paths as the client sent
them, never server paths; the snapshot's `basePath` was already empty.
Panics in handlers are caught and answered with a `500`.

### 6. No security headers (low, fixed)

Every response now carries `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox`
(so a note or attachment opened in a browser can never run as a page),
`Cross-Origin-Resource-Policy: same-origin`, and `Cache-Control: no-store`, so
no proxy or browser cache keeps private notes. HSTS belongs to the TLS
terminator: the Caddy example sets it.

### 7. Request sizes were only partly limited (low, fixed)

`max_body_mb` applied only where a handler read the body, and routes that
carry nothing but a path accepted the same size as a note.

Fix: larger declared bodies are refused with `413` on every route before
anything is read, and `/folders`, `/rename`, `/trash` and `/events/ticket`
accept at most 64 KiB.

### 8. WebSocket limits (low, fixed)

Clients send nothing on the event stream but pings and closes, yet the
defaults accepted messages of 64 MiB. A token could open any number of
streams.

Fix: client messages and frames are limited to 16 KiB (a larger one closes
the stream), and one token can hold `max_streams_per_token` streams (default
16; tickets count for the token they came from). Slow readers already could
not grow memory: a client that falls more than 256 updates behind is told to
resync.

### 9. Revoking a token needed a restart, and did not close streams (medium, fixed)

Fix: `emeraldmd-server token revoke NAME` and SIGHUP. The reload rebuilds the
token list; verifications of tokens that are still configured carry over,
those of revoked tokens are dropped. Open event streams of a revoked token
are closed (code 1008), tickets it obtained earlier no longer work, and
streams of a vault that is no longer served are closed (1001). A config that
fails to load is logged and the previous one stays in force, so check the log
after a reload. Revoking the last token is allowed and locks everyone out.

### 10. Smaller items (fixed)

- Outstanding event tickets are capped at 10,000 (only token holders can
  create them).
- Request log spans hold the method and path but not the query string, which
  carries vault paths and event tickets.
- Token names must be unique and free of control characters, since they
  appear in logs and select tokens for `token revoke`.
- Allowed CORS origins are re-read on every request, so a reload applies them.

## Checked and unchanged

- **Authentication** covers every route but `/healthz`, unknown paths
  included. A token scoped to some vaults gets `404` for the others, like for
  vaults that do not exist.
- **CORS** allows only the app's webview origins plus `allowed_origins`.
- **`..`, absolute paths and drive prefixes** are refused by `emerald_core` on
  every endpoint (`/files`, `/raw`, `/folders`, `/rename` from and to,
  `/trash`); a leading `/` is a vault path, not an OS path, and a drive prefix
  is refused on Windows and is a plain folder name elsewhere. Tests:
  `every_endpoint_refuses_paths_outside_the_vault`.
- **Deleting** only moves things to the vault's `.trash`.
- **The Docker image** is distroless, without a shell, and runs as an
  unprivileged user.

## Known limits

- **Write access to the vault folders on the server** (not through the API)
  is outside what the server can defend against. Someone who can create files
  there can race the path checks (swap a folder for a link between check and
  use), add hard links to files elsewhere on the same disk, or plant a FIFO
  or a link to a device file that blocks or floods indexing. Do not let
  untrusted parties write to the vault folders directly, for example through
  a sync tool shared with untrusted devices.
- **TLS** is the reverse proxy's job; the server speaks plain HTTP and must
  not be exposed without one. Event tickets travel in the URL and can appear
  in the proxy's access log; they are single-use and expire after 30 seconds.
- **Behind a proxy without `trusted_proxies`**, every client has the proxy's
  address, so one client sending wrong tokens makes devices that have not
  signed in yet wait. Set `trusted_proxies`.
- **Tokens grant read and write** to whole vaults. There are no read-only
  tokens or per-folder scopes yet. The config folder is readable and
  writable (`/config/…`, so the app can keep a remote vault's settings,
  themes and hotkeys there), including plugin `data.json` files, which can
  hold API keys, and plugin code. The app does not run plugins from server
  vaults; a client that did would run code any holder of a token for that
  vault could change.
- **Search** runs with the vault's write lock (it caches note contents), so
  a heavy query delays writes to that vault. Regular expressions use the
  `regex` crate, which runs in linear time and caps compiled size.
- **Connection-level abuse** (many idle connections, slow headers) is left to
  the reverse proxy; the server sets no connection limit or header timeout of
  its own.
- **Each wrong token is checked against every hash**, so the CPU cost of a
  failed attempt grows with the number of tokens; the limits above bound it.

## Dependency audit

`cargo audit` (cargo-audit 0.22, RustSec database with 1,334 advisories,
2026-10-17) over the workspace's `Cargo.lock`, 595 crates: **no
vulnerabilities**, four warnings.

| Crate | Advisory | Reaches the server? | Assessment |
|---|---|---|---|
| `unsafe-libyaml` 0.2.11 | RUSTSEC-2024-0449, unmaintained | Yes: `serde_yaml_ng` in `emerald-core` parses note frontmatter, which clients write. | No known vulnerability. Moving `emerald-core` to a maintained YAML parser is a follow-up. |
| `glib` 0.18.5 | RUSTSEC-2024-0429, unsound `VariantStrIter` | No: GTK stack of the Linux desktop app (via `tauri`). | Not used by our code; goes away when Tauri moves to gtk-rs 0.20. |
| `proc-macro-error` 1.0.4 | RUSTSEC-2024-0370, unmaintained | No: build-time macro of the Linux desktop app's GTK crates. | Compile time only. |
| `inout` 0.2.3 | yanked | No: `keyring`'s Secret Service backend in the desktop app. | Updated with `keyring`. |

Run it again with `cargo install cargo-audit --locked && cargo audit`.
