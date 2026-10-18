/**
 * `App`, the object every plugin receives. Besides the public members it
 * carries the undocumented ones popular plugins rely on (`commands`,
 * `setting`, `plugins`, `internalPlugins`, `viewRegistry`); see
 * docs/compat/internals.md.
 */

import { Events, type MetadataCache } from '@emeraldmd/core';
import { Appearance, type BaseTheme, type ThemeSetting } from './appearance';
import { Commands } from './commands';
import { defaultCorePlugins, InternalPlugins } from './core-plugins';
import { FileRecovery } from './file-recovery';
import { NoteComposer } from './note-composer';
import { RandomNote, SlashCommands, UniqueNoteCreator } from './small-core-plugins';
import { CustomCss } from './custom-css';
import { FileManager } from './file-manager';
import { HotkeyManager } from './hotkeys';
import { Keymap, Scope } from './keymap';
import { MetadataTypeManager } from './metadata-types';
import type { Modal } from './modal';
import type { PluginManifest, ObsidianProtocolHandler, Plugin } from './plugin';
import { AppSetting } from './setting-tab';
import type { Vault } from './vault';
import { ViewRegistry, Workspace } from './workspace';

export type UserEvent = MouseEvent | KeyboardEvent | TouchEvent | PointerEvent;

/** `app.plugins`: community plugins. Implemented by `@emeraldmd/plugin-host`. */
export interface PluginsApi {
	manifests: Record<string, PluginManifest>;
	plugins: Record<string, Plugin>;
	enabledPlugins: Set<string>;
	getPlugin(id: string): Plugin | null;
	isEnabled(id: string): boolean;
	enablePlugin(id: string): Promise<boolean>;
	disablePlugin(id: string): Promise<void>;
	enablePluginAndSave(id: string): Promise<boolean>;
	disablePluginAndSave(id: string): Promise<boolean>;
	loadManifests(): Promise<void>;
}

const noPlugins: PluginsApi = {
	manifests: {},
	plugins: {},
	enabledPlugins: new Set(),
	getPlugin: () => null,
	isEnabled: () => false,
	enablePlugin: async () => false,
	disablePlugin: async () => {},
	enablePluginAndSave: async () => false,
	disablePluginAndSave: async () => false,
	loadManifests: async () => {},
};

/** Secrets for plugins (API keys…). Kept in memory for now; a keychain-backed store comes later. */
export class SecretStorage extends Events {
	private readonly secrets = new Map<string, string>();

	setSecret(id: string, secret: string): void {
		this.secrets.set(id, secret);
		this.trigger('changed', id);
	}

	getSecret(id: string): string | null {
		return this.secrets.get(id) ?? null;
	}

	listSecrets(): string[] {
		return [...this.secrets.keys()];
	}
}

/** `app.statusBar`: the bottom bar that `Plugin.addStatusBarItem` adds to. */
export class StatusBar {
	containerEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		this.containerEl = containerEl;
	}
}

export class RenderContext {
	hoverPopover: unknown = null;
}

export class Tasks {
	private readonly promises: Promise<unknown>[] = [];

	add(callback: () => Promise<unknown>): void {
		this.promises.push(callback());
	}

	addPromise(promise: Promise<unknown>): void {
		this.promises.push(promise);
	}

	isEmpty(): boolean {
		return this.promises.length === 0;
	}

	promise(): Promise<unknown> {
		return Promise.all(this.promises);
	}
}

export interface AppOptions {
	vault: Vault;
	metadataCache: MetadataCache;
	/** Stable id for this vault, used to namespace local storage. */
	appId: string;
	/** Container for status bar items. A detached element when headless. */
	statusBarEl?: HTMLElement;
	/** Where the workspace lives. A detached element when headless. */
	workspaceEl?: HTMLElement;
}

