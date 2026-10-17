/**
 * `app.customCss`: community themes and CSS snippets, as vaults store them.
 *
 * - Themes: `<configDir>/themes/<name>/theme.css` with a `manifest.json`
 *   (the folder name is the theme name), or the older single file
 *   `<configDir>/themes/<name>.css`. The chosen one is `cssTheme` in
 *   appearance.json; an empty name is the default theme.
 * - Snippets: `<configDir>/snippets/<name>.css`; the enabled ones are
 *   `enabledCssSnippets` in appearance.json.
 *
 * The styles go at the end of `<head>`, theme first, then snippets, so both
 * override the app's and plugins' styles (`addPluginStyle` keeps plugin
 * styles before them). Every change fires `css-change` on the workspace.
 */

import { fileName, splitExtension } from '@emeraldmd/core';
import type { App } from './app';

export interface ThemeManifest {
	name: string;
	version: string;
	minAppVersion?: string;
	author?: string;
	authorUrl?: string;
	fundingUrl?: string | Record<string, string>;
	/** Folder of the theme, e.g. `.obsidian/themes/Minimal`. */
	dir: string;
}

const LAYER = 'data-emerald-css';

/** Adds a plugin's `<style>` before the theme and snippets, so they can override it. */
export function addPluginStyle(style: HTMLElement): void {
	document.head.insertBefore(style, document.head.querySelector(`[${LAYER}]`));
}

export class CustomCss {
	/** The chosen theme's name; `''` for the default theme. */
	theme = '';
	/** Installed themes with a manifest, by name. */
	themes: Record<string, ThemeManifest> = {};
	/** Installed single-file themes (`themes/<name>.css`). */
	oldThemes: string[] = [];
	/** Snippet names (file names without `.css`), sorted. */
	snippets: string[] = [];
	enabledSnippets = new Set<string>();
	/** The theme's `<style>`. */
	styleEl: HTMLStyleElement;
	/** One `<style>` per enabled snippet. */
	extraStyleEls: HTMLStyleElement[] = [];
	/** Read CSS by path. */
	csscache = new Map<string, string>();
	private readonly app: App;
	private themeTimer: ReturnType<typeof setTimeout> | null = null;
	private snippetTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(app: App) {
		this.app = app;
		this.styleEl = document.createElement('style');
		this.styleEl.setAttribute(LAYER, 'theme');
	}

	/** @internal Reads the installed themes and snippets and applies the vault's choice. */
	async load(): Promise<void> {
		const config = this.app.vault;
		const theme = config.getConfig('cssTheme');
		this.theme = typeof theme === 'string' ? theme : '';
		const enabled = config.getConfig('enabledCssSnippets');
		this.enabledSnippets = new Set(Array.isArray(enabled) ? enabled.filter((s): s is string => typeof s === 'string') : []);
		document.head.append(this.styleEl);
		await Promise.all([this.readThemes(), this.readSnippets()]);
		await Promise.all([this.loadTheme(), this.loadSnippets()]);
		this.changed();
	}

	/** @internal Removes the styles (when the vault closes). */
	unload(): void {
		this.styleEl.remove();
		for (const el of this.extraStyleEls.splice(0)) el.remove();
	}

	getThemeFolder(): string {
		return `${this.app.vault.configDir}/themes`;
	}

	getThemePath(name: string): string {
		return this.oldThemes.includes(name) && !this.themes[name]
			? `${this.getThemeFolder()}/${name}.css`
			: `${this.getThemeFolder()}/${name}/theme.css`;
	}

	getSnippetsFolder(): string {
		return `${this.app.vault.configDir}/snippets`;
	}

	getSnippetPath(name?: string): string {
		return name ? `${this.getSnippetsFolder()}/${name}.css` : this.getSnippetsFolder();
	}

	isThemeInstalled(name: string): boolean {
		return Boolean(this.themes[name]) || this.oldThemes.includes(name);
	}

	/** Chooses a theme by name (`''` for the default) and saves the choice. */
	setTheme(name: string): void {
		this.theme = name;
		this.app.vault.setConfig('cssTheme', name);
		void this.loadTheme().then(() => this.changed());
	}

