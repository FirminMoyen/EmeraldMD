/**
 * Outgoing links of the active note (right sidebar): the notes it links to,
 * those not created yet, and unlinked mentions (other notes whose name or
 * alias appears in its text without a link). Click to open; unlinked
 * mentions are looked for only while their section is open.
 */

import { debounce, getLinkpath, ItemView, parseFrontMatterAliases, setIcon, type WorkspaceLeaf } from '@emeraldmd/api';
import type { TFile } from '@emeraldmd/core';
import type { CoreViewHost } from './host';

export const OUTGOING_VIEW = 'outgoing-link';

/** The note's text without its links, where unlinked mentions are looked for. */
function withoutLinks(text: string): string {
	return text.replace(/!?\[\[[^\]]*\]\]/g, ' ').replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ');
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class OutgoingLinksView extends ItemView {
	private readonly refresh = debounce(() => void this.render(), 300, true);
	private mentionsOpen = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: CoreViewHost,
	) {
		super(leaf);
		this.icon = 'links-going-out';
	}

	getViewType(): string {
		return OUTGOING_VIEW;
	}

	getDisplayText(): string {
		return 'Outgoing links';
	}

	protected override async onOpen(): Promise<void> {
		this.contentEl.addClass('outgoing-link-pane');
		this.registerEvent(this.app.workspace.on('file-open', () => void this.render()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refresh()));
		this.registerEvent(
			this.app.metadataCache.on('changed', (file: TFile) => {
				if (file === this.app.workspace.getActiveFile()) this.refresh();
			}),
		);
		this.registerEvent(this.app.metadataCache.on('resolved', () => this.refresh()));
		await this.render();
	}

	private async render(): Promise<void> {
		const root = this.contentEl;
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') {
			root.empty();
			root.createDiv({ cls: 'pane-empty', text: 'No note is open.' });
			return;
		}
		const cache = this.app.metadataCache.getFileCache(file);
		const resolved = new Map<TFile, number>();
		const unresolved = new Map<string, number>();
		for (const ref of [...(cache?.links ?? []), ...(cache?.embeds ?? [])]) {
			const linkpath = getLinkpath(ref.link);
			if (!linkpath) continue;
			const target = this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
			if (target) resolved.set(target, (resolved.get(target) ?? 0) + 1);
			else unresolved.set(linkpath, (unresolved.get(linkpath) ?? 0) + 1);
		}
		const mentions = this.mentionsOpen ? await this.unlinkedMentions(file, resolved) : [];
		if (this.app.workspace.getActiveFile() !== file) return;

		root.empty();
		const links = this.section(root, 'Links', resolved.size + unresolved.size);
		if (!resolved.size && !unresolved.size) links.createDiv({ cls: 'search-empty-state', text: 'No links in this note.' });
		for (const [target, count] of [...resolved].sort((a, b) => a[0].basename.localeCompare(b[0].basename))) {
			this.row(links, target.extension === 'md' ? target.basename : target.name, count, target.path, () => void this.host.openFile(target));
		}
		for (const [linkpath, count] of [...unresolved].sort((a, b) => a[0].localeCompare(b[0]))) {
			// Like a click on an unresolved link: the note is created.
			this.row(links, linkpath, count, `${linkpath} (not created yet)`, () => void this.app.workspace.openLinkText(linkpath, file.path), true);
		}

		const header = root.createDiv({ cls: 'tree-item-self is-clickable outgoing-link-header', attr: { 'aria-expanded': String(this.mentionsOpen) } });
		setIcon(header.createDiv('tree-item-icon collapse-icon'), this.mentionsOpen ? 'chevron-down' : 'chevron-right');
		header.createDiv({ cls: 'tree-item-inner', text: 'Unlinked mentions' });
		if (this.mentionsOpen) header.createDiv({ cls: 'tree-item-flair', text: String(mentions.length) });
		header.addEventListener('click', () => {
			this.mentionsOpen = !this.mentionsOpen;
			void this.render();
		});
		if (!this.mentionsOpen) return;
		const list = root.createDiv('outgoing-link-section');
		if (!mentions.length) list.createDiv({ cls: 'search-empty-state', text: 'No unlinked mentions.' });
		for (const mention of mentions) this.row(list, mention.basename, 0, mention.path, () => void this.host.openFile(mention));
	}

	private section(root: HTMLElement, title: string, count: number): HTMLElement {
		const header = root.createDiv('tree-item-self outgoing-link-header');
		header.createDiv({ cls: 'tree-item-inner', text: title });
		header.createDiv({ cls: 'tree-item-flair', text: String(count) });
		return root.createDiv('outgoing-link-section');
	}

	private row(parent: HTMLElement, name: string, count: number, title: string, open: () => void, unresolvedTarget = false): void {
		const row = parent.createDiv({ cls: ['tree-item-self', 'is-clickable', 'outgoing-link-item', ...(unresolvedTarget ? ['is-unresolved'] : [])], attr: { title } });
		row.createDiv({ cls: 'tree-item-inner', text: name });
		if (count > 1) row.createDiv({ cls: 'tree-item-flair', text: String(count) });
		row.addEventListener('click', open);
	}

	/** Other notes whose name or an alias appears in the note's text (whole words, outside links), not already linked. */
	private async unlinkedMentions(file: TFile, linked: Map<TFile, number>): Promise<TFile[]> {
		const text = withoutLinks(await this.app.vault.cachedRead(file));
		const lower = text.toLowerCase();
		const found: TFile[] = [];
		for (const other of this.app.vault.getMarkdownFiles()) {
			if (other === file || linked.has(other)) continue;
			const aliases = parseFrontMatterAliases(this.app.metadataCache.getFileCache(other)?.frontmatter ?? null) ?? [];
			const names = [other.basename, ...aliases].filter((name) => name.trim().length > 1);
			const mentioned = names.some((name) => {
				if (!lower.includes(name.toLowerCase())) return false;
				return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(text);
			});
			if (mentioned) found.push(other);
		}
		return found.sort((a, b) => a.basename.localeCompare(b.basename));
	}
}