export class App {
	keymap: Keymap;
	scope: Scope;
	workspace: Workspace;
	vault: Vault;
	metadataCache: MetadataCache;
	fileManager: FileManager;
	lastEvent: UserEvent | null = null;
	renderContext = new RenderContext();
	secretStorage = new SecretStorage();
	appId: string;
	/** @internal */
	commands: Commands;
	/** @internal Hotkeys per command; call `load()` once the vault is open. */
	hotkeyManager: HotkeyManager;
	/** @internal */
	setting: AppSetting;
	/** @internal */
	plugins: PluginsApi = noPlugins;
	/** @internal */
	internalPlugins = new InternalPlugins([...defaultCorePlugins(), new FileRecovery(), new NoteComposer(), new SlashCommands(), new RandomNote(), new UniqueNoteCreator()]);
	/** @internal */
	viewRegistry = new ViewRegistry();
	/** @internal Property types; call `load()` once the vault is open. */
	metadataTypeManager: MetadataTypeManager;
	/** @internal Themes and CSS snippets; call `load()` once the vault is open. */
	customCss: CustomCss;
	/** @internal Color scheme, accent and fonts from appearance.json; call `load()` once the vault is open. */
	appearance: Appearance;
	/** @internal */
	statusBar: StatusBar;
	/** @internal */
	protocolHandlers = new Map<string, ObsidianProtocolHandler>();
	/** @internal */
	openModals: Modal[] = [];
	/** @internal EmeraldMD's UI is the desktop layout. */
	isMobile = false;
	/** @internal */
	dom: { appContainerEl: HTMLElement };
	/** @internal Saved folds per file. EmeraldMD does not persist folds yet. */
	foldManager = {
		load: async (_file: unknown): Promise<null> => null,
		save: async (_file: unknown, _folds: unknown): Promise<void> => {},
	};
	private readonly cleanups: (() => void)[] = [];

	constructor(options: AppOptions) {
		this.vault = options.vault;
		this.metadataCache = options.metadataCache;
		this.appId = options.appId;
		this.scope = new Scope();
		this.keymap = new Keymap(this.scope);
		this.statusBar = new StatusBar(options.statusBarEl ?? createDiv('status-bar'));
		this.dom = { appContainerEl: document.body.querySelector<HTMLElement>('.app-container') ?? document.body };
		this.workspace = new Workspace(this, options.workspaceEl);
		this.fileManager = new FileManager(this);
		this.hotkeyManager = new HotkeyManager(this);
		this.commands = new Commands(this);
		this.setting = new AppSetting(this);
		this.metadataTypeManager = new MetadataTypeManager(this);
		this.customCss = new CustomCss(this);
		this.appearance = new Appearance(this);
		this.listen(window, 'keydown', (evt) => {
			this.lastEvent = evt as KeyboardEvent;
			this.keymap.onKeyEvent(evt as KeyboardEvent);
		});
		for (const type of ['mousedown', 'click', 'contextmenu']) {
			this.listen(window, type, (evt) => (this.lastEvent = evt as MouseEvent));
		}
	}

	isDarkMode(): boolean {
		return document.body.classList.contains('theme-dark');
	}

	/** @internal `'obsidian'` (dark) or `'moonstone'` (light): the scheme shown now. */
	getTheme(): BaseTheme {
		return this.appearance.current();
	}

	/** @internal Shows a color scheme without saving it; plugins save it with `vault.setConfig('theme', …)`. */
	setTheme(theme: ThemeSetting): void {
		this.appearance.setTheme(theme);
	}

	/** @internal Saves and shows a color scheme. */
	changeTheme(theme: ThemeSetting): void {
		this.appearance.changeTheme(theme);
	}

	/** @internal Applies `accentColor`. */
	updateAccentColor(): void {
		this.appearance.updateAccentColor();
	}

	/** @internal Applies `baseFontSize`. */
	updateFontSize(): void {
		this.appearance.updateFontSize();
	}

	/** @internal Applies the font settings. */
	updateFontFamily(): void {
		this.appearance.updateFontFamily();
	}

	loadLocalStorage(key: string): unknown {
		try {
			const value = localStorage.getItem(`${this.appId}-${key}`);
			return value === null ? null : JSON.parse(value);
		} catch {
			return null;
		}
	}

	saveLocalStorage(key: string, data: unknown): void {
		const name = `${this.appId}-${key}`;
		try {
			if (data === null || data === undefined) localStorage.removeItem(name);
			else localStorage.setItem(name, JSON.stringify(data));
		} catch (err) {
			console.error(err);
		}
	}

	/** @internal Removes global listeners (when the vault closes). */
	destroy(): void {
		for (const cleanup of this.cleanups.splice(0)) cleanup();
		for (const modal of [...this.openModals]) modal.close();
		this.appearance.unload();
		this.customCss.unload();
	}

	private listen(target: Window, type: string, listener: (evt: Event) => void): void {
		target.addEventListener(type, listener, true);
		this.cleanups.push(() => target.removeEventListener(type, listener, true));
	}
}
