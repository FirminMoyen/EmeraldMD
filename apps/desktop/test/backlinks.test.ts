// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import '@emeraldmd/api';
import { createTestApp } from '@emeraldmd/api/testing';
import type { CachedMetadata, ReferenceCache, SearchResults } from '@emeraldmd/core';
import { BacklinksPane } from '../src/backlinks';

const pos = (offset: number, length: number) => ({ start: { line: 0, col: offset, offset }, end: { line: 0, col: offset + length, offset: offset + length } });

/** Links in `text` as the index reports them. */
function index(text: string): CachedMetadata {
	const links: ReferenceCache[] = [...text.matchAll(/\[\[([^\]|]+)[^\]]*\]\]/g)].map((m) => ({ link: m[1]!, original: m[0], position: pos(m.index, m[0].length) }));
	return { links };
}

/** A stand-in for the core's search: every case-insensitive occurrence of the quoted phrase. */
function searchIn(files: Record<string, string>) {
	return async (query: string): Promise<SearchResults> => {
		const needle = query.replace(/"/g, '').toLowerCase();
		const result: SearchResults = { files: [], totalFiles: 0 };
		for (const [path, text] of Object.entries(files)) {
			const matches = [];
			for (let at = text.toLowerCase().indexOf(needle); at !== -1; at = text.toLowerCase().indexOf(needle, at + 1)) {
				const lineStart = text.lastIndexOf('\n', at - 1) + 1;
				const lineEnd = text.indexOf('\n', at);
				matches.push({ line: 0, from: at, to: at + needle.length, lineText: text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd), textFrom: at - lineStart, textTo: at - lineStart + needle.length });
			}
			if (matches.length) result.files.push({ path, nameMatched: false, matches, matchCount: matches.length });
		}
		return result;
	};
}

describe('Backlinks pane', () => {
	it('shows linked mentions with their line, and turns unlinked mentions into links', async () => {
		const files = {
			'Plan.md': '# Plan\n',
			'Home.md': 'Intro\nSee [[Plan]] today.\n',
			'Ideas.md': 'The plan is good. A planner is not. [[Plan|our plan]] counts as linked.\n',
		};
		const { app, backend } = await createTestApp(files);
		app.vault.applyUpdate({
			renamed: [],
			removed: [],
			upserted: [],
			metadata: { 'Home.md': index(files['Home.md']), 'Ideas.md': index(files['Ideas.md']) },
			links: { 'Home.md': { resolved: { 'Plan.md': 1 }, unresolved: {} }, 'Ideas.md': { resolved: { 'Plan.md': 1 }, unresolved: {} } },
		});
		const el = document.body.createDiv();
		const plan = app.vault.getFileByPath('Plan.md')!;
		const opened: string[] = [];
		const pane = new BacklinksPane(app, el, {
			activeFile: () => plan,
			openFileAt: async (file, select) => void opened.push(`${file.path}${select ? `@${select.from}` : ''}`),
			search: searchIn(files),
			notice: () => {},
		});
		await pane.render();
		const linked = el.querySelector('.backlink-pane-linked')!;
		expect(linked.querySelector('.backlink-count')?.textContent).toBe('2');
		expect([...linked.querySelectorAll('.search-result-file-match')].map((m) => m.textContent)).toEqual(['See [[Plan]] today.', 'The plan is good. A planner is not. [[Plan|our plan]] counts as linked.']);
		(linked.querySelector('.search-result-file-match') as HTMLElement).click();
		expect(opened).toEqual([`Home.md@${files['Home.md'].indexOf('[[')}`]);

		(el.querySelector('.backlink-pane-unlinked .backlink-pane-header') as HTMLElement).click();
		await vi.waitFor(() => expect(el.querySelectorAll('.backlink-pane-unlinked .search-result-file-match')).toHaveLength(1));
		// "planner" is not a whole word, and the alias inside [[Plan|our plan]] is already a link.
		const mention = el.querySelector('.backlink-pane-unlinked .search-result-file-match')!;
		expect(mention.querySelector('.search-result-file-matched-text')?.textContent).toBe('plan');
		(mention.querySelector('button') as HTMLElement).click();
		await vi.waitFor(async () => expect(await backend.read('Ideas.md')).toBe('The [[Plan|plan]] is good. A planner is not. [[Plan|our plan]] counts as linked.\n'));
	});
});
