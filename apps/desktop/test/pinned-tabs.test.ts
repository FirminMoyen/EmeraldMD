// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { fromObsidianLayout, toObsidianLayout } from '../src/obsidian-layout';
import { startShell } from './shell-harness';

const headers = () => [...document.querySelectorAll<HTMLElement>('.mod-root .workspace-tab-header')];
const titles = () => headers().map((header) => header.querySelector('.workspace-tab-header-inner-title')?.textContent);
const treeItem = (path: string) => document.querySelector<HTMLElement>(`.nav-file-title[data-path="${path}"]`)!;

it('keeps a pinned tab’s note: links open next to it, and ⌘W and "Close others" leave it', async () => {
	const shell = await startShell({ 'A.md': 'alpha', 'B.md': 'bravo', 'C.md': 'charlie' }, {});
	const app = shell.app;
	const active = () => app.workspace.getActiveFile()?.path;
	treeItem('A.md').click();
	await vi.waitFor(() => expect(active()).toBe('A.md'));

	expect(app.commands.executeCommandById('workspace:toggle-pin')).toBe(true);
	const pinned = headers()[0]!;
	expect(pinned.classList.contains('is-pinned')).toBe(true);
	expect(pinned.querySelector('.workspace-tab-header-inner-close-button')).toBeNull();
	expect(pinned.querySelector('.mod-pinned')).not.toBeNull();
	expect(app.workspace.getLeaf(false).pinned).toBe(true);

	// Another note opens in a new tab; the pinned one keeps A.
	treeItem('B.md').click();
	await vi.waitFor(() => expect(active()).toBe('B.md'));
	expect(titles()).toEqual(['A', 'B']);
	treeItem('C.md').click();
	await vi.waitFor(() => expect(active()).toBe('C.md'));
	expect(titles()).toEqual(['A', 'C']);

	// "Close all other tabs" from C leaves A; ⌘W on A does nothing.
	expect(app.commands.executeCommandById('workspace:close-others')).toBe(false);
	headers()[0]!.click();
	await vi.waitFor(() => expect(active()).toBe('A.md'));
	expect(app.commands.executeCommandById('workspace:close')).toBe(false);
	expect(app.commands.executeCommandById('workspace:close-others')).toBe(true);
	expect(titles()).toEqual(['A']);

	// The pin unpins; so does a plugin calling leaf.setPinned(false).
	headers()[0]!.querySelector<HTMLElement>('.mod-pinned')!.click();
	expect(headers()[0]!.classList.contains('is-pinned')).toBe(false);
	app.workspace.getLeaf(false).setPinned(true);
	expect(headers()[0]!.classList.contains('is-pinned')).toBe(true);
	app.workspace.getLeaf(false).setPinned(false);
	expect(headers()[0]!.querySelector('.workspace-tab-header-inner-close-button')).not.toBeNull();
});

it('keeps the pin in Obsidian’s layout format', () => {
	const saved = { type: 'tabs' as const, tabs: [{ file: 'A.md', mode: 'source' as const, pinned: true }, { file: 'B.md', mode: 'source' as const }], active: 0, current: true };
	const layout = toObsidianLayout(saved, { left: true, right: true });
	const leaves: { pinned?: boolean }[] = [];
	const walk = (node: { type?: string; children?: unknown[]; pinned?: boolean }) => {
		if (node.type === 'leaf') leaves.push(node);
		for (const child of node.children ?? []) walk(child as typeof node);
	};
	walk(layout.main as never);
	expect(leaves.map((leaf) => leaf.pinned)).toEqual([true, undefined]);
	// Back in our format (inside a split, as the main area is one).
	const firstTabs = (node: { type: string; tabs?: { pinned?: boolean }[]; children?: unknown[] }): { pinned?: boolean }[] =>
		node.tabs ?? firstTabs(node.children![0] as typeof node);
	expect(firstTabs(fromObsidianLayout(layout)!.saved as never).map((tab) => tab.pinned)).toEqual([true, undefined]);
});
