# Compatibility notes

Plain-language descriptions of interfaces that Obsidian plugins, themes and
vaults rely on. Each entry says what was observed and how, never how Obsidian
implements it. See the clean-room rules in [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Plugin runtime (desktop)

Observed with REA's static `analyze_javascript_application` on Obsidian 1.12.7
for macOS (Electron 39.8.3). Evidence: `ev_7c160cf9…54fd`.

- The UI page loads no preload script and uses no `contextBridge`.
  Desktop plugins therefore run with Node available and can `require` Node
  built-ins and `electron`.
- The bundle ships CodeMirror 6 and CodeMirror 5 legacy language modes, a Vim
  mode, MathJax, Mermaid, pdf.js, moment, Prism, PixiJS, i18next and
  Readability. Plugins mark `obsidian`, `electron`, `@codemirror/*` and
  `@lezer/*` as externals, so the host must provide those modules at runtime.

## Vault layout

- Notes and attachments are plain files. Settings live in `.obsidian/`, which
  EmeraldMD leaves untouched for now.
- Deleted files can go to `.trash/` inside the vault. EmeraldMD always does this.
