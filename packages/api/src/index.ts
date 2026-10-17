/**
 * @emeraldmd/api: the `obsidian` module (see ./obsidian.ts) plus the pieces
 * the shell and the plugin host need to wire it up.
 */

import { installDomHelpers } from './dom';

if (typeof window !== 'undefined') installDomHelpers(window);

export * from './obsidian';
export * as obsidianModule from './obsidian';
export { VaultAdapter, type ConfigStore } from './adapter';
export { type AppOptions, type PluginsApi } from './app';
export { applyTemplateVariables, DailyNotes, InternalPlugins, InternalPluginInstance, Templates, type InternalPlugin } from './core-plugins';
export { Appearance, hexToHsl, MAX_FONT_SIZE, MIN_FONT_SIZE, type BaseTheme, type ThemeSetting } from './appearance';
export { addPluginStyle, CustomCss, type ThemeManifest } from './custom-css';
export { Commands } from './commands';
export { HotkeyManager, sameHotkey } from './hotkeys';
export { confirmAction, type ConfirmOptions } from './confirm';
export { loadAsync } from './component';
export { installDomHelpers } from './dom';
export { CodeMirrorEditor, editorInfoExtensions, setLivePreviewEffect } from './editor';
export { eventKey, eventModifiers, formatHotkey, isMacOS } from './keymap';
export { renderMarkdownToDom } from './markdown';
export { setRequestBackend, type RawResponse, type RequestBackend } from './request';
export { AppSetting } from './setting-tab';
export { compareVersions } from './util';
export { EmptyView } from './views';
export { ViewRegistry, type WorkspaceHost } from './workspace';
