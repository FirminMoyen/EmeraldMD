/**
 * The community plugin and theme directories, and installing from them, the
 * way Obsidian's own installer works:
 *
 * - the lists are `community-plugins.json`, `community-css-themes.json` and
 *   `community-plugin-stats.json` in the obsidianmd/obsidian-releases repo;
 * - a plugin's or theme's latest version is the `version` in the
 *   `manifest.json` on its repo's default branch;
 * - its files come from the GitHub release of that version (`main.js`,
 *   `manifest.json`, `styles.css`; for themes `theme.css`, falling back to the
 *   default branch for themes without releases).
 *
 * Files go to `<configDir>/plugins/<id>/` or `<configDir>/themes/<name>/`.
 * Installed plugins are not turned on, and restricted mode still applies.
 */

import { apiVersion, compareVersions, requestUrl, type App, type PluginManifest } from '@emeraldmd/api';

const RELEASES = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD';
/** Largest file accepted from a plugin or theme release. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface CommunityPlugin {
	id: string;
	name: string;
	author: string;
	description: string;
	/** `owner/name` on GitHub. */
	repo: string;
}

export interface CommunityTheme {
	name: string;
	author: string;
	repo: string;
	/** Path of the screenshot in the repo. */
	screenshot: string;
	/** `dark`, `light`. */
	modes: string[];
}

export interface PluginStats {
	downloads: number;
	/** When the latest version came out (ms since the epoch). */
	updated: number;
}

/** Fetches a URL: status and body. Tests replace it; the app uses `requestUrl`. */
export type Fetcher = (url: string) => Promise<{ status: number; text: string; arrayBuffer: ArrayBuffer }>;

const defaultFetcher: Fetcher = async (url) => {
	const response = await requestUrl({ url, throw: false });
	return { status: response.status, text: response.text, arrayBuffer: response.arrayBuffer };
};

/** Plugin ids name a folder: no separators or dots at the start. */
export function isValidPluginId(id: unknown): id is string {
	return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) && !id.includes('..');
}

