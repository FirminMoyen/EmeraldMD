// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createTestApp } from '@emeraldmd/api/testing';
import { CommunityDirectory, PluginHost, type Fetcher } from '../src';

const RELEASES = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD';
const MAIN = 'module.exports = class extends require("obsidian").Plugin {};';

/** A fake GitHub: URL → body (strings) or status. */
function github(routes: Record<string, string | number>): { fetch: Fetcher; requested: string[] } {
	const requested: string[] = [];
	const fetch: Fetcher = async (url) => {
		requested.push(url);
		const route = routes[url];
		if (route === undefined || typeof route === 'number') return { status: typeof route === 'number' ? route : 404, text: '', arrayBuffer: new ArrayBuffer(0) };
		return { status: 200, text: route, arrayBuffer: new TextEncoder().encode(route).buffer as ArrayBuffer };
	};
	return { fetch, requested };
}

const manifest = (id: string, version: string, extra: Record<string, unknown> = {}) =>
	JSON.stringify({ id, name: 'Sample', version, minAppVersion: '1.0.0', author: 'Someone', description: 'Does things', ...extra });

const directoryRoutes = (version: string, extra: Record<string, string | number> = {}) => ({
	[`${RELEASES}/community-plugins.json`]: JSON.stringify([
		{ id: 'sample', name: 'Sample', author: 'Someone', description: 'Does things', repo: 'someone/sample' },
		{ id: '../escape', name: 'Bad id', author: 'x', description: '', repo: 'x/y' },
		{ id: 'bad-repo', name: 'Bad repo', author: 'x', description: '', repo: 'not a repo' },
	]),
	[`${RELEASES}/community-plugin-stats.json`]: JSON.stringify({ sample: { downloads: 1234, updated: 1 } }),
	'https://raw.githubusercontent.com/someone/sample/HEAD/manifest.json': manifest('sample', version),
	[`https://github.com/someone/sample/releases/download/${version}/main.js`]: MAIN,
	[`https://github.com/someone/sample/releases/download/${version}/manifest.json`]: manifest('sample', version),
	...extra,
});

describe('CommunityDirectory', () => {
	it('lists plugins, leaving out entries that could escape their folder', async () => {
		const { app } = await createTestApp();
		const directory = new CommunityDirectory(app, github(directoryRoutes('1.0.0')).fetch);
		expect((await directory.listPlugins()).map((p) => p.id)).toEqual(['sample']);
		expect((await directory.pluginStats()).sample).toEqual({ downloads: 1234, updated: 1 });
	});

	it('installs the latest release into the plugins folder, without styles.css when there is none', async () => {
		const { app, config } = await createTestApp();
		const { fetch, requested } = github(directoryRoutes('1.2.0'));
		const directory = new CommunityDirectory(app, fetch);
		const [entry] = await directory.listPlugins();
		const installed = await directory.installPlugin(entry!);
		expect(installed.version).toBe('1.2.0');
		expect(config.files.get('.obsidian/plugins/sample/main.js')).toBe(MAIN);
		expect(JSON.parse(config.files.get('.obsidian/plugins/sample/manifest.json')!).version).toBe('1.2.0');
		expect(config.files.has('.obsidian/plugins/sample/styles.css')).toBe(false);
		expect(requested).toContain('https://github.com/someone/sample/releases/download/1.2.0/styles.css');
	});

	it('refuses a release for another id, or one that needs a newer app', async () => {
		const { app } = await createTestApp();
		const wrongId = github(directoryRoutes('1.0.0', { 'https://github.com/someone/sample/releases/download/1.0.0/manifest.json': manifest('other', '1.0.0') }));
		const directory = new CommunityDirectory(app, wrongId.fetch);
		await expect(directory.installPlugin((await directory.listPlugins())[0]!)).rejects.toThrow(/is for "other"/);

		const tooNew = github(directoryRoutes('2.0.0', { 'https://raw.githubusercontent.com/someone/sample/HEAD/manifest.json': manifest('sample', '2.0.0', { minAppVersion: '99.0.0' }) }));
		const strict = new CommunityDirectory(app, tooNew.fetch);
		await expect(strict.installPlugin((await strict.listPlugins())[0]!)).rejects.toThrow(/Needs app version 99.0.0/);
	});

	it('finds updates for installed plugins and uninstalls to the trash', async () => {
		const { app, config } = await createTestApp({}, { '.obsidian/plugins/sample/manifest.json': manifest('sample', '1.0.0'), '.obsidian/plugins/sample/main.js': MAIN });
		const host = new PluginHost(app, { isTrusted: async () => true, setTrusted: async () => {} });
		await host.initialize();
		const directory = new CommunityDirectory(app, github(directoryRoutes('1.1.0')).fetch);
		expect(await directory.findUpdates(host.manifests)).toEqual({ sample: '1.1.0' });

		await host.uninstallPlugin('sample');
		expect(host.manifests.sample).toBeUndefined();
		expect(config.files.has('.obsidian/plugins/sample/main.js')).toBe(false);
	});

	it('installs themes from their release, or from the repository without one', async () => {
		const { app, config } = await createTestApp();
		const routes = {
			[`${RELEASES}/community-css-themes.json`]: JSON.stringify([
				{ name: 'Ocean', author: 'A', repo: 'a/ocean', screenshot: 'shot.png', modes: ['dark'] },
				{ name: '../Evil', author: 'B', repo: 'b/evil', screenshot: '', modes: [] },
				{ name: 'Plain', author: 'C', repo: 'c/plain', screenshot: '', modes: ['light'] },
			]),
			'https://raw.githubusercontent.com/a/ocean/HEAD/manifest.json': JSON.stringify({ name: 'Ocean theme', version: '2.0.0' }),
			'https://github.com/a/ocean/releases/download/2.0.0/theme.css': '.ocean {}',
			'https://raw.githubusercontent.com/c/plain/HEAD/theme.css': '.plain {}',
		};
		const directory = new CommunityDirectory(app, github(routes).fetch);
		const themes = await directory.listThemes();
		expect(themes.map((t) => t.name)).toEqual(['Ocean', 'Plain']);
		await directory.installTheme(themes[0]!);
		await directory.installTheme(themes[1]!);
		expect(config.files.get('.obsidian/themes/Ocean/theme.css')).toBe('.ocean {}');
		expect(JSON.parse(config.files.get('.obsidian/themes/Ocean/manifest.json')!)).toEqual({ name: 'Ocean', version: '2.0.0' });
		expect(config.files.get('.obsidian/themes/Plain/theme.css')).toBe('.plain {}');
	});
});
