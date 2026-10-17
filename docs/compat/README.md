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

- Notes and attachments are plain files. Settings live in `.obsidian/`. EmeraldMD
  reads `app.json`, `appearance.json`, `types.json`, `community-plugins.json`
  and the plugin folders there, and writes only what the user or a plugin
  changes (plugin `data.json`, the enabled-plugins list, settings set through
  `vault.setConfig`). Access goes through path-checked commands that refuse
  anything outside `.obsidian/`, including through symbolic links
  (`crates/emerald-core/src/config.rs`).
- Deleted files can go to `.trash/` inside the vault. EmeraldMD always does this.

## More

- [internals.md](internals.md): what plugins use beyond the public typings, and how it was established.
- [plugins.md](plugins.md): smoke-test results for popular community plugins (generated).
- [api-coverage.md](api-coverage.md): which exports and methods of the typings exist (generated).