	/** Turns a snippet on or off and saves the choice. */
	setCssEnabledStatus(name: string, enabled: boolean): void {
		if (enabled) this.enabledSnippets.add(name);
		else this.enabledSnippets.delete(name);
		this.app.vault.setConfig('enabledCssSnippets', [...this.enabledSnippets]);
		void this.loadSnippets().then(() => this.changed());
	}

	async readThemes(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const folder = this.getThemeFolder();
		const themes: Record<string, ThemeManifest> = {};
		const oldThemes: string[] = [];
		if (await adapter.exists(folder)) {
			const listing = await adapter.list(folder);
			for (const dir of listing.folders) {
				if (!(await adapter.exists(`${dir}/theme.css`))) continue;
				const name = fileName(dir);
				themes[name] = { ...(await this.readManifest(dir)), name, dir };
			}
			for (const file of listing.files) {
				const { basename, extension } = splitExtension(fileName(file));
				if (extension === 'css' && !themes[basename]) oldThemes.push(basename);
			}
		}
		this.themes = themes;
		this.oldThemes = oldThemes.sort((a, b) => a.localeCompare(b));
	}

	async readSnippets(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const folder = this.getSnippetsFolder();
		const names: string[] = [];
		if (await adapter.exists(folder)) {
			for (const file of (await adapter.list(folder)).files) {
				const { basename, extension } = splitExtension(fileName(file));
				if (extension === 'css') names.push(basename);
			}
		}
		this.snippets = names.sort((a, b) => a.localeCompare(b));
	}

	/** Reloads the theme soon, coalescing bursts of file events. */
	requestLoadTheme(): void {
		if (this.themeTimer) clearTimeout(this.themeTimer);
		this.themeTimer = setTimeout(() => {
			this.themeTimer = null;
			void this.readThemes()
				.then(() => this.loadTheme())
				.then(() => this.changed());
		}, 150);
	}

	/** Re-reads the snippets folder and reloads the enabled snippets soon. */
	requestLoadSnippets(): void {
		if (this.snippetTimer) clearTimeout(this.snippetTimer);
		this.snippetTimer = setTimeout(() => {
			this.snippetTimer = null;
			void this.readSnippets()
				.then(() => this.loadSnippets())
				.then(() => this.changed());
		}, 150);
	}

	/** @internal A file under the config folder changed on disk. */
	onConfigFileChanged(path: string): void {
		if (path === this.getThemeFolder() || path.startsWith(this.getThemeFolder() + '/')) this.requestLoadTheme();
		else if (path === this.getSnippetsFolder() || path.startsWith(this.getSnippetsFolder() + '/')) this.requestLoadSnippets();
	}

	private async loadTheme(): Promise<void> {
		const name = this.theme;
		const css = name && this.isThemeInstalled(name) ? await this.readCss(this.getThemePath(name)) : '';
		// The choice may have changed while the file was read.
		if (name === this.theme) this.styleEl.textContent = css;
	}

	private async loadSnippets(): Promise<void> {
		const enabled = this.snippets.filter((name) => this.enabledSnippets.has(name));
		const styles = await Promise.all(enabled.map(async (name) => ({ name, css: await this.readCss(this.getSnippetPath(name)) })));
		for (const el of this.extraStyleEls.splice(0)) el.remove();
		for (const { name, css } of styles) {
			const el = document.createElement('style');
			el.setAttribute(LAYER, 'snippet');
			el.dataset.snippet = name;
			el.textContent = css;
			document.head.append(el);
			this.extraStyleEls.push(el);
		}
	}

	private async readCss(path: string): Promise<string> {
		try {
			const css = await this.app.vault.adapter.read(path);
			this.csscache.set(path, css);
			return css;
		} catch (err) {
			console.error(`Could not read ${path}`, err);
			return '';
		}
	}

	private async readManifest(dir: string): Promise<Omit<ThemeManifest, 'name' | 'dir'>> {
		try {
			const data = JSON.parse(await this.app.vault.adapter.read(`${dir}/manifest.json`)) as Record<string, unknown>;
			const text = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : undefined);
			return {
				version: text('version') ?? '',
				minAppVersion: text('minAppVersion'),
				author: text('author'),
				authorUrl: text('authorUrl'),
				fundingUrl: (data.fundingUrl as ThemeManifest['fundingUrl']) ?? undefined,
			};
		} catch {
			return { version: '' };
		}
	}

	private changed(): void {
		this.app.workspace.trigger('css-change');
	}
}
