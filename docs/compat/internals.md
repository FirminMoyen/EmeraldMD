# Plugin runtime: interfaces outside the public typings

Community plugins rely on more than the published `obsidian.d.ts`. This page
lists what EmeraldMD provides beyond the typings, and how each interface was
established. Sources are the public typings, the official sample plugin's build
setup, and how open-source plugins in the compat corpus (`compat/plugins.json`,
all MIT) call these interfaces. None of it comes from Obsidian's application
code.

## How a plugin is loaded

Observed from plugin bundles and the sample plugin's build configuration.

- A plugin is a folder `<vault>/.obsidian/plugins/<folder>/` with
  `manifest.json`, `main.js`, optionally `styles.css`, and its saved settings in
  `data.json`. The plugin id comes from the manifest, not the folder name.
- `<vault>/.obsidian/community-plugins.json` is a JSON array of enabled plugin
  ids.
- `main.js` is CommonJS. It gets `require`, `module` and `exports`, and exports
  the plugin class as `module.exports` or `module.exports.default`.
- Bundles keep `obsidian`, `@codemirror/*`, `@lezer/*` and `moment` external, so
  `require` must return them, as the same instances the editor uses. EmeraldMD
  provides `obsidian`, `moment`, `@codemirror/{autocomplete, collab, commands,
  language, lint, search, state, view}` and `@lezer/{common, highlight, lr}`.
  Node built-ins and `electron` throw a "Cannot find module" error for now.
- `data.json` is written as JSON with 2-space indentation.
- Plugins that need a newer API than `packages/api/API_VERSION` (`minAppVersion`)
  are refused with an error in the plugin list.

## Restricted mode

Community plugins run code, so none run until the user turns them on for a
vault (Settings → Community plugins). EmeraldMD stores that choice in its own
app settings (`trustedVaults`), not inside the vault, so copying a vault onto a
machine does not switch plugins on.

## Members of `app` that plugins use

| Interface | What EmeraldMD provides | Seen in |
|---|---|---|
| `app.plugins` | `manifests`, `plugins`, `enabledPlugins` (Set), `getPlugin`, `isEnabled`, `enablePlugin`, `disablePlugin`, `enablePluginAndSave`, `disablePluginAndSave`, `loadManifests` | Calendar, Commander, Homepage, Natural Language Dates, Periodic Notes, QuickAdd, Dataview |
| `app.commands` | `commands` (by id), `editorCommands`, `addCommand`, `removeCommand`, `findCommand`, `listCommands`, `executeCommandById`, `executeCommand` | Commander, Homepage, Linter, QuickAdd, Periodic Notes |
| `app.setting` | The settings modal: `open`, `close`, `openTabById`, `pluginTabs`, `settingTabs`, `activeTab`, `addSettingTab`, `removeSettingTab` | Setting tabs of every plugin with settings |
| `app.internalPlugins` | `plugins`, `getPluginById`, `getEnabledPluginById` (none are enabled until core plugins arrive in phase 2) | Calendar, Dataview, Homepage, Iconize, Natural Language Dates, Outliner, Periodic Notes, QuickAdd |
| `app.viewRegistry` | `viewByType`, `typeByExtension`, `registerView`, `unregisterView`, `registerExtensions`, `getTypeByExtension`, `getViewCreatorByType` | Homepage, and plugins with custom views |
| `app.metadataTypeManager` | Property types: `getAllProperties`, `getAssignedType`, `getPropertyInfo`, `getTypeInfo`, `setType`, `unsetType`. Assigned types are stored in `.obsidian/types.json` as `{ "types": { name: type } }` | Tasks, QuickAdd |
| `app.statusBar.containerEl` | The status bar element | Commander |
| `app.workspace.leftRibbon.items` / `.ribbonItemsEl` | Ribbon buttons as `{ id, icon, title, callback, buttonEl, hidden }`, and their container | Commander |
| `app.workspace.iterateCodeMirrors` | Iterates CodeMirror 5 editors; there are none | Admonition |
| `app.vault.config`, `vault.getConfig`, `vault.setConfig` | App settings from `.obsidian/app.json` and `appearance.json`, with defaults for common keys (`mobileToolbarCommands` defaults to an empty list) | `getConfig`: Calendar, Commander, Linter, Minimal Theme Settings, Natural Language Dates, QuickAdd, Tasks; `config`: Homepage, Outliner |
| `app.foldManager` | `load` returns no folds and `save` does nothing (folds are not persisted yet) | Calendar, Homepage, Natural Language Dates, Periodic Notes (through the daily-notes helper library) |
| `app.dom.appContainerEl` | The app's root element | Periodic Notes, QuickAdd |
| `app.isMobile`, `app.appId` | `false`; a stable id per vault folder | Calendar, Dataview, Outliner, Commander |
| `editor.cm` | The CodeMirror 6 `EditorView` behind an `Editor` | Linter, Outliner and other editor plugins |

## Globals

| Global | What EmeraldMD provides | Seen in |
|---|---|---|
| `app`, `moment` | The app and moment instance, like the `obsidian` exports | Calendar, Dataview, Homepage, Linter, Natural Language Dates, Periodic Notes, QuickAdd, Tasks |
| `CodeMirror` | A CodeMirror 5 mode registry (`defineMode`, `defineMIME`, `getMode`, `modes`, `mimeModes`). Plugins register code-block syntax modes there; nothing renders with it yet | Admonition, Dataview |
| `CodeMirrorAdapter` | Vim mode's adapter, as an empty `{ commands: {} }` until Vim mode exists | Linter, Outliner |
| `createEl`, `createDiv`, `sleep`, `activeDocument`, … | The DOM helpers declared in the typings' `declare global` block (non-enumerable) | Most plugins |

## Platform

`Platform.isDesktop` is `true`, but `Platform.isDesktopApp` is `false`. Plugins
read `isDesktopApp` as "Node.js and Electron are available" and only then
`require('fs')` or `require('electron')`. That is not the case in EmeraldMD's
webview until the Node shims exist, so plugins take their mobile code path.

## DOM class names

The UI uses the class names that plugin and theme CSS targets, as described in
the public theme documentation: `.modal-container > .modal > .modal-close-button,
.modal-title, .modal-content`; `.setting-item > .setting-item-info
(.setting-item-name, .setting-item-description) + .setting-item-control`;
`.checkbox-container.is-enabled`; `.vertical-tab-header`, `.vertical-tab-nav-item`,
`.vertical-tab-content`; `.prompt`, `.prompt-input`, `.prompt-results`,
`.suggestion-item.is-selected`, `.suggestion-highlight`; `.side-dock-ribbon-action`;
`.status-bar-item`; `.workspace-leaf-content[data-type] > .view-header + .view-content`;
`.notice-container > .notice`; `.menu > .menu-item`.

## Not provided yet

- Node built-ins and `electron` (desktop-only plugins, and some that are not
  marked desktop-only, such as Auto Link Title, which requires `electron`).
- Bases views and value classes, reading view and live preview, page previews
  (`HoverPopover`), tabs and splits in the main area, popout windows.
- Binary file access: `readBinary`/`writeBinary` treat content as UTF-8 text.
- `vault.adapter.remove`/`rename` inside `.obsidian` (refused); outside it,
  `remove` moves files to the vault's `.trash`.
- `onExternalSettingsChange` (plugins are not told when `data.json` changes on disk).
- MathJax, Mermaid, PDF.js and Prism (`loadMathJax` and friends reject).
