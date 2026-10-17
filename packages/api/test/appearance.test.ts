// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addPluginStyle, hexToHsl } from '../src';
import { createTestApp } from '../src/testing';

/** A stand-in for `matchMedia('(prefers-color-scheme: dark)')` that tests can flip. */
function fakeColorScheme(dark: boolean) {
	const listeners = new Set<() => void>();
	const query = {
		matches: dark,
		addEventListener: (_: string, cb: () => void) => listeners.add(cb),
		removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
	};
	vi.stubGlobal('matchMedia', () => query);
	return {
		set(next: boolean) {
			query.matches = next;
			for (const cb of listeners) cb();
		},
	};
}

function resetPage() {
	document.head.innerHTML = '';
	document.body.className = 'theme-light';
	document.body.removeAttribute('style');
}

const appearanceJson = (config: Record<string, unknown>) => ({ '.obsidian/appearance.json': JSON.stringify(config) });

describe('hexToHsl', () => {
	it('converts hex colours', () => {
		expect(hexToHsl('#ff0000')).toEqual({ h: 0, s: 100, l: 50 });
		expect(hexToHsl('#0f9d6b')).toEqual({ h: 159, s: 83, l: 34 });
		expect(hexToHsl('#FFF')).toEqual({ h: 0, s: 0, l: 100 });
		expect(hexToHsl('teal')).toBeNull();
	});
});

