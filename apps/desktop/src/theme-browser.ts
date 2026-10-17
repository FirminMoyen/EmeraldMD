/**
 * Settings → Appearance → Themes → "Browse": the community theme directory
 * as a grid of screenshots, with install, use and uninstall, like Obsidian's.
 */

import { Modal, Notice, type App } from '@emeraldmd/api';
import type { CommunityDirectory, CommunityTheme } from '@emeraldmd/plugin-host';

export class ThemeBrowser extends Modal {
	private themes: CommunityTheme[] = [];
	private query = '';
	private mode: 'all' | 'dark' | 'light' = 'all';
	private gridEl!: HTMLElement;

	constructor(
		app: App,
		private readonly directory: CommunityDirectory,
	) {
		super(app);
	}

	override async onOpen(): Promise<void> {
		this.modalEl.addClass('mod-community-modal', 'mod-community-theme');
		this.titleEl.setText('Community themes');
		const controls = this.contentEl.createDiv('community-modal-controls');
		const search = controls.createEl('input', { type: 'search', cls: 'community-modal-search', attr: { placeholder: 'Search community themes…', spellcheck: 'false' } });
		search.addEventListener('input', () => {
			this.query = search.value;
			this.renderGrid();
		});
		const modes = controls.createEl('select', { cls: 'dropdown' });
		for (const [value, label] of [['all', 'Light and dark'], ['dark', 'Dark'], ['light', 'Light']] as const) modes.createEl('option', { value, text: label });
		modes.addEventListener('change', () => {
			this.mode = modes.value as typeof this.mode;
			this.renderGrid();
		});
		this.gridEl = this.contentEl.createDiv('community-theme-grid');
		this.gridEl.createDiv({ cls: 'community-modal-empty', text: 'Loading the community directory…' });
		search.focus();
		try {
			this.themes = await this.directory.listThemes();
			this.renderGrid();
		} catch (err) {
			this.gridEl.empty();
			this.gridEl.createDiv({ cls: 'community-modal-empty mod-warning', text: `Could not load the community directory: ${err instanceof Error ? err.message : String(err)}` });
		}
	}

	private renderGrid(): void {
		const css = this.app.customCss;
		const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
		const matches = this.themes.filter(
			(t) => words.every((w) => `${t.name} ${t.author}`.toLowerCase().includes(w)) && (this.mode === 'all' || t.modes.includes(this.mode)),
		);
		this.gridEl.empty();
		for (const theme of matches.slice(0, 120)) {
			const card = this.gridEl.createDiv({ cls: ['community-theme', ...(css.theme === theme.name ? ['is-selected'] : [])] });
			if (theme.screenshot) {
				card.createEl('img', {
					cls: 'community-theme-screenshot',
					attr: { src: `https://raw.githubusercontent.com/${theme.repo}/HEAD/${theme.screenshot}`, alt: '', loading: 'lazy' },
				});
			}
			card.createDiv({ cls: 'community-theme-name', text: theme.name });
			card.createDiv({ cls: 'community-theme-info', text: `By ${theme.author}${theme.modes.length ? ` · ${theme.modes.join(', ')}` : ''}` });
			const buttons = card.createDiv('community-theme-buttons');
			const installed = css.isThemeInstalled(theme.name);
			const act = (text: string, run: () => Promise<void>, cta = false) => {
				const b = buttons.createEl('button', { text, cls: cta ? 'mod-cta' : '' });
				b.addEventListener('click', async () => {
					b.disabled = true;
					try {
						await run();
					} catch (err) {
						new Notice(`${theme.name}: ${err instanceof Error ? err.message : String(err)}`);
					}
					this.renderGrid();
				});
			};
			if (!installed) {
				act('Install and use', async () => {
					await this.directory.installTheme(theme);
					await css.readThemes();
					css.setTheme(theme.name);
				}, true);
			} else {
				if (css.theme !== theme.name) act('Use', async () => css.setTheme(theme.name), true);
				act('Uninstall', async () => {
					if (css.theme === theme.name) css.setTheme('');
					await this.app.vault.adapter.rmdir(`${css.getThemeFolder()}/${theme.name}`, true);
					await css.readThemes();
					new Notice(`Uninstalled ${theme.name}. Its folder is in the vault's .trash.`);
				});
			}
		}
		if (!matches.length) this.gridEl.createDiv({ cls: 'community-modal-empty', text: 'No themes match.' });
	}
}
