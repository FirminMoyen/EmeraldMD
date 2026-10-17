/**
 * The Backlinks pane (right sidebar): linked mentions, with the line each
 * link is on, and unlinked mentions (the note's name or aliases written
 * without a link), which a click turns into links. Uses the class names of
 * search results, which themes style.
 */

import type { App } from '@emeraldmd/api';
import { getLinkpath, TFile, type SearchOptions, type SearchResults } from '@emeraldmd/core';

export interface BacklinksHost {
	activeFile(): TFile | null;
	/** Opens a note with a range selected. */
	openFileAt(file: TFile, select?: { from: number; to: number }): Promise<void>;
	/** Full-text search, when the vault's backend has it. */
	search?: (query: string, options?: SearchOptions) => Promise<SearchResults>;
	notice(message: string): void;
}

/** Notes whose lines are shown; beyond this, linked notes are listed by name only. */
const MAX_CONTEXT_SOURCES = 50;
const WORD = /[\p{L}\p{N}_]/u;

interface Mention {
	file: TFile;
	from: number;
	to: number;
	lineText: string;
	textFrom: number;
	textTo: number;
}

export class BacklinksPane {
	private showUnlinked = false;
	private generation = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly app: App,
		private readonly el: HTMLElement,
		private readonly host: BacklinksHost,
	) {}

	/** Renders soon, once a burst of index updates is over. */
	requestRender(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.render();
		}, 150);
	}

	async render(): Promise<void> {
		const generation = ++this.generation;
		const file = this.host.activeFile();
		const linked = createDiv('backlink-pane-linked');
		const unlinked = createDiv('backlink-pane-unlinked');
		this.el.replaceChildren(linked, unlinked);
		if (!file) return;
		await this.renderLinked(file, linked, generation);
		if (generation === this.generation) this.renderUnlinkedHeader(file, unlinked, generation);
	}

	private async renderLinked(file: TFile, el: HTMLElement, generation: number): Promise<void> {
		const { metadataCache, vault } = this.app;
		const sources = metadataCache
			.getBacklinks(file)
			.map((path) => vault.getFileByPath(path))
			.filter((f): f is TFile => f !== null);
		this.header(el, 'Linked mentions', sources.length);
		if (!sources.length) {
			el.createDiv({ cls: 'search-empty-state', text: 'No backlinks found.' });
			return;
		}
		for (const [i, source] of sources.entries()) {
			const result = el.createDiv('search-result');
			const title = result.createDiv({ cls: 'tree-item-self search-result-file-title is-clickable', text: source.basename, attr: { title: source.path } });
			title.addEventListener('click', () => void this.host.openFileAt(source));
			if (i >= MAX_CONTEXT_SOURCES) continue;
			const text = await vault.cachedRead(source).catch(() => '');
			if (generation !== this.generation) return;
			const matches = result.createDiv('search-result-file-matches');
			const refs = [...(metadataCache.getFileCache(source)?.links ?? []), ...(metadataCache.getFileCache(source)?.embeds ?? [])]
				.filter((ref) => metadataCache.getFirstLinkpathDest(getLinkpath(ref.link), source.path) === file)
				.sort((a, b) => a.position.start.offset - b.position.start.offset);
			for (const ref of refs) {
				const { offset: from } = ref.position.start;
				const to = ref.position.end.offset;
				const lineStart = text.lastIndexOf('\n', from - 1) + 1;
				const lineEnd = text.indexOf('\n', to);
				const lineText = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
				this.match(matches, lineText, from - lineStart, to - lineStart, () => void this.host.openFileAt(source, { from, to }));
			}
		}
	}

	private renderUnlinkedHeader(file: TFile, el: HTMLElement, generation: number): void {
		const header = this.header(el, 'Unlinked mentions', null);
		header.addClass('is-clickable');
		header.toggleClass('is-collapsed', !this.showUnlinked);
		const body = el.createDiv('backlink-pane-unlinked-results');
		header.addEventListener('click', () => {
			this.showUnlinked = !this.showUnlinked;
			void this.render();
		});
		if (!this.showUnlinked) return;
		if (!this.host.search) {
			body.createDiv({ cls: 'search-empty-state', text: 'Search is not available for this vault.' });
			return;
		}
		body.createDiv({ cls: 'search-empty-state', text: 'Searching…' });
		void this.findUnlinked(file).then((mentions) => {
			if (generation !== this.generation) return;
			body.empty();
			header.querySelector('.backlink-count')?.setText(String(mentions.length));
			if (!mentions.length) {
				body.createDiv({ cls: 'search-empty-state', text: 'No unlinked mentions found.' });
				return;
			}
			const byFile = new Map<TFile, Mention[]>();
			for (const m of mentions) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
			for (const [source, list] of byFile) {
				const result = body.createDiv('search-result');
				result.createDiv({ cls: 'tree-item-self search-result-file-title is-clickable', text: source.basename }).addEventListener('click', () => void this.host.openFileAt(source));
				const matches = result.createDiv('search-result-file-matches');
				for (const m of list) {
					const row = this.match(matches, m.lineText, m.textFrom, m.textTo, () => void this.host.openFileAt(source, { from: m.from, to: m.to }));
					const button = row.createEl('button', { cls: 'search-result-hover-button mod-cta', text: 'Link' });
					button.addEventListener('click', (event) => {
						event.stopPropagation();
						void this.link(file, m);
					});
				}
			}
		});
	}

	/** Where the note's name or aliases appear as whole words, outside links, in other notes. */
	private async findUnlinked(file: TFile): Promise<Mention[]> {
		const search = this.host.search!;
		const { metadataCache, vault } = this.app;
		const aliases = metadataCache.getFileCache(file)?.frontmatter?.aliases;
		const names = [file.basename, ...(Array.isArray(aliases) ? aliases : typeof aliases === 'string' ? [aliases] : [])]
			.map((n) => String(n).trim())
			.filter((n) => n.length > 1);
		const seen = new Set<string>();
		const mentions: Mention[] = [];
		for (const name of new Set(names)) {
			const results = await search(`"${name.replace(/"/g, '')}"`, { limit: 200 }).catch((err: unknown) => {
				this.host.notice(`Could not search for unlinked mentions: ${err}`);
				return { files: [], totalFiles: 0 } as SearchResults;
			});
			for (const result of results.files) {
				const source = vault.getFileByPath(result.path);
				if (!source || source === file || source.extension !== 'md') continue;
				const cache = metadataCache.getFileCache(source);
				const linkRanges = [...(cache?.links ?? []), ...(cache?.embeds ?? []), ...(cache?.tags ?? []), ...(cache?.headings ?? [])].map((r) => r.position);
				for (const m of result.matches) {
					const before = m.lineText[m.textFrom - 1] ?? '';
					const after = m.lineText[m.textTo] ?? '';
					if (WORD.test(before) || WORD.test(after)) continue;
					if (linkRanges.some((p) => m.from < p.end.offset && m.to > p.start.offset)) continue;
					if (cache?.frontmatterPosition && m.from < cache.frontmatterPosition.end.offset) continue;
					const key = `${source.path}:${m.from}`;
					if (seen.has(key)) continue;
					seen.add(key);
					mentions.push({ file: source, ...m });
				}
			}
		}
		return mentions;
	}

	/** Turns a mention into a link to `target`, keeping its wording as the alias when it differs. */
	private async link(target: TFile, mention: Mention): Promise<void> {
		const original = mention.lineText.slice(mention.textFrom, mention.textTo);
		const alias = original === target.basename ? undefined : original;
		const markdown = this.app.fileManager.generateMarkdownLink(target, mention.file.path, undefined, alias);
		let changed = false;
		await this.app.vault.process(mention.file, (text) => {
			if (text.slice(mention.from, mention.to) !== original) return text;
			changed = true;
			return text.slice(0, mention.from) + markdown + text.slice(mention.to);
		});
		if (!changed) this.host.notice(`${mention.file.basename} changed; search again to link this mention.`);
		this.requestRender();
	}

	private header(el: HTMLElement, title: string, count: number | null): HTMLElement {
		const header = el.createDiv('tree-item-self backlink-pane-header');
		header.createSpan({ cls: 'backlink-pane-title', text: title });
		header.createSpan({ cls: 'backlink-count', text: count === null ? '' : String(count) });
		return header;
	}

	private match(el: HTMLElement, lineText: string, from: number, to: number, onClick: () => void): HTMLElement {
		const row = el.createDiv('search-result-file-match is-clickable');
		const text = row.createDiv('search-result-file-match-text');
		text.appendText(lineText.slice(0, from));
		text.createSpan({ cls: 'search-result-file-matched-text', text: lineText.slice(from, to) });
		text.appendText(lineText.slice(to));
		row.addEventListener('click', onClick);
		return row;
	}
}
