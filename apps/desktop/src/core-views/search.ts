/**
 * The search pane: Obsidian's query syntax (docs/search.md), run by the Rust
 * core. Results are grouped by file with the matching lines; clicking a line
 * opens the note with the match selected.
 */

import { ItemView, setIcon, setTooltip, type WorkspaceLeaf } from '@emeraldmd/api';
import type { SearchFileResult, SearchResults } from '@emeraldmd/core';
import { errorText, type CoreViewHost } from './host';

export const SEARCH_VIEW = 'search';
const MAX_FILES = 500;
const DEBOUNCE_MS = 250;

export class SearchView extends ItemView {
	private inputEl!: HTMLInputElement;
	private summaryEl!: HTMLElement;
	private resultsEl!: HTMLElement;
	private matchCase = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private generation = 0;
	private readonly collapsed = new Set<string>();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: CoreViewHost,
	) {
		super(leaf);
		this.icon = 'search';
	}

	getViewType(): string {
		return SEARCH_VIEW;
	}

	getDisplayText(): string {
		return 'Search';
	}

	protected override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('search-view');
		const row = root.createDiv('search-input-container');
		this.inputEl = row.createEl('input', {
			type: 'search',
			placeholder: 'Search…',
			attr: { spellcheck: 'false', 'aria-label': 'Search query' },
		});
		const caseButton = row.createDiv({ cls: 'clickable-icon search-option', attr: { 'aria-label': 'Match case' } });
		setIcon(caseButton, 'case-sensitive');
		setTooltip(caseButton, 'Match case');
		caseButton.addEventListener('click', () => {
			this.matchCase = !this.matchCase;
			caseButton.toggleClass('is-active', this.matchCase);
			void this.run();
		});
		this.summaryEl = root.createDiv('search-result-summary');
		this.resultsEl = root.createDiv('search-results-container');

		this.inputEl.addEventListener('input', () => this.schedule(DEBOUNCE_MS));
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') void this.run();
		});
		// Keep results current while notes change.
		this.registerEvent(this.app.metadataCache.on('resolved', () => this.inputEl.value.trim() && this.schedule(1000)));
		this.registerEvent(this.app.vault.on('delete', () => this.inputEl.value.trim() && this.schedule(500)));
		this.registerEvent(this.app.vault.on('rename', () => this.inputEl.value.trim() && this.schedule(500)));
	}

	protected override async onClose(): Promise<void> {
		clearTimeout(this.timer);
	}

	override getState(): Record<string, unknown> {
		return { query: this.inputEl?.value ?? '', matchingCase: this.matchCase };
	}

	override async setState(state: unknown): Promise<void> {
		const query = (state as { query?: unknown } | null)?.query;
		if (typeof query === 'string') this.setQuery(query);
	}

	/** Puts the cursor in the search box. */
	focus(): void {
		this.inputEl?.focus();
		this.inputEl?.select();
	}

	setQuery(query: string): void {
		if (!this.inputEl) return;
		this.inputEl.value = query;
		void this.run();
	}

	private schedule(delay: number): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.run(), delay);
	}

	private async run(): Promise<void> {
		clearTimeout(this.timer);
		const query = this.inputEl.value.trim();
		const generation = ++this.generation;
		if (!query) {
			this.summaryEl.empty();
			this.resultsEl.empty();
			return;
		}
		if (!this.host.search) {
			this.summaryEl.setText('Search is not available for this vault.');
			return;
		}
		this.summaryEl.removeClass('mod-error');
		try {
			const results = await this.host.search(query, { caseSensitive: this.matchCase, limit: MAX_FILES });
			if (generation !== this.generation) return;
			this.render(results);
		} catch (err) {
			if (generation !== this.generation) return;
			this.resultsEl.empty();
			this.summaryEl.addClass('mod-error');
			this.summaryEl.setText(errorText(err));
		}
	}

	private render(results: SearchResults): void {
		const { files, totalFiles } = results;
		const matches = files.reduce((sum, f) => sum + f.matchCount, 0);
		this.summaryEl.setText(
			totalFiles === 0
				? 'No matches.'
				: `${totalFiles} file${totalFiles === 1 ? '' : 's'}, ${matches} match${matches === 1 ? '' : 'es'}` +
						(totalFiles > files.length ? ` (showing the first ${files.length} files)` : ''),
		);
		this.resultsEl.empty();
		for (const result of files) this.renderFile(result);
	}

	private renderFile(result: SearchFileResult): void {
		const file = this.app.vault.getFileByPath(result.path);
		if (!file) return;
		const item = this.resultsEl.createDiv('tree-item search-result');
		const collapsed = this.collapsed.has(result.path);
		item.toggleClass('is-collapsed', collapsed);
		const title = item.createDiv('tree-item-self search-result-file-title is-clickable');
		const toggle = title.createDiv('tree-item-icon collapse-icon');
		setIcon(toggle, 'chevron-down');
		toggle.addEventListener('click', (e) => {
			e.stopPropagation();
			if (this.collapsed.has(result.path)) this.collapsed.delete(result.path);
			else this.collapsed.add(result.path);
			item.toggleClass('is-collapsed', this.collapsed.has(result.path));
		});
		title.createDiv({ cls: 'tree-item-inner', text: file.extension === 'md' ? file.basename : file.name });
		if (result.matchCount) title.createDiv({ cls: 'tree-item-flair', text: String(result.matchCount) });
		title.setAttribute('title', result.path);
		title.addEventListener('click', () => void this.host.openFile(file));

		const matchesEl = item.createDiv('search-result-file-matches');
		if (!result.matches.length && result.nameMatched) {
			matchesEl.createDiv({ cls: 'search-result-file-match mod-name', text: 'Matched in the file name' });
		}
		for (const match of result.matches) {
			const row = matchesEl.createDiv('search-result-file-match');
			const text = match.lineText;
			row.appendText(text.slice(0, match.textFrom));
			row.createSpan({ cls: 'search-result-file-matched-text', text: text.slice(match.textFrom, match.textTo) });
			row.appendText(text.slice(match.textTo));
			row.addEventListener('click', () => void this.host.openFile(file, { from: match.from, to: match.to }));
		}
		if (result.matchCount > result.matches.length) {
			matchesEl.createDiv({ cls: 'search-result-more', text: `and ${result.matchCount - result.matches.length} more` });
		}
	}
}
