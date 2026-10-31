/**
 * ```query code blocks: search results embedded in a note, as in Obsidian.
 * The block holds a search (Obsidian's syntax, docs/search.md); the note
 * shows the files found with their matching lines, in the reading view and
 * Live Preview, and runs it again when notes change.
 */

import { debounce, MarkdownPreviewRenderer, MarkdownRenderChild, setIcon, type App, type MarkdownPostProcessor } from '@emeraldmd/api';
import type { SearchResults } from '@emeraldmd/core';
import { errorText, type CoreViewHost } from './host';

/** Files shown per block. */
const LIMIT = 100;

/** Post-processors are global: one draws query blocks for the vault open now. */
let active: { app: App; host: CoreViewHost } | null = null;
let processor: MarkdownPostProcessor | null = null;

export function registerQueryBlocks(app: App, host: CoreViewHost): void {
	active = { app, host };
	if (processor) return;
	processor = MarkdownPreviewRenderer.createCodeBlockPostProcessor('query', (source, el, ctx) => {
		if (active) ctx.addChild(new QueryBlock(active.app, active.host, el, source.trim()));
	});
	MarkdownPreviewRenderer.registerPostProcessor(processor);
}

class QueryBlock extends MarkdownRenderChild {
	private resultsEl!: HTMLElement;
	private countEl!: HTMLElement;
	private generation = 0;

	constructor(
		private readonly app: App,
		private readonly host: CoreViewHost,
		containerEl: HTMLElement,
		private readonly query: string,
	) {
		super(containerEl);
	}

	override onload(): void {
		const el = this.containerEl;
		el.addClass('internal-query');
		const header = el.createDiv('internal-query-header');
		setIcon(header.createSpan('internal-query-header-icon'), 'search');
		header.createSpan({ cls: 'internal-query-header-title', text: this.query || 'Empty query' });
		this.countEl = header.createSpan('internal-query-header-count');
		this.resultsEl = el.createDiv('search-results-container');
		const again = debounce(() => void this.run(), 1000, true);
		this.registerEvent(this.app.metadataCache.on('resolved', () => again()));
		void this.run();
	}

	private async run(): Promise<void> {
		const generation = ++this.generation;
		if (!this.query) return;
		if (!this.host.search) {
			this.countEl.setText('Search is not available for this vault.');
			return;
		}
		let results: SearchResults;
		try {
			results = await this.host.search(this.query, { limit: LIMIT });
		} catch (err) {
			if (generation !== this.generation) return;
			this.resultsEl.empty();
			this.countEl.setText(errorText(err));
			this.containerEl.addClass('mod-error');
			return;
		}
		if (generation !== this.generation) return;
		this.containerEl.removeClass('mod-error');
		this.countEl.setText(`${results.totalFiles} result${results.totalFiles === 1 ? '' : 's'}`);
		this.resultsEl.empty();
		for (const result of results.files) {
			const file = this.app.vault.getFileByPath(result.path);
			if (!file) continue;
			const item = this.resultsEl.createDiv('tree-item search-result');
			const title = item.createDiv('tree-item-self search-result-file-title is-clickable');
			title.createDiv({ cls: 'tree-item-inner', text: file.extension === 'md' ? file.basename : file.name });
			if (result.matchCount) title.createDiv({ cls: 'tree-item-flair', text: String(result.matchCount) });
			title.setAttribute('title', result.path);
			title.addEventListener('click', () => void this.host.openFile(file));
			const matches = item.createDiv('search-result-file-matches');
			for (const match of result.matches.slice(0, 3)) {
				const row = matches.createDiv('search-result-file-match');
				const text = match.lineText;
				row.appendText(text.slice(0, match.textFrom));
				row.createSpan({ cls: 'search-result-file-matched-text', text: text.slice(match.textFrom, match.textTo) });
				row.appendText(text.slice(match.textTo));
				row.addEventListener('click', () => void this.host.openFile(file, { from: match.from, to: match.to }));
			}
		}
		if (results.totalFiles > results.files.length) this.resultsEl.createDiv({ cls: 'search-result-more', text: `and ${results.totalFiles - results.files.length} more files` });
	}
}