describe('Appearance', () => {
	beforeEach(resetPage);
	afterEach(() => vi.unstubAllGlobals());

	it('applies appearance.json to the page', async () => {
		fakeColorScheme(false);
		const { app } = await createTestApp(
			{},
			appearanceJson({ theme: 'obsidian', accentColor: '#ff0000', baseFontSize: 20, textFontFamily: 'Georgia', showRibbon: false }),
		);
		app.appearance.load();
		const style = document.body.style;
		expect(document.body.classList.contains('theme-dark')).toBe(true);
		expect(app.isDarkMode()).toBe(true);
		expect(app.getTheme()).toBe('obsidian');
		expect([style.getPropertyValue('--accent-h'), style.getPropertyValue('--accent-s'), style.getPropertyValue('--accent-l')]).toEqual(['0', '100%', '50%']);
		expect(style.getPropertyValue('--font-text-size')).toBe('20px');
		expect(style.getPropertyValue('--font-text-override')).toMatch(/^Georgia, var\(--font-text-theme/);
		expect(style.getPropertyValue('--font-interface-override')).toBe('');
		expect(document.body.classList.contains('hide-ribbon')).toBe(true);
	});

	it('follows setting changes and fires css-change', async () => {
		fakeColorScheme(false);
		const { app } = await createTestApp({}, appearanceJson({ theme: 'obsidian', accentColor: '#ff0000' }));
		app.appearance.load();
		const changes = vi.fn();
		app.workspace.on('css-change', changes);
		app.changeTheme('moonstone');
		expect(document.body.classList.contains('theme-light')).toBe(true);
		expect(document.body.classList.contains('theme-dark')).toBe(false);
		app.vault.setConfig('accentColor', null);
		expect(document.body.style.getPropertyValue('--accent-h')).toBe('');
		app.vault.setConfig('baseFontSize', 99);
		expect(document.body.style.getPropertyValue('--font-text-size')).toBe('30px');
		expect(changes).toHaveBeenCalledTimes(3);
	});

	it('follows the system scheme only when set to adapt', async () => {
		const scheme = fakeColorScheme(true);
		const { app } = await createTestApp();
		app.appearance.load();
		expect(app.appearance.setting()).toBe('system');
		expect(app.isDarkMode()).toBe(true);
		scheme.set(false);
		expect(app.isDarkMode()).toBe(false);
		app.changeTheme('obsidian');
		scheme.set(true);
		scheme.set(false);
		expect(app.isDarkMode()).toBe(true);
	});

	it('lets plugins show a scheme without saving it, like Minimal Settings does', async () => {
		fakeColorScheme(false);
		const { app, config } = await createTestApp();
		app.appearance.load();
		app.setTheme('obsidian');
		expect(app.isDarkMode()).toBe(true);
		expect(config.files.get('.obsidian/appearance.json')).toBeUndefined();
	});
});

describe('CustomCss', () => {
	beforeEach(resetPage);
	afterEach(() => vi.useRealTimers());

	const vault = {
		'.obsidian/appearance.json': JSON.stringify({ cssTheme: 'Ocean', enabledCssSnippets: ['wide'] }),
		'.obsidian/themes/Ocean/manifest.json': JSON.stringify({ name: 'Ocean', version: '1.2.0', author: 'Someone', minAppVersion: '1.0.0' }),
		'.obsidian/themes/Ocean/theme.css': '.theme-dark { --background-primary: navy; }',
		'.obsidian/themes/Broken/manifest.json': '{ not json',
		'.obsidian/themes/Broken/theme.css': 'body { color: red; }',
		'.obsidian/themes/Notes/readme.md': 'not a theme: no theme.css',
		'.obsidian/themes/Legacy.css': 'body { --font-text-theme: serif; }',
		'.obsidian/snippets/wide.css': '.markdown-preview-view { --file-line-width: 100%; }',
		'.obsidian/snippets/accent.css': 'body { --accent-h: 200; }',
		'.obsidian/snippets/notes.txt': 'ignored',
	};

	const layers = () => [...document.head.children].map((el) => (el as HTMLElement).dataset.snippet ?? el.getAttribute('data-emerald-css') ?? el.getAttribute('data-plugin-id'));

	it('reads installed themes and snippets and applies the chosen ones', async () => {
		const { app } = await createTestApp({}, vault);
		await app.customCss.load();
		const css = app.customCss;
		expect(Object.keys(css.themes).sort()).toEqual(['Broken', 'Ocean']);
		expect(css.themes.Ocean).toMatchObject({ name: 'Ocean', version: '1.2.0', author: 'Someone', dir: '.obsidian/themes/Ocean' });
		expect(css.themes.Broken!.version).toBe('');
		expect(css.oldThemes).toEqual(['Legacy']);
		expect(css.snippets).toEqual(['accent', 'wide']);
		expect(css.theme).toBe('Ocean');
		expect(css.styleEl.textContent).toContain('navy');
		expect(css.extraStyleEls.map((el) => el.dataset.snippet)).toEqual(['wide']);
		expect(layers()).toEqual(['theme', 'wide']);
	});

	it('keeps plugin styles under the theme and snippets', async () => {
		const { app } = await createTestApp({}, vault);
		await app.customCss.load();
		const style = document.createElement('style');
		style.dataset.pluginId = 'dataview';
		addPluginStyle(style);
		expect(layers()).toEqual(['dataview', 'theme', 'wide']);
	});

	it('switches themes and snippets and saves the choice', async () => {
		const { app, config } = await createTestApp({}, vault);
		await app.customCss.load();
		const changes = vi.fn();
		app.workspace.on('css-change', changes);
		const css = app.customCss;

		css.setCssEnabledStatus('accent', true);
		await vi.waitFor(() => expect(css.extraStyleEls.map((el) => el.dataset.snippet)).toEqual(['accent', 'wide']));
		css.setCssEnabledStatus('wide', false);
		await vi.waitFor(() => expect(css.extraStyleEls.map((el) => el.dataset.snippet)).toEqual(['accent']));

		css.setTheme('Legacy');
		await vi.waitFor(() => expect(css.styleEl.textContent).toContain('serif'));
		expect(css.getThemePath('Legacy')).toBe('.obsidian/themes/Legacy.css');
		css.setTheme('');
		await vi.waitFor(() => expect(css.styleEl.textContent).toBe(''));

		const saved = JSON.parse(config.files.get('.obsidian/appearance.json')!) as Record<string, unknown>;
		expect(saved).toEqual({ cssTheme: '', enabledCssSnippets: ['accent'] });
		expect(changes).toHaveBeenCalledTimes(4);
	});

	it('ignores a chosen theme that is not installed', async () => {
		const { app } = await createTestApp({}, { '.obsidian/appearance.json': JSON.stringify({ cssTheme: 'Gone' }) });
		await app.customCss.load();
		expect(app.customCss.theme).toBe('Gone');
		expect(app.customCss.isThemeInstalled('Gone')).toBe(false);
		expect(app.customCss.styleEl.textContent).toBe('');
	});

	it('reloads snippets and the theme when their files change on disk', async () => {
		const { app, config } = await createTestApp({}, vault);
		await app.customCss.load();
		vi.useFakeTimers();
		config.files.set('.obsidian/snippets/wide.css', '.edited {}');
		config.files.set('.obsidian/snippets/new.css', '.new {}');
		app.customCss.onConfigFileChanged('.obsidian/snippets/wide.css');
		app.customCss.onConfigFileChanged('.obsidian/snippets/new.css');
		config.files.set('.obsidian/themes/Ocean/theme.css', '.ocean-v2 {}');
		app.customCss.onConfigFileChanged('.obsidian/themes/Ocean/theme.css');
		app.customCss.onConfigFileChanged('.obsidian/plugins/x/data.json');
		await vi.advanceTimersByTimeAsync(200);
		vi.useRealTimers();
		await vi.waitFor(() => expect(app.customCss.extraStyleEls[0]?.textContent).toBe('.edited {}'));
		expect(app.customCss.snippets).toEqual(['accent', 'new', 'wide']);
		await vi.waitFor(() => expect(app.customCss.styleEl.textContent).toBe('.ocean-v2 {}'));
	});
});
