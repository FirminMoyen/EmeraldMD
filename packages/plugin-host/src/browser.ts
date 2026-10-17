/**
 * "Browse" in Settings → Community plugins: search the community directory,
 * read a plugin's README, install, turn on, update or uninstall it. Laid out
 * like Obsidian's (`.community-modal` with a result list and a details pane).
 */

import { Component, MarkdownRenderer, Modal, Notice, type App } from '@emeraldmd/api';
import type { CommunityDirectory, CommunityPlugin, PluginStats } from './community';
import type { PluginHost } from './host';

/** At most this many results are listed; searching narrows them. */
const MAX_RESULTS = 200;

function formatCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

/** README links and images are relative to the repo; point them at GitHub. */
function absolutize(el: HTMLElement, repo: string): void {
	const raw = `https://raw.githubusercontent.com/${repo}/HEAD/`;
	const page = `https://github.com/${repo}/blob/HEAD/`;
	for (const img of el.querySelectorAll('img')) {
		const src = img.getAttribute('src') ?? '';
		if (src && !/^[a-z]+:/i.test(src)) img.setAttribute('src', raw + src.replace(/^\.?\//, ''));
	}
	for (const a of el.querySelectorAll('a')) {
		const href = a.getAttribute('href') ?? '';
		if (!href || href.startsWith('#')) continue;
		a.className = 'external-link';
		a.removeAttribute('data-href');
		if (!/^[a-z]+:/i.test(href)) a.setAttribute('href', page + href.replace(/^\.?\//, ''));
	}
}

export class PluginBrowser extends Modal {
	private query = '';
	private plugins: CommunityPlugin[] = [];
	private stats: Record<string, PluginStats> = {};
	private selected: CommunityPlugin | null = null;
	private listEl!: HTMLElement;
	private detailsEl!: HTMLElement;
	private readme: Component | null = null;
	private unsubscribe: (() => void) | null = null;

	constructor(
		app: App,
		private readonly host: PluginHost,
		private readonly directory: CommunityDirectory,
	) {
		super(app);
	}

	override async onOpen(): Promise<void> {
		this.modalEl.addClass('mod-community-modal');
		this.titleEl.setText('Community plugins');
		const controls = this.contentEl.createDiv('community-modal-controls');
		const search = controls.createEl('input', { type: 'search', cls: 'community-modal-search', attr: { placeholder: 'Search community plugins…', spellcheck: 'false' } });
		search.addEventListener('input', () => {
			this.query = search.value;
			this.renderList();
		});
		const body = this.contentEl.createDiv('community-modal-body');
		this.listEl = body.createDiv('community-modal-search-results');
		this.detailsEl = body.createDiv('community-modal-details');
		this.detailsEl.createDiv({ cls: 'community-modal-empty', text: 'Choose a plugin to see what it does.' });
		this.listEl.createDiv({ cls: 'community-modal-empty', text: 'Loading the community directory…' });
		this.unsubscribe = this.host.onChange(() => {
			if (this.selected) void this.showDetails(this.selected);
			this.renderList();
		});
		search.focus();
		try {
			[this.plugins, this.stats] = await Promise.all([this.directory.listPlugins(), this.directory.pluginStats().catch(() => ({}))]);
			this.renderList();
		} catch (err) {
			this.listEl.empty();
			this.listEl.createDiv({ cls: 'community-modal-empty mod-warning', text: `Could not load the community directory: ${err instanceof Error ? err.message : String(err)}` });
		}
	}

	override onClose(): void {
		this.unsubscribe?.();
		this.readme?.unload();
		this.contentEl.empty();
	}

	private renderList(): void {
		if (!this.listEl) return;
		this.listEl.empty();
		const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
		const matches = this.plugins
			.filter((p) => words.every((w) => `${p.name} ${p.author} ${p.description} ${p.id}`.toLowerCase().includes(w)))
			.sort((a, b) => (this.stats[b.id]?.downloads ?? 0) - (this.stats[a.id]?.downloads ?? 0));
		this.listEl.createDiv({ cls: 'community-modal-count', text: `${matches.length} plugin${matches.length === 1 ? '' : 's'}` });
		for (const plugin of matches.slice(0, MAX_RESULTS)) {
			const item = this.listEl.createDiv({ cls: ['community-item', ...(plugin === this.selected ? ['is-selected'] : [])] });
			item.createDiv({ cls: 'community-item-name', text: plugin.name });
			if (this.host.manifests[plugin.id]) item.createSpan({ cls: 'community-item-installed', text: 'Installed' });
			const meta = item.createDiv('community-item-meta');
			meta.createSpan({ cls: 'community-item-author', text: `By ${plugin.author}` });
			const downloads = this.stats[plugin.id]?.downloads;
			if (downloads) meta.createSpan({ cls: 'community-item-downloads', text: `${formatCount(downloads)} downloads` });
			item.createDiv({ cls: 'community-item-desc', text: plugin.description });
			item.addEventListener('click', () => {
				this.selected = plugin;
				this.renderList();
				void this.showDetails(plugin);
			});
		}
		if (matches.length > MAX_RESULTS) this.listEl.createDiv({ cls: 'community-modal-empty', text: 'Search to see more.' });
	}

	private async showDetails(plugin: CommunityPlugin): Promise<void> {
		const el = this.detailsEl;
		el.empty();
		this.readme?.unload();
		this.readme = null;
		el.createDiv({ cls: 'community-modal-info-name', text: plugin.name });
		const info = el.createDiv('community-modal-info');
		info.createSpan({ text: `By ${plugin.author}` });
		const downloads = this.stats[plugin.id]?.downloads;
		if (downloads) info.createSpan({ text: ` · ${formatCount(downloads)} downloads` });
		const repo = el.createDiv('community-modal-info-repo');
		repo.createEl('a', { cls: 'external-link', text: `github.com/${plugin.repo}`, attr: { href: `https://github.com/${plugin.repo}` } });
		el.createDiv({ cls: 'community-modal-info-desc', text: plugin.description });
		const buttons = el.createDiv('community-modal-button-container');
		const notes = el.createDiv('community-modal-notes');
		const readmeEl = el.createDiv('community-modal-readme markdown-rendered');
		readmeEl.createDiv({ cls: 'community-modal-empty', text: 'Loading…' });

		const latest = await this.directory.latestManifest(plugin.repo).catch(() => null);
		if (this.selected !== plugin) return;
		const installed = this.host.manifests[plugin.id];
		const version = typeof latest?.version === 'string' ? latest.version : null;
		if (version) info.createSpan({ text: ` · Version ${version}` });
		const problem = latest ? this.directory.incompatibility(latest) : null;
		if (problem) notes.createDiv({ cls: 'mod-warning', text: problem });
		if (latest?.isDesktopOnly === true) {
			notes.createDiv({ cls: 'mod-warning', text: 'Desktop only: it may need Node.js or Electron features that EmeraldMD does not provide yet.' });
		}

		const button = (text: string, onClick: () => Promise<unknown>, cta = false) => {
			const b = buttons.createEl('button', { text, cls: cta ? 'mod-cta' : '' });
			b.addEventListener('click', async () => {
				b.disabled = true;
				try {
					await onClick();
				} catch (err) {
					new Notice(`${plugin.name}: ${err instanceof Error ? err.message : String(err)}`);
				} finally {
					b.disabled = false;
				}
			});
			return b;
		};
		if (!installed) {
			const install = button('Install', async () => {
				install.setText('Installing…');
				await this.directory.installPlugin(plugin);
				await this.host.loadManifests();
				new Notice(`Installed ${plugin.name}. Turn it on to use it.`);
			}, true);
			if (problem || !version) install.disabled = true;
		} else {
			if (version && installed.version !== version && !problem) {
				button(`Update to ${version}`, async () => {
					await this.directory.installPlugin(plugin);
					await this.host.reloadPlugin(plugin.id);
					new Notice(`Updated ${plugin.name} to ${version}.`);
				}, true);
			}
			const enabled = this.host.isEnabled(plugin.id) && !this.host.restricted;
			const toggle = button(enabled ? 'Turn off' : 'Turn on', async () => {
				if (enabled) await this.host.disablePluginAndSave(plugin.id);
				else await this.host.enablePluginAndSave(plugin.id);
			}, !enabled);
			if (this.host.restricted) {
				toggle.disabled = true;
				notes.createDiv({ cls: 'setting-item-description', text: 'Restricted mode is on: turn community plugins on in Settings → Community plugins first.' });
			}
			button('Uninstall', async () => {
				await this.host.uninstallPlugin(plugin.id);
				new Notice(`Uninstalled ${plugin.name}. Its folder is in the vault's .trash.`);
			});
			notes.createDiv({ cls: 'setting-item-description', text: `Installed: version ${installed.version}.` });
		}

		const readme = await this.directory.readme(plugin.repo).catch(() => '');
		if (this.selected !== plugin) return;
		readmeEl.empty();
		if (!readme) {
			readmeEl.createDiv({ cls: 'community-modal-empty', text: 'This plugin has no README.' });
			return;
		}
		const component = new Component();
		component.load();
		this.readme = component;
		await MarkdownRenderer.render(this.app, readme, readmeEl, '', component);
		absolutize(readmeEl, plugin.repo);
	}
}
