// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import type { SearchResults } from '@emeraldmd/core';
import { startShell } from './shell-harness';

const RESULTS: SearchResults = {
	totalFiles: 2,
	files: [
		{ path: 'A.md', nameMatched: false, matchCount: 1, matches: [{ line: 0, from: 0, to: 5, lineText: 'flour and eggs', textFrom: 0, textTo: 5 }] },
		{ path: 'B.md', nameMatched: false, matchCount: 1, matches: [{ line: 0, from: 4, to: 9, lineText: 'buy flour', textFrom: 4, textTo: 9 }] },
	],
} as SearchResults;

it('sorts, folds and copies search results, and embeds them with query blocks', async () => {
	const searches: { query: string; options: { sort?: string } }[] = [];
	const shell = await startShell({ 'A.md': 'flour and eggs', 'B.md': 'buy flour', 'List.md': 'Shopping:\n\n```query\nflour\n```\n' }, {}, false, {
		search_vault: (args) => {
			searches.push(args as never);
			return RESULTS;
		},
	});
	const app = shell.app;
	app.commands.executeCommandById('global-search:open');
	const input = await vi.waitFor(() => {
		const el = document.querySelector<HTMLInputElement>('.search-view .search-input-container input');
		if (!el) throw new Error('no search pane');
		return el;
	});
	input.value = 'flour';
	input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
	await vi.waitFor(() => expect(document.querySelectorAll('.search-view .search-result')).toHaveLength(2));
	expect(searches.at(-1)!.options.sort).toBe('path-asc');

	// Sort order: from the menu.
	document.querySelector<HTMLElement>('.search-view [aria-label="Change sort order"]')!.click();
	[...document.querySelectorAll<HTMLElement>('.menu .menu-item')].find((el) => el.textContent === 'Modified time (new to old)')!.click();
	await vi.waitFor(() => expect(searches.at(-1)!.options.sort).toBe('modified-newest'));
	await vi.waitFor(() => expect(document.querySelectorAll('.search-view .search-result')).toHaveLength(2));

	// Collapse results: all at once.
	document.querySelector<HTMLElement>('.search-view [aria-label="Collapse results"]')!.click();
	expect([...document.querySelectorAll('.search-view .search-result')].every((el) => el.classList.contains('is-collapsed'))).toBe(true);

	// Copy: as links, or with the matching lines.
	const writeText = vi.fn(async () => {});
	Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
	document.querySelector<HTMLElement>('.search-view [aria-label="Copy search results"]')!.click();
	[...document.querySelectorAll<HTMLElement>('.menu .menu-item')].find((el) => el.textContent === 'Copy with matching lines')!.click();
	await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('- [[A]]\n\t- flour and eggs\n- [[B]]\n\t- buy flour'));

	// A ```query block in a note shows the results.
	await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath('List.md')!);
	app.commands.executeCommandById('markdown:toggle-preview');
	const block = await vi.waitFor(() => {
		const el = document.querySelector<HTMLElement>('.internal-query');
		if (!el?.querySelector('.search-result')) throw new Error('no query results yet');
		return el;
	});
	expect(block.querySelector('.internal-query-header-title')?.textContent).toBe('flour');
	expect(block.querySelector('.internal-query-header-count')?.textContent).toBe('2 results');
	expect([...block.querySelectorAll('.search-result .tree-item-inner')].map((el) => el.textContent)).toEqual(['A', 'B']);
});
