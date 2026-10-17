/** Quick switcher (Mod+O): fuzzy-find a file by name or path, or create a note. */

import { prepareFuzzySearch, renderResults, SuggestModal, type App, type SearchResult } from '@emeraldmd/api';
import type { TFile } from '@emeraldmd/core';
import type { CoreViewHost } from './host';

type Item = { file: TFile; match: SearchResult } | { create: string };

const LIMIT = 50;

function label(file: TFile): string {
	return file.extension === 'md' ? file.path.slice(0, -3) : file.path;
}

export class QuickSwitcher extends SuggestModal<Item> {
	constructor(
		app: App,
		private readonly host: CoreViewHost,
	) {
		super(app);
		this.setPlaceholder('Find or create a note…');
		this.setInstructions([
			{ command: '↑↓', purpose: 'to navigate' },
			{ command: '↵', purpose: 'to open' },
			{ command: 'esc', purpose: 'to dismiss' },
		]);
	}

	getSuggestions(query: string): Item[] {
		const files = this.app.vault.getFiles().filter((f) => f.extension === 'md' || f.extension === 'canvas');
		const q = query.trim();
		if (!q) {
			// Recently opened first, then the rest by modification time.
			const recent = this.app.workspace.getLastOpenFiles();
			const rank = (f: TFile) => {
				const i = recent.indexOf(f.path);
				return i === -1 ? recent.length : i;
			};
			return files
				.sort((a, b) => rank(a) - rank(b) || b.stat.mtime - a.stat.mtime)
				.slice(0, LIMIT)
				.map((file) => ({ file, match: { score: 0, matches: [] } }));
		}
		const search = prepareFuzzySearch(q);
		const found: Item[] = [];
		for (const file of files) {
			const match = search(label(file));
			if (match) found.push({ file, match });
		}
		found.sort((a, b) => ('match' in b ? b.match.score : 0) - ('match' in a ? a.match.score : 0));
		const items = found.slice(0, LIMIT);
		const exists = files.some((f) => label(f).toLowerCase() === q.toLowerCase() || f.basename.toLowerCase() === q.toLowerCase());
		if (!exists) items.push({ create: q });
		return items;
	}

	renderSuggestion(item: Item, el: HTMLElement): void {
		if ('create' in item) {
			el.addClass('mod-create');
			el.createSpan({ cls: 'suggestion-prefix', text: 'Create ' });
			el.createSpan({ text: `"${item.create}"` });
			return;
		}
		const content = el.createDiv('suggestion-content');
		renderResults(content.createDiv('suggestion-title'), label(item.file), item.match);
		if (item.file.extension !== 'md') el.createDiv({ cls: 'suggestion-flair', text: item.file.extension });
	}

	onChooseSuggestion(item: Item): void {
		if ('file' in item) {
			void this.host.openFile(item.file);
			return;
		}
		const name = item.create.replace(/\.md$/i, '');
		void this.app.vault
			.create(`${name}.md`, '')
			.then((file) => this.host.openFile(file))
			.catch((err: unknown) => console.error(err));
	}
}
