// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CachedMetadata, LinkSets, ReferenceCache } from '@emeraldmd/core';
import '../src';
import { createTestApp } from '../src/testing';

/** Metadata for the links in `text`, as the Rust index reports it (UTF-16 offsets). */
function indexLinks(text: string): CachedMetadata {
	const links: ReferenceCache[] = [];
	const embeds: ReferenceCache[] = [];
	const pos = (offset: number) => ({ line: 0, col: offset, offset });
	for (const m of text.matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
		const [target] = m[2]!.split('|');
		(m[1] ? embeds : links).push({ link: target!, original: m[0], position: { start: pos(m.index), end: pos(m.index + m[0].length) } });
	}
	for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
		links.push({ link: decodeURI(m[1]!), original: m[0], position: { start: pos(m.index), end: pos(m.index + m[0].length) } });
	}
	return { links, embeds };
}

const HOME = 'See [[Plan]], [[Projects/Plan#Goals|goals]], ![[Projects/Plan]] and [md](Projects/Plan.md). Not [[Other]].';

async function setup(config: Record<string, unknown>) {
	const files = { 'Projects/Plan.md': '# Plan', 'Home.md': HOME, 'Other.md': 'Links to [[Plan]] too.' };
	const test = await createTestApp(files, { '.obsidian/app.json': JSON.stringify(config) });
	const metadata = { 'Home.md': indexLinks(HOME), 'Other.md': indexLinks(files['Other.md']) };
	const links: Record<string, LinkSets> = {
		'Home.md': { resolved: { 'Projects/Plan.md': 4, 'Other.md': 1 }, unresolved: {} },
		'Other.md': { resolved: { 'Projects/Plan.md': 1 }, unresolved: {} },
	};
	test.app.vault.applyUpdate({ renamed: [], removed: [], upserted: [], metadata, links });
	return test;
}

afterEach(() => document.body.replaceChildren());

describe('FileManager.renameFile', () => {
	it('rewrites links, keeping headings, aliases and the link kind', async () => {
		const { app, backend } = await setup({ alwaysUpdateLinks: true });
		await app.fileManager.renameFile(app.vault.getFileByPath('Projects/Plan.md')!, 'Archive/Roadmap.md');
		expect(await backend.read('Home.md')).toBe('See [[Roadmap]], [[Roadmap#Goals|goals]], ![[Roadmap]] and [md](Roadmap.md). Not [[Other]].');
		expect(await backend.read('Other.md')).toBe('Links to [[Roadmap]] too.');
	});

	it('leaves links that still resolve when a folder moves', async () => {
		const { app, backend } = await setup({ alwaysUpdateLinks: true });
		await app.fileManager.renameFile(app.vault.getFolderByPath('Projects')!, 'Archive/Projects');
		expect(app.vault.getFileByPath('Archive/Projects/Plan.md')).not.toBeNull();
		expect(await backend.read('Home.md')).toBe('See [[Plan]], [[Plan#Goals|goals]], ![[Plan]] and [md](Plan.md). Not [[Other]].');
		expect(await backend.read('Other.md')).toBe('Links to [[Plan]] too.');
	});

	it('asks before updating links when the setting is off', async () => {
		const { app, backend } = await setup({});
		const answer = async (label: string) => {
			await vi.waitFor(() => expect(document.querySelector('.modal-title')?.textContent).toBe('Update links?'));
			expect(document.querySelector('.modal-content p')?.textContent).toBe('Update 5 links in 2 files to point to the new location?');
			[...document.querySelectorAll<HTMLButtonElement>('.modal button')].find((b) => b.textContent === label)!.click();
		};

		const declined = app.fileManager.renameFile(app.vault.getFileByPath('Projects/Plan.md')!, 'Projects/Roadmap.md');
		await answer("Don't update");
		await declined;
		expect(app.vault.getFileByPath('Projects/Roadmap.md')).not.toBeNull();
		expect(await backend.read('Home.md')).toBe(HOME);
	});
});
