# Security of the desktop app

A review of the macOS app's attack surface (October 2026), alongside the
server's in [security.md](security.md).

## What the app trusts

| Source | Treated as |
|---|---|
| Notes, attachments, canvas files, settings in `.obsidian`, themes, CSS snippets | Untrusted data. Vaults are shared, synced and downloaded; nothing in them may run code. |
| Community plugins | Trusted code, once the user turns restricted mode off for that vault. The choice is kept in the app's settings, not in the vault, so a copied vault cannot turn plugins on. For a server vault the choice is kept per server and vault (`remote:<server URL>|<vault id>`); its plugins are stored on the server, so whoever can write to that vault there can change the code that runs here, which the Community plugins tab says. |
| A server | Trusted for the content of its vaults; the token is the authorization. |

The webview can call every command the Rust side registers (`invoke`), so
anything that runs code in the page has the app's privileges. Keeping
untrusted content inert is therefore the main line of defence.

## Findings and fixes

### 1. Formulas could carry `javascript:` links (high, fixed)

MathJax supports `\href{url}{text}`, which is valid TeX. A note with
`$\href{javascript:…}{x}$` rendered a link that ran code in the page when
clicked; that code could read server tokens through `remote_token` or turn
community plugins on.

Fix: the SVG MathJax produces goes through `sanitizeSvg` (scripts, `on…`
attributes and `javascript:` / `data:` / `vbscript:` / `file:` URLs removed),
and the page refuses to follow such URLs from any link, whatever drew it (a
capturing click handler in the shell). Test: `untrusted notes stay inert`.

### 2. Mermaid output relied on Mermaid alone (low, fixed)

Diagrams were already rendered at Mermaid's `strict` security level and
parsed as SVG (not HTML), but nothing removed event attributes if Mermaid
let one through. The output now goes through `sanitizeSvg` too.

### 3. `data:` and `vbscript:` links in note HTML were kept (low, fixed)

The HTML sanitizer removed only `javascript:` URLs. It now removes every
dangerous scheme, keeping `data:image/…` for inline images.

## Checked and unchanged

- **HTML in notes**: parsed in an inert `<template>`, then an allowlist of
  tags and attributes (no `on…` attributes, no `style`, no `<script>`,
  `<iframe>`, `<object>`, `<embed>`); inline HTML tags inside paragraphs
  are dropped.
- **`innerHTML`** is used only for HTML entities (which cannot contain
  tags), icons registered by plugins, and constants.
- **External links** open through `open_external`, which accepts only
  `http`, `https` and `mailto`.
- **Commands that take paths** stay inside their area: vault files through
  the core (no `..` or drive prefixes); `config_*` inside `.obsidian`, with
  symbolic links resolved; `config_trash` only for
  `.obsidian/plugins/<id>` and `.obsidian/themes/<name>`; `reveal_path`
  inside the open vault; `show_config_folder` only for the snippets and
  themes folders.
- **Community plugin installs**: ids and theme names must be plain folder
  names, the release's manifest id must match, files over 20 MB are
  refused, and an installed plugin stays off.
- **Server tokens** are stored in the macOS Keychain, never in files.

## Known limits

- **Community plugins have the app's privileges.** They can call every
  command: read server tokens from the Keychain (`remote_token`), open any
  folder as a vault and read it, make HTTP requests from the app
  (`request_url`). This is the trust Obsidian asks for as well (its plugins
  have full Node.js access). Separating plugin code from the app's own would
  need a different architecture (plugins in an isolated context).
- **No Content Security Policy** (`csp: null`): plugins evaluate code and
  load resources as they do in Obsidian, and a CSP would break many of them.
  Untrusted content is kept inert by sanitizing instead.
- **Plugin READMEs and theme screenshots** are loaded from GitHub while the
  browsers are open.
- **Debug builds** read a sync token from `EMERALDMD_DEV_SYNC_TOKEN` instead
  of the Keychain; release builds ignore it.

## Dependency audit

- `npm audit --omit=dev`: 0 vulnerabilities. KaTeX (a Mermaid dependency)
  is pinned to 0.18.11 for GHSA-238p-pmpm-9mq7.
- `cargo audit`: 0 vulnerabilities. Warnings only: crates no longer
  maintained (`proc-macro-error`; `unsafe-libyaml`, through
  `serde_yaml_ng`, which parses frontmatter; `zbus` and `zvariant`, Linux
  keyring) and `glib`'s `VariantStrIter` (Linux GTK). Replacing the YAML
  parser with a maintained pure-Rust one is a candidate follow-up.
