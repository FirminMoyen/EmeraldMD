/**
 * Loads community plugins from `<configDir>/plugins/<folder>/` (manifest.json,
 * main.js, styles.css, data.json) and keeps `<configDir>/community-plugins.json`,
 * the list of enabled plugin ids, in the format Obsidian uses.
 *
 * Restricted mode: nothing runs until the user turns community plugins on
 * for this vault. That decision is stored by the shell (`TrustStore`), not
 * in the vault, so a downloaded vault cannot switch it on by itself.
 *
 * Exposed to plugins as `app.plugins`.
 */

import { addPluginStyle, compareVersions, apiVersion, loadAsync, Notice, Plugin, type App, type PluginManifest, type PluginsApi } from '@emeraldmd/api';
import { installPluginGlobals } from './globals';
import { NODE_MODULES, SHARED_MODULES, trackMissingExports } from './modules';

export interface TrustStore {
	isTrusted(): Promise<boolean>;
	setTrusted(trusted: boolean): Promise<void>;
}

/** What a plugin touched that EmeraldMD does not provide. */
export interface PluginDiagnostics {
	/** Modules the plugin required. */
	requiredModules: Set<string>;
	/** Modules that could not be provided (Node built-ins, Electron, unknown packages). */
	missingModules: Set<string>;
	/** Names read from the `obsidian` module that it does not export. */
	missingExports: Set<string>;
}

type PluginConstructor = new (app: App, manifest: PluginManifest) => Plugin;

export class PluginHost implements PluginsApi {
	manifests: Record<string, PluginManifest> = {};
	plugins: Record<string, Plugin> = {};
	/** Ids listed in community-plugins.json (enabled by the user), loaded or not. */
	enabledPlugins = new Set<string>();
	/** Why a plugin failed to load, by id (or by folder name for unreadable manifests). */
	errors: Record<string, string> = {};
	diagnostics: Record<string, PluginDiagnostics> = {};
	restricted = true;
	private readonly app: App;
	private readonly trust: TrustStore;
	private readonly styles = new Map<string, HTMLStyleElement>();
	private readonly listeners = new Set<() => void>();

	constructor(app: App, trust: TrustStore) {
		this.app = app;
		this.trust = trust;
		app.plugins = this;
		installPluginGlobals(app);
	}

	private get pluginsDir(): string {
		return `${this.app.vault.configDir}/plugins`;
	}

	private get configFile(): string {
		return `${this.app.vault.configDir}/community-plugins.json`;
	}

	/** Reads manifests and the enabled list, and loads enabled plugins unless in restricted mode. */
	async initialize(): Promise<void> {
		this.restricted = !(await this.trust.isTrusted());
		await this.loadManifests();
		this.enabledPlugins = new Set(await this.readEnabledList());
		if (!this.restricted) await this.loadEnabledPlugins();
		this.changed();
	}

	/** Re-reads every plugin folder's manifest.json. */
	async loadManifests(): Promise<void> {
		const adapter = this.app.vault.adapter;
		this.manifests = {};
		for (const key of Object.keys(this.errors)) if (!this.plugins[key]) delete this.errors[key];
		if (!(await adapter.exists(this.pluginsDir))) return;
		const { folders } = await adapter.list(this.pluginsDir);
		for (const folder of folders) {
			const folderName = folder.slice(folder.lastIndexOf('/') + 1);
			try {
				const manifest = JSON.parse(await adapter.read(`${folder}/manifest.json`)) as PluginManifest;
				if (typeof manifest.id !== 'string' || !manifest.id || typeof manifest.name !== 'string') {
					throw new Error('manifest.json needs an "id" and a "name"');
				}
				if (this.manifests[manifest.id]) throw new Error(`another folder already has plugin id "${manifest.id}"`);
				manifest.dir = folder;
				this.manifests[manifest.id] = manifest;
			} catch (err) {
				if ((err as { code?: string }).code === 'ENOENT') continue;
				this.errors[folderName] = `Could not read manifest.json: ${message(err)}`;
			}
		}
		this.changed();
	}

	getPlugin(id: string): Plugin | null {
		return this.plugins[id] ?? null;
	}

	isEnabled(id: string): boolean {
		return this.enabledPlugins.has(id);
	}

	/** Loads the plugin now. Returns false if it could not be loaded (see `errors`). */
	async enablePlugin(id: string): Promise<boolean> {
		if (this.restricted) return false;
		this.enabledPlugins.add(id);
		if (this.plugins[id]) return true;
		const manifest = this.manifests[id];
		if (!manifest) {
			this.errors[id] = 'Plugin is not installed';
			return false;
		}
		delete this.errors[id];
		let plugin: Plugin | null = null;
		try {
			if (manifest.minAppVersion && compareVersions(manifest.minAppVersion, apiVersion) > 0) {
				throw new Error(`requires app version ${manifest.minAppVersion}; EmeraldMD implements API ${apiVersion}`);
			}
			const code = await this.app.vault.adapter.read(`${manifest.dir}/main.js`);
			const PluginClass = this.evaluate(manifest, code);
			plugin = new PluginClass(this.app, manifest);
			if (!(plugin instanceof Plugin)) throw new Error('main.js does not export a Plugin subclass');
			this.plugins[id] = plugin;
			await this.loadStyles(manifest);
			await loadAsync(plugin);
			this.changed();
			return true;
		} catch (err) {
			console.error(`Plugin "${id}" failed to load`, err);
			this.errors[id] = message(err);
			delete this.plugins[id];
			if (plugin) safely(() => plugin!.unload());
			this.removeStyles(id);
			new Notice(`Plugin "${manifest.name}" failed to load: ${message(err)}`);
			this.changed();
			return false;
		}
	}