/** Theme names name a folder too. */
export function isValidThemeName(name: unknown): name is string {
	return typeof name === 'string' && name.trim() === name && /^[^/\\:*?"<>|\u0000-\u001f]{1,100}$/.test(name) && name !== '.' && !name.includes('..');
}

function isRepo(repo: unknown): repo is string {
	return typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

export class CommunityDirectory {
	private plugins: CommunityPlugin[] | null = null;
	private themes: CommunityTheme[] | null = null;
	private stats: Record<string, PluginStats> | null = null;

	constructor(
		private readonly app: App,
		private readonly fetch: Fetcher = defaultFetcher,
	) {}

	private async json(url: string): Promise<unknown> {
		const response = await this.fetch(url);
		if (response.status === 404) return null;
		if (response.status < 200 || response.status >= 300) throw new Error(`${url} answered ${response.status}`);
		return JSON.parse(response.text) as unknown;
	}

	/** The plugin list, fetched once per session. */
	async listPlugins(): Promise<CommunityPlugin[]> {
		if (this.plugins) return this.plugins;
		const data = await this.json(`${RELEASES}/community-plugins.json`);
		const list = Array.isArray(data) ? data : [];
		this.plugins = list.filter(
			(p): p is CommunityPlugin => isValidPluginId(p?.id) && typeof p.name === 'string' && isRepo(p.repo),
		);
		return this.plugins;
	}

	/** Download counts and release dates, by plugin id. */
	async pluginStats(): Promise<Record<string, PluginStats>> {
		if (this.stats) return this.stats;
		const data = (await this.json(`${RELEASES}/community-plugin-stats.json`)) as Record<string, { downloads?: unknown; updated?: unknown }> | null;
		const stats: Record<string, PluginStats> = {};
		for (const [id, entry] of Object.entries(data ?? {})) {
			stats[id] = { downloads: typeof entry?.downloads === 'number' ? entry.downloads : 0, updated: typeof entry?.updated === 'number' ? entry.updated : 0 };
		}
		this.stats = stats;
		return stats;
	}

	async listThemes(): Promise<CommunityTheme[]> {
		if (this.themes) return this.themes;
		const data = await this.json(`${RELEASES}/community-css-themes.json`);
		const list = Array.isArray(data) ? data : [];
		this.themes = list
			.filter((t): t is CommunityTheme => isValidThemeName(t?.name) && isRepo(t.repo))
			.map((t) => ({ ...t, author: String(t.author ?? ''), screenshot: String(t.screenshot ?? ''), modes: Array.isArray(t.modes) ? t.modes.map(String) : [] }));
		return this.themes;
	}

	/** The manifest on the repo's default branch: the latest version. */
	async latestManifest(repo: string): Promise<Record<string, unknown> | null> {
		const data = await this.json(`https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`);
		return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
	}

	/** The repo's README, for the details pane. */
	async readme(repo: string): Promise<string> {
		const response = await this.fetch(`https://raw.githubusercontent.com/${repo}/HEAD/README.md`);
		return response.status === 200 ? response.text : '';
	}

	/** Why a plugin version cannot be installed, or null. */
	incompatibility(manifest: Record<string, unknown>): string | null {
		const min = manifest.minAppVersion;
		if (typeof min === 'string' && compareVersions(min, apiVersion) > 0) return `Needs app version ${min}; EmeraldMD implements ${apiVersion}.`;
		return null;
	}

	/** Downloads and writes the plugin's latest release. Returns its manifest. */
	async installPlugin(entry: CommunityPlugin): Promise<PluginManifest> {
		const latest = await this.latestManifest(entry.repo);
		const version = latest?.version;
		if (!latest || typeof version !== 'string' || !/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error(`${entry.name}: no version in its manifest.json`);
		const problem = this.incompatibility(latest);
		if (problem) throw new Error(problem);
		const base = `https://github.com/${entry.repo}/releases/download/${encodeURIComponent(version)}`;
		const main = await this.download(`${base}/main.js`);
		const manifestText = await this.download(`${base}/manifest.json`);
		const styles = await this.download(`${base}/styles.css`, true);
		if (main === null || manifestText === null) throw new Error(`${entry.name} ${version}: the release has no main.js or manifest.json`);
		const manifest = JSON.parse(manifestText) as PluginManifest;
		if (manifest.id !== entry.id) throw new Error(`${entry.name}: the release is for "${String(manifest.id)}", not "${entry.id}"`);
		const dir = `${this.app.vault.configDir}/plugins/${entry.id}`;
		const adapter = this.app.vault.adapter;
		await adapter.mkdir(dir);
		await adapter.write(`${dir}/main.js`, main);
		if (styles !== null) await adapter.write(`${dir}/styles.css`, styles);
		await adapter.write(`${dir}/manifest.json`, manifestText);
		return manifest;
	}

	/** Installed plugins with a newer version in the directory: id → latest version. */
	async findUpdates(installed: Record<string, PluginManifest>): Promise<Record<string, string>> {
		const byId = new Map((await this.listPlugins()).map((p) => [p.id, p]));
		const updates: Record<string, string> = {};
		await Promise.all(
			Object.values(installed).map(async (manifest) => {
				const entry = byId.get(manifest.id);
				if (!entry) return;
				try {
					const latest = await this.latestManifest(entry.repo);
					const version = latest?.version;
					if (typeof version === 'string' && compareVersions(version, manifest.version) > 0 && !this.incompatibility(latest!)) updates[manifest.id] = version;
				} catch (err) {
					console.error(`Could not check ${manifest.id} for updates`, err);
				}
			}),
		);
		return updates;
	}

	/** Downloads and writes the theme's latest version. */
	async installTheme(entry: CommunityTheme): Promise<void> {
		const latest = await this.latestManifest(entry.repo);
		const version = typeof latest?.version === 'string' && /^[0-9A-Za-z.+-]+$/.test(latest.version) ? latest.version : null;
		const fromRelease = (file: string) =>
			version ? this.download(`https://github.com/${entry.repo}/releases/download/${encodeURIComponent(version)}/${file}`, true) : Promise.resolve(null);
		const fromBranch = (file: string) => this.download(`https://raw.githubusercontent.com/${entry.repo}/HEAD/${file}`, true);
		const css = (await fromRelease('theme.css')) ?? (await fromBranch('theme.css')) ?? (await fromBranch('obsidian.css'));
		if (css === null) throw new Error(`${entry.name}: no theme.css in its release or repository`);
		const manifest = latest ? JSON.stringify({ ...latest, name: entry.name }, null, 2) : JSON.stringify({ name: entry.name, version: '0.0.0', author: entry.author }, null, 2);
		const dir = `${this.app.vault.configDir}/themes/${entry.name}`;
		const adapter = this.app.vault.adapter;
		await adapter.mkdir(dir);
		await adapter.write(`${dir}/theme.css`, css);
		await adapter.write(`${dir}/manifest.json`, manifest);
	}

	/** A file's text; null when it does not exist and `optional`. */
	private async download(url: string, optional = false): Promise<string | null> {
		const response = await this.fetch(url);
		if (response.status === 404 && optional) return null;
		if (response.status < 200 || response.status >= 300) {
			if (optional) return null;
			throw new Error(`${url} answered ${response.status}`);
		}
		if (response.arrayBuffer.byteLength > MAX_FILE_BYTES) throw new Error(`${url} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
		return response.text;
	}
}
