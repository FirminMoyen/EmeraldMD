/**
 * The search pane: Obsidian's query syntax (docs/search.md), run by the Rust
 * core. Results are grouped by file with the matching lines; clicking a line
 * opens the note with the match selected. As in Obsidian, results can be
 * sorted (name, modified or created time), folded all at once, and copied
 * as links, paths or Markdown.
 */

import { ItemView, Menu, Notice, setIcon, setTooltip, type WorkspaceLeaf } from '@emeraldmd/api';
import type { SearchFileResult, SearchResults, SearchSort } from '@emeraldmd/core';
import { errorText, type CoreViewHost } from './host';

export const SEARCH_VIEW = 'search';
const MAX_FILES = 500;
const DEBOUNCE_MS = 250;

const SORTS: [SearchSort, string][] = [
	['path-asc', 'File name (A to Z)'],
	['path-desc', 'File name (Z to A)'],
	['modified-newest', 'Modified time (new to old)'],
	['modified-oldest', 'Modified time (old to new)'],
	['created-newest', 'Created time (new to old)'],
	['created-oldest', 'Created time (old to new)'],
];

export class SearchView extends ItemView {
	private inputEl!: HTMLInputElement;
	private summaryEl!: HTMLElement;
	private resultsEl!: HTMLElement;
	private matchCase = false;
	private sort: SearchSort = 'path-asc';
	private allCollapsed = false;
	private results: SearchResults | null = null;
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
		const options = root.createDiv('search-options-container nav-buttons-container');
		const option = (icon: string, label: string, onClick: (evt: MouseEvent) => void) => {
			const el = options.createDiv({ cls: 'clickable-icon nav-action-button', attr: { 'aria-label': label } });
			setIcon(el, icon);
			el.addEventListener('click', onClick);
			return el;
		};
		option('arrow-up-narrow-wide', 'Change sort order', (evt) => {
			const menu = new Menu();
			for (const [sort, name] of SORTS) {
				menu.addItem((item) =>
					item
						.setTitle(name)
						.setChecked(sort === this.sort)
						.onClick(() => {
							this.sort = sort;
							void this.run();
						}),
				);
			}
			menu.showAtMouseEvent(evt);
		});
		const collapse = option('list-collapse', 'Collapse results', () => {
			this.allCollapsed = !this.allCollapsed;
			this.collapsed.clear();
			collapse.toggleClass('is-active', this.allCollapsed);
			for (const item of this.resultsEl.querySelectorAll('.search-result')) item.toggleClass('is-collapsed', this.allCollapsed);
		});
		option('copy', 'Copy search results', (evt) => this.copyMenu(evt));
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
		return { query: this.inputEl?.value ?? '', matchingCase: this.matchCase, sortOrder: this.sort, collapseAll: this.allCollapsed };
	}

	override async setState(state: unknown): Promise<void> {
		const { query, sortOrder } = (state ?? {}) as { query?: unknown; sortOrder?: unknown };
		if (SORTS.some(([sort]) => sort === sortOrder)) this.sort = sortOrder as SearchSort;
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
			const results = await this.host.search(query, { caseSensitive: this.matchCase, sort: this.sort, limit: MAX_FILES });
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
		this.results = results;
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
		// "Collapse results" folds them all; each one can still be opened (or folded) on its own.
		const collapsed = this.collapsed.has(result.path) !== this.allCollapsed;
		item.toggleClass('is-collapsed', collapsed);
		const title = item.createDiv('tree-item-self search-result-file-title is-clickable');
		const toggle = title.createDiv('tree-item-icon collapse-icon');
		setIcon(toggle, 'chevron-down');
		toggle.addEventListener('click', (e) => {
			e.stopPropagation();
			if (this.collapsed.has(result.path)) this.collapsed.delete(result.path);
			else this.collapsed.add(result.path);
			item.toggleClass('is-collapsed', this.collapsed.has(result.path) !== this.allCollapsed);
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

	/** Copies the files found: as wikilinks, as paths, or as a Markdown list of links with the matching lines. */
	private copyMenu(evt: MouseEvent): void {
		const files = (this.results?.files ?? []).filter((r) => this.app.vault.getFileByPath(r.path));
		const copy = async (text: string) => {
			try {
				await navigator.clipboard.writeText(text);
				new Notice(`Copied ${files.length} result${files.length === 1 ? '' : 's'}.`);
			} catch (err) {
				new Notice(`Could not copy: ${err}`);
			}
		};
		const link = (path: string) => this.app.fileManager.generateMarkdownLink(this.app.vault.getFileByPath(path)!, '');
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('Copy as list of links')
				.setDisabled(!files.length)
				.onClick(() => void copy(files.map((r) => `- ${link(r.path)}`).join('\n'))),
		);
		menu.addItem((item) =>
			item
				.setTitle('Copy as list of paths')
				.setDisabled(!files.length)
				.onClick(() => void copy(files.map((r) => r.path).join('\n'))),
		);
		menu.addItem((item) =>
			item
				.setTitle('Copy with matching lines')
				.setDisabled(!files.length)
				.onClick(() => void copy(files.map((r) => [`- ${link(r.path)}`, ...r.matches.map((m) => `\t- ${m.lineText.trim()}`)].join('\n')).join('\n'))),
		);
		menu.showAtMouseEvent(evt);
	}
}
