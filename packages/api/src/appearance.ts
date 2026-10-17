/**
 * The appearance settings from appearance.json applied to the page:
 *
 * - `theme`: the base color scheme, `'moonstone'` (light), `'obsidian'`
 *   (dark) or `'system'`, as the `theme-light` / `theme-dark` body class;
 * - `accentColor` (`#rrggbb`, empty for the theme's) as `--accent-h/s/l`;
 * - `baseFontSize` as `--font-text-size`;
 * - `interfaceFontFamily`, `textFontFamily`, `monospaceFontFamily` as
 *   `--font-*-override`, which win over the theme's `--font-*-theme`;
 * - `showRibbon` as the `hide-ribbon` body class.
 *
 * User choices are inline styles on `<body>`, so they win over themes.
 * App methods that plugins call (`app.setTheme`, `app.updateFontSize`…)
 * delegate here.
 */

import type { App } from './app';

export type BaseTheme = 'obsidian' | 'moonstone';
export type ThemeSetting = BaseTheme | 'system';

const FONT_KEYS: Record<string, string> = {
	interfaceFontFamily: '--font-interface-override',
	textFontFamily: '--font-text-override',
	monospaceFontFamily: '--font-monospace-override',
};

export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 30;

/** `#rrggbb` or `#rgb` to HSL components, or null when it is not a hex colour. */
export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!match) return null;
	let digits = match[1]!;
	if (digits.length === 3) digits = [...digits].map((d) => d + d).join('');
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255) as [number, number, number];
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return { h: 0, s: 0, l: Math.round(l * 100) };
	const s = d / (1 - Math.abs(2 * l - 1));
	let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	h = Math.round(h * 60);
	if (h < 0) h += 360;
	return { h, s: Math.round(s * 100), l: Math.round(l * 100) };
}

export class Appearance {
	private readonly app: App;
	private readonly media: MediaQueryList | null;
	private readonly onMediaChange = () => {
		if (this.setting() === 'system') this.applyColorScheme();
	};

	constructor(app: App) {
		this.app = app;
		this.media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
	}

	/** @internal Applies every setting and follows later changes. */
	load(): void {
		this.applyColorScheme();
		this.updateAccentColor();
		this.updateFontSize();
		this.updateFontFamily();
		this.updateRibbon();
		this.media?.addEventListener('change', this.onMediaChange);
		this.app.vault.on('config-changed', (key: string) => this.onConfigChanged(key));
	}

	/** @internal */
	unload(): void {
		this.media?.removeEventListener('change', this.onMediaChange);
	}

	/** The `theme` setting. */
	setting(): ThemeSetting {
		const value = this.app.vault.getConfig('theme');
		return value === 'obsidian' || value === 'moonstone' ? value : 'system';
	}

	/** The color scheme in use. */
	current(): BaseTheme {
		return document.body.classList.contains('theme-dark') ? 'obsidian' : 'moonstone';
	}

	/** Shows the light or dark scheme now, without saving it (`'system'` follows the OS). */
	setTheme(theme: ThemeSetting): void {
		const dark = theme === 'system' ? Boolean(this.media?.matches) : theme === 'obsidian';
		const changed = dark !== document.body.classList.contains('theme-dark') || !document.body.matches('.theme-light, .theme-dark');
		document.body.classList.toggle('theme-dark', dark);
		document.body.classList.toggle('theme-light', !dark);
		if (changed) this.app.workspace.trigger('css-change');
	}

	/** Saves and shows a base color scheme. */
	changeTheme(theme: ThemeSetting): void {
		this.app.vault.setConfig('theme', theme);
	}

	updateAccentColor(): void {
		const value = this.app.vault.getConfig('accentColor');
		const hsl = typeof value === 'string' ? hexToHsl(value) : null;
		const style = document.body.style;
		if (hsl) {
			style.setProperty('--accent-h', String(hsl.h));
			style.setProperty('--accent-s', `${hsl.s}%`);
			style.setProperty('--accent-l', `${hsl.l}%`);
		} else {
			for (const key of ['--accent-h', '--accent-s', '--accent-l']) style.removeProperty(key);
		}
	}

	updateFontSize(): void {
		const value = Number(this.app.vault.getConfig('baseFontSize'));
		const size = Number.isFinite(value) ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, value)) : 16;
		document.body.style.setProperty('--font-text-size', `${size}px`);
	}

	updateFontFamily(): void {
		const style = document.body.style;
		for (const [key, variable] of Object.entries(FONT_KEYS)) {
			const value = this.app.vault.getConfig(key);
			const fallback = variable.replace('-override', '-theme');
			const base = variable === '--font-monospace-override' ? 'var(--font-monospace-default)' : 'var(--font-default)';
			if (typeof value === 'string' && value.trim()) style.setProperty(variable, `${value}, var(${fallback}, ${base})`);
			else style.removeProperty(variable);
		}
	}

	private updateRibbon(): void {
		document.body.classList.toggle('hide-ribbon', this.app.vault.getConfig('showRibbon') === false);
	}

	private onConfigChanged(key: string): void {
		// setTheme fires css-change itself when the scheme changes.
		if (key === 'theme') return this.applyColorScheme();
		if (key === 'accentColor') this.updateAccentColor();
		else if (key === 'baseFontSize') this.updateFontSize();
		else if (key in FONT_KEYS) this.updateFontFamily();
		else if (key === 'showRibbon') this.updateRibbon();
		else return;
		this.app.workspace.trigger('css-change');
	}

	private applyColorScheme(): void {
		this.setTheme(this.setting());
	}
}
