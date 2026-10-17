/**
 * Settings → Appearance: color scheme, accent color, themes, fonts and CSS
 * snippets, saved in the vault's appearance.json like Obsidian does (see
 * `@emeraldmd/api` Appearance and CustomCss).
 */

import { debounce, MAX_FONT_SIZE, MIN_FONT_SIZE, Setting, SettingTab, type App, type ColorComponent, type ThemeSetting } from '@emeraldmd/api';

export interface AppearanceTabOptions {
	/** Shows a config folder (`.obsidian/snippets` or `.obsidian/themes`) in the file manager; absent for remote vaults. */
	showFolder?: (path: string) => Promise<void>;
}

const SCHEMES: Record<ThemeSetting, string> = { system: 'Adapt to system', moonstone: 'Light', obsidian: 'Dark' };

/** The accent in use (the theme's or the default) as `#rrggbb`. */
function currentAccent(): string {
	const probe = document.body.createSpan({ attr: { style: 'color: var(--color-accent); display: none' } });
	const rgb = getComputedStyle(probe).color.match(/\d+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
	probe.remove();
	return '#' + rgb.map((n) => n.toString(16).padStart(2, '0')).join('');
}

export class AppearanceTab extends SettingTab {
	private readonly options: AppearanceTabOptions;
	private listed = '';
	private subscribed = false;
	/** Shows the theme's accent while the user has not chosen one. */
	private accentPicker: ColorComponent | null = null;

	constructor(app: App, options: AppearanceTabOptions = {}) {
		super(app);
		this.options = options;
		this.id = 'appearance';
		this.name = 'Appearance';
		this.icon = 'palette';
	}

	override display(): void {
		if (!this.subscribed) {
			this.subscribed = true;
			// Re-render when themes or snippets appear or disappear, not on every style change (that would steal focus).
			this.app.workspace.on('css-change', () => {
				if (!this.containerEl.isConnected) return;
				if (this.listing() !== this.listed) this.display();
				else if (!this.app.vault.getConfig('accentColor')) this.accentPicker?.setValue(currentAccent());
			});
		}
		this.listed = this.listing();
		const { containerEl, app } = this;
		const { vault, customCss } = app;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Base color scheme')
			.setDesc('Choose the color scheme. Themes can style both.')
			.addDropdown((d) =>
				d
					.addOptions(SCHEMES)
					.setValue(app.appearance.setting())
					.onChange((value) => app.changeTheme(value as ThemeSetting)),
			);

		const accent = vault.getConfig('accentColor');
		const accentSetting = new Setting(containerEl)
			.setName('Accent color')
			.setDesc(accent ? 'Used for links, buttons and selections.' : "Used for links, buttons and selections. Showing the theme's accent.");
		if (accent) {
			accentSetting.addExtraButton((b) =>
				b
					.setIcon('rotate-ccw')
					.setTooltip('Use the theme’s accent')
					.onClick(() => {
						vault.setConfig('accentColor', null);
						this.display();
					}),
			);
		}
		accentSetting.addColorPicker((c) => {
			this.accentPicker = c;
			c.setValue(typeof accent === 'string' && accent ? accent : currentAccent()).onChange(debounce((value: string) => vault.setConfig('accentColor', value), 150, true));
		});

		const themes = this.heading('Themes', 'Reload themes', () => customCss.requestLoadTheme(), customCss.getThemeFolder());
		themes.setDesc(`Community themes in ${customCss.getThemeFolder()}.`);
		const names = [...Object.keys(customCss.themes), ...customCss.oldThemes].sort((a, b) => a.localeCompare(b));
		const themeSetting = new Setting(containerEl).setName('Theme');
		const missing = customCss.theme && !customCss.isThemeInstalled(customCss.theme);
		const chosen = customCss.themes[customCss.theme];
		if (missing) themeSetting.setDesc(`“${customCss.theme}” is not installed in this vault.`);
		else if (chosen) themeSetting.setDesc([chosen.version && `Version ${chosen.version}`, chosen.author && `by ${chosen.author}`].filter(Boolean).join(' '));
		else themeSetting.setDesc(names.length ? 'Choose an installed theme.' : 'No themes are installed. Copy a theme folder into the themes folder.');
		themeSetting.addDropdown((d) => {
			d.addOption('', 'Default');
			for (const name of names) d.addOption(name, name);
			if (missing) d.addOption(customCss.theme, `${customCss.theme} (missing)`);
			d.setValue(customCss.theme).onChange((name) => {
				customCss.setTheme(name);
				this.display();
			});
		});

		new Setting(containerEl).setName('Font').setHeading();
		this.fontSetting('Interface font', 'interfaceFontFamily', 'Used in menus, sidebars and dialogs.');
		this.fontSetting('Text font', 'textFontFamily', 'Used in the editor and reading view.');
		this.fontSetting('Monospace font', 'monospaceFontFamily', 'Used in code blocks and inline code.');
		new Setting(containerEl)
			.setName('Font size')
			.setDesc('The text size in the editor and reading view, in pixels.')
			.addSlider((s) =>
				s
					.setLimits(MIN_FONT_SIZE, MAX_FONT_SIZE, 1)
					.setValue(Number(vault.getConfig('baseFontSize')) || 16)
					.setDynamicTooltip()
					.onChange(debounce((size: number) => vault.setConfig('baseFontSize', size), 100, true)),
			);

		new Setting(containerEl).setName('Interface').setHeading();
		new Setting(containerEl)
			.setName('Show ribbon')
			.setDesc('The bar of actions on the left of the window.')
			.addToggle((t) => t.setValue(vault.getConfig('showRibbon') !== false).onChange((on) => vault.setConfig('showRibbon', on)));

		const snippets = this.heading('CSS snippets', 'Reload snippets', () => customCss.requestLoadSnippets(), customCss.getSnippetsFolder());
		snippets.setDesc(`CSS files in ${customCss.getSnippetsFolder()}, applied after the theme.`);
		if (customCss.snippets.length === 0) {
			containerEl.createDiv({ cls: 'setting-item-description appearance-empty', text: 'No snippets yet. Add .css files to the snippets folder, then reload.' });
		}
		for (const name of customCss.snippets) {
			new Setting(containerEl)
				.setName(name)
				.setClass('appearance-snippet')
				.addToggle((t) => t.setValue(customCss.enabledSnippets.has(name)).onChange((on) => customCss.setCssEnabledStatus(name, on)));
		}
	}

	private heading(name: string, reloadTip: string, reload: () => void, folder: string): Setting {
		const setting = new Setting(this.containerEl).setName(name).setHeading();
		const { showFolder } = this.options;
		if (showFolder) {
			setting.addExtraButton((b) =>
				b
					.setIcon('folder-open')
					.setTooltip('Open folder')
					.onClick(() => void showFolder(folder).catch((err: unknown) => console.error(err))),
			);
		}
		setting.addExtraButton((b) => b.setIcon('refresh-cw').setTooltip(reloadTip).onClick(reload));
		return setting;
	}

	private fontSetting(name: string, key: string, desc: string): void {
		const value = this.app.vault.getConfig(key);
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((t) =>
				t
					.setPlaceholder('Theme default')
					.setValue(typeof value === 'string' ? value : '')
					.onChange(debounce((font: string) => this.app.vault.setConfig(key, font.trim() || null), 400, true)),
			);
	}

	/** What the dynamic parts of the tab depend on. */
	private listing(): string {
		const { customCss } = this.app;
		return JSON.stringify([Object.keys(customCss.themes), customCss.oldThemes, customCss.snippets, customCss.theme]);
	}
}
