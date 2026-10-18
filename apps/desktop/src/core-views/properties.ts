/**
 * Properties view, as Obsidian's core plugin: every property used in the
 * vault (All properties, with how many notes use it; a click searches for
 * it), and the active note's properties to edit (File properties).
 */

import { debounce, ItemView, MarkdownView, PropertiesEditor, setIcon, type WorkspaceLeaf } from '@emeraldmd/api';
import { TFile } from '@emeraldmd/core';
import type { CoreViewHost } from './host';

export const ALL_PROPERTIES_VIEW = 'all-properties';
export const FILE_PROPERTIES_VIEW = 'file-properties';

const TYPE_ICONS: Record<string, string> = {
	text: 'text',
	multitext: 'list',
	number: 'binary',
	checkbox: 'square-check',
	date: 'calendar',
	datetime: 'clock',
	tags: 'tags',
	aliases: 'forward',
};

export class AllPropertiesView extends ItemView {
	private readonly refresh = debounce(() => this.render(), 300, true);
	private sort: 'name' | 'count' = 'count';
	private filter = '';
	private listEl!: HTMLElement;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: CoreViewHost,
	) {
		super(leaf);
		this.icon = 'archive';
	}

	getViewType(): string {
		return ALL_PROPERTIES_VIEW;
	}

	getDisplayText(): string {
		return 'All properties';
	}

	protected override async onOpen(): Promise<void> {
		this.contentEl.addClass('all-properties-pane');
		const bar = this.contentEl.createDiv('all-properties-bar');
		const input = bar.createEl('input', { cls: 'all-properties-filter', attr: { type: 'text', placeholder: 'Filter properties…', spellcheck: 'false' } });
		input.addEventListener('input', () => {
			this.filter = input.value.trim().toLowerCase();
			this.render();
		});
		const sort = bar.createDiv({ cls: 'clickable-icon all-properties-sort', attr: { 'aria-label': 'Sort by name' } });
		setIcon(sort, 'arrow-up-narrow-wide');
		sort.addEventListener('click', () => {
			this.sort = this.sort === 'count' ? 'name' : 'count';
			sort.setAttribute('aria-label', this.sort === 'count' ? 'Sort by name' : 'Sort by count');
			this.render();
		});
		this.listEl = this.contentEl.createDiv('all-properties-list');
		this.registerEvent(this.app.metadataCache.on('resolved', () => this.refresh()));
		this.registerEvent(this.app.metadataCache.on('changed', () => this.refresh()));
		this.registerEvent(this.app.metadataTypeManager.on('changed', () => this.refresh()));
		this.render();
	}

	private render(): void {
		const list = this.listEl;
		list.empty();
		const properties = Object.values(this.app.metadataTypeManager.getAllProperties())
			.filter((info) => info.count > 0 && (!this.filter || info.name.toLowerCase().includes(this.filter)))
			.sort((a, b) => (this.sort === 'count' ? b.count - a.count : 0) || a.name.localeCompare(b.name));
		if (!properties.length) {
			list.createDiv({ cls: 'pane-empty', text: this.filter ? 'No property matches.' : 'No note has properties yet.' });
			return;
		}
		for (const info of properties) {
			const row = list.createDiv({ cls: 'tree-item-self is-clickable all-properties-item', attr: { 'data-property-key': info.name, title: `Search for notes with "${info.name}"` } });
			setIcon(row.createDiv('tree-item-icon'), TYPE_ICONS[info.type] ?? 'text');
			row.createDiv({ cls: 'tree-item-inner', text: info.name });
			row.createDiv({ cls: 'tree-item-flair', text: String(info.count) });
			row.addEventListener('click', () => void this.host.openSearch(`[${info.name}]`));
		}
	}
}

export class FilePropertiesView extends ItemView {
	private editor: PropertiesEditor | null = null;
	private file: TFile | null = null;
	private readonly refresh = debounce(() => void this.render(), 200, true);

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = 'info';
	}

	getViewType(): string {
		return FILE_PROPERTIES_VIEW;
	}

	getDisplayText(): string {
		return 'File properties';
	}

	protected override async onOpen(): Promise<void> {
		this.contentEl.addClass('file-properties-pane');
		this.registerEvent(this.app.workspace.on('file-open', () => void this.render()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refresh()));
		this.registerEvent(
			this.app.metadataCache.on('changed', (file: TFile) => {
				if (file === this.file) this.refresh();
			}),
		);
		await this.render();
	}

	/** The note view showing `file`, where edits go (so they save with the note). */
	private noteView(file: TFile): MarkdownView | null {
		let found: MarkdownView | null = null;
		this.app.workspace.iterateRootLeaves((leaf) => {
			if (!found && leaf.view instanceof MarkdownView && leaf.view.file === file) found = leaf.view;
		});
		return found;
	}

	private async render(): Promise<void> {
		const active = this.app.workspace.getActiveFile();
		const file = active?.extension === 'md' ? active : null;
		if (file !== this.file || !this.editor) {
			this.file = file;
			this.editor?.destroy();
			this.editor = null;
			this.contentEl.empty();
			if (!file) {
				this.contentEl.createDiv({ cls: 'pane-empty', text: 'No note is open.' });
				return;
			}
			this.editor = new PropertiesEditor(this.app, this.contentEl, {
				sourcePath: () => file.path,
				save: (data) => {
					const view = this.noteView(file);
					if (view) view.saveProperties(data);
					else
						void this.app.fileManager.processFrontMatter(file, (frontmatter) => {
							for (const key of Object.keys(frontmatter)) delete frontmatter[key];
							Object.assign(frontmatter, data);
						});
				},
			});
		}
		if (!file) return;
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		this.editor.setData(frontmatter as Record<string, unknown>);
	}

	protected override async onClose(): Promise<void> {
		this.editor?.destroy();
	}
}
