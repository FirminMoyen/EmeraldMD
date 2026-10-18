/** Bookmarks (left sidebar): the Bookmarks core plugin's items; click to open, right-click to remove. */

import { Bookmarks, ItemView, Menu, setIcon, type BookmarkItem, type WorkspaceLeaf } from '@emeraldmd/api';
import { TFile } from '@emeraldmd/core';
import type { CoreViewHost } from './host';

export const BOOKMARKS_VIEW = 'bookmarks';

const ICONS: Record<BookmarkItem['type'], string> = {
	file: 'file',
	folder: 'folder-closed',
	search: 'search',
	heading: 'heading',
	block: 'square',
	graph: 'git-fork',
	url: 'globe',
	group: 'folder-open',
};

export class BookmarksView extends ItemView {
	private readonly collapsed = new Set<BookmarkItem>();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: CoreViewHost,
	) {
		super(leaf);
		this.icon = 'bookmark';
	}

	getViewType(): string {
		return BOOKMARKS_VIEW;
	}

	getDisplayText(): string {
		return 'Bookmarks';
	}

	private get plugin(): Bookmarks | null {
		const instance = this.app.internalPlugins.getEnabledPluginById('bookmarks');
		return instance instanceof Bookmarks ? instance : null;
	}

	protected override async onOpen(): Promise<void> {
		this.contentEl.addClass('bookmarks-view');
		const unsubscribe = this.plugin?.onChange(() => this.render());
		if (unsubscribe) this.register(unsubscribe);
		this.registerEvent(this.app.vault.on('delete', () => this.render()));
		this.render();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		const items = this.plugin?.items ?? [];
		if (!items.length) {
			root.createDiv({ cls: 'pane-empty', text: 'No bookmarks yet. Bookmark a note from its menu in the file list, or with "Bookmark current file".' });
			return;
		}
		this.renderItems(root, items, 0);
	}

	private renderItems(parent: HTMLElement, items: BookmarkItem[], depth: number): void {
		for (const item of items) {
			const row = parent.createDiv({ cls: ['tree-item-self', 'bookmark', 'is-clickable', ...(this.isMissing(item) ? ['is-unresolved'] : [])] });
			row.style.paddingInlineStart = `${8 + depth * 16}px`;
			setIcon(row.createDiv('tree-item-icon'), item.type === 'group' && this.collapsed.has(item) ? 'folder-closed' : ICONS[item.type] ?? 'bookmark');
			row.createDiv({ cls: 'tree-item-inner', text: this.label(item) });
			row.addEventListener('click', () => void this.openItem(item));
			row.addEventListener('contextmenu', (event) => {
				event.preventDefault();
				new Menu()
					.addItem((menuItem) =>
						menuItem
							.setTitle(item.type === 'group' ? 'Delete group' : 'Remove bookmark')
							.setIcon('trash-2')
							.setWarning(true)
							.onClick(() => this.plugin?.remove(item)),
					)
					.showAtMouseEvent(event);
			});
			if (item.type === 'group' && !this.collapsed.has(item)) this.renderItems(parent, item.items ?? [], depth + 1);
		}
	}

	private label(item: BookmarkItem): string {
		if (item.title) return item.title;
		switch (item.type) {
			case 'file':
			case 'folder': {
				const name = item.path?.split('/').pop() ?? '';
				return name.endsWith('.md') ? name.slice(0, -3) : name;
			}
			case 'heading':
			case 'block':
				return `${item.path?.split('/').pop()?.replace(/\.md$/, '') ?? ''} ${item.subpath ?? ''}`.trim();
			case 'search':
				return item.query ?? '';
			case 'url':
				return item.url ?? '';
			default:
				return item.type;
		}
	}

	private isMissing(item: BookmarkItem): boolean {
		return (item.type === 'file' || item.type === 'folder' || item.type === 'heading' || item.type === 'block') && !this.app.vault.getAbstractFileByPath(item.path ?? '');
	}

	private async openItem(item: BookmarkItem): Promise<void> {
		if (item.type === 'group') {
			if (this.collapsed.has(item)) this.collapsed.delete(item);
			else this.collapsed.add(item);
			this.render();
			return;
		}
		if (item.type === 'search' && item.query !== undefined) return this.host.openSearch(item.query);
		if (item.type === 'url' && item.url) {
			// Opened like any external link (the shell sends those to the browser).
			const link = document.body.createEl('a', { cls: 'external-link', attr: { href: item.url } });
			link.click();
			link.remove();
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(item.path ?? '');
		if (!(file instanceof TFile)) return;
		if ((item.type === 'heading' || item.type === 'block') && item.subpath) {
			const cache = this.app.metadataCache.getFileCache(file);
			const name = item.subpath.replace(/^#\^?/, '').toLowerCase();
			const target =
				item.type === 'block' ? cache?.blocks?.[name]?.position : cache?.headings?.find((h) => h.heading.toLowerCase() === name)?.position;
			return this.host.openFile(file, target ? { from: target.start.offset, to: target.start.offset } : undefined);
		}
		return this.host.openFile(file);
	}
}