	/** Unloads the plugin and everything it registered. */
	async disablePlugin(id: string): Promise<void> {
		this.enabledPlugins.delete(id);
		const plugin = this.plugins[id];
		delete this.plugins[id];
		if (plugin) safely(() => plugin.unload());
		this.removeStyles(id);
		this.changed();
	}

	async enablePluginAndSave(id: string): Promise<boolean> {
		const ok = await this.enablePlugin(id);
		await this.saveEnabledList();
		if (ok) safely(() => this.plugins[id]?.onUserEnable());
		return ok;
	}

	async disablePluginAndSave(id: string): Promise<boolean> {
		await this.disablePlugin(id);
		await this.saveEnabledList();
		return true;
	}

	/** Turns the plugin off and moves its folder to the vault's trash. */
	async uninstallPlugin(id: string): Promise<void> {
		const manifest = this.manifests[id];
		if (!manifest?.dir) return;
		if (this.enabledPlugins.has(id)) await this.disablePluginAndSave(id);
		await this.app.vault.adapter.rmdir(manifest.dir, true);
		await this.loadManifests();
	}

	/** Reloads a plugin's code after an update, if it was running. */
	async reloadPlugin(id: string): Promise<void> {
		await this.loadManifests();
		if (!this.plugins[id]) return;
		await this.disablePlugin(id);
		await this.enablePlugin(id);
	}

	/** Turns restricted mode on (unloads every plugin) or off (loads the enabled ones). */
	async setRestricted(restricted: boolean): Promise<void> {
		await this.trust.setTrusted(!restricted);
		this.restricted = restricted;
		if (restricted) this.unloadAll();
		else await this.loadEnabledPlugins();
		this.changed();
	}

	/** Unloads every plugin without changing the enabled list (when the vault closes). */
	unloadAll(): void {
		for (const id of Object.keys(this.plugins)) {
			const plugin = this.plugins[id]!;
			delete this.plugins[id];
			safely(() => plugin.unload());
			this.removeStyles(id);
		}
	}

	/** Calls `listener` whenever plugins are loaded, unloaded or rescanned. Returns an unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async loadEnabledPlugins(): Promise<void> {
		for (const id of [...this.enabledPlugins]) {
			if (this.manifests[id]) await this.enablePlugin(id);
		}
	}

	private async readEnabledList(): Promise<string[]> {
		const adapter = this.app.vault.adapter;
		try {
			if (!(await adapter.exists(this.configFile))) return [];
			const ids = JSON.parse(await adapter.read(this.configFile)) as unknown;
			return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
		} catch (err) {
			console.error('community-plugins.json is not valid', err);
			return [];
		}
	}

	private async saveEnabledList(): Promise<void> {
		await this.app.vault.adapter.write(this.configFile, JSON.stringify([...this.enabledPlugins], null, 2));
	}

	private diagnosticsFor(id: string): PluginDiagnostics {
		return (this.diagnostics[id] ??= { requiredModules: new Set(), missingModules: new Set(), missingExports: new Set() });
	}

	/** Runs main.js as a CommonJS module and returns its exported plugin class. */
	private evaluate(manifest: PluginManifest, code: string): PluginConstructor {
		const diagnostics = this.diagnosticsFor(manifest.id);
		const obsidian = trackMissingExports(SHARED_MODULES.obsidian as object, (name) => diagnostics.missingExports.add(name));
		const require = (name: string): unknown => {
			const bare = name.startsWith('node:') ? name.slice(5) : name;
			diagnostics.requiredModules.add(bare);
			if (bare === 'obsidian') return obsidian;
			if (bare in SHARED_MODULES) return SHARED_MODULES[bare];
			diagnostics.missingModules.add(bare);
			const reason = NODE_MODULES.has(bare)
				? 'Node.js and Electron modules are not available in EmeraldMD yet'
				: 'EmeraldMD does not provide this module';
			throw Object.assign(new Error(`Cannot find module '${name}': ${reason}`), { code: 'MODULE_NOT_FOUND' });
		};
		const module = { exports: {} as Record<string, unknown> };
		const source = `${code}\n//# sourceURL=plugin:${encodeURIComponent(manifest.id)}`;
		// eslint-disable-next-line @typescript-eslint/no-implied-eval
		const run = new Function('require', 'module', 'exports', 'global', source) as (...args: unknown[]) => void;
		run(require, module, module.exports, globalThis);
		const exported = (module.exports.default ?? module.exports) as unknown;
		if (typeof exported !== 'function') throw new Error('main.js does not export a plugin class');
		return exported as PluginConstructor;
	}

	private async loadStyles(manifest: PluginManifest): Promise<void> {
		const path = `${manifest.dir}/styles.css`;
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(path))) return;
		const style = document.createElement('style');
		style.dataset.pluginId = manifest.id;
		style.textContent = await adapter.read(path);
		addPluginStyle(style);
		this.styles.set(manifest.id, style);
	}

	private removeStyles(id: string): void {
		this.styles.get(id)?.remove();
		this.styles.delete(id);
	}

	private changed(): void {
		for (const listener of this.listeners) safely(listener);
	}
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function safely(fn: () => unknown): void {
	try {
		fn();
	} catch (err) {
		console.error(err);
	}
}
