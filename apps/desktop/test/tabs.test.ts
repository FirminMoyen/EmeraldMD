// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { TFile } from '@emeraldmd/core';
import { startShell, type Shell } from './shell-harness';

const headers = () => [...document.querySelectorAll<HTMLElement>('.mod-root .workspace-tab-header')];
const titles = () => headers().map((header) => header.querySelector('.workspace-tab-header-inner-title')?.textContent);
const activeTitle = () => document.querySelector('.mod-root .workspace-tab-header.is-active .workspace-tab-header-inner-title')?.textContent;
const treeItem = (path: string) => document.querySelector<HTMLElement>(`.nav-file-title[data-path="${path}"]`)!;

describe('tabs', () => {
	let shell: Shell;
	const active = () => shell.app.workspace.getActiveFile()?.path;
	const editor = () => shell.app.workspace.activeEditor!.editor!;
	const file = (path: string) => shell.app.vault.getFileByPath(path) as TFile;

	it('starts with one tab, in the DOM themes style', async () => {
		shell = await startShell({ 'A.md': 'alpha\n', 'B.md': 'bravo\n', 'C.md': 'charlie\n' }, {});
		await vi.waitFor(() => expect(active()).toBeDefined());
		const bar = document.querySelector('.workspace-split.mod-root > .workspace-tabs.mod-top > .workspace-tab-header-container')!;
		expect(bar.querySelector('.workspace-tab-header-new-tab')).not.toBeNull();
		expect(document.querySelector('.workspace-tabs > .workspace-tab-container > .workspace-leaf')).not.toBeNull();
		expect(titles()).toEqual([file(active()!).basename]);
	});

	it('opens notes in the current tab, and new tabs with ⌘T and ⌘-click', async () => {
		treeItem('A.md').click();
		await vi.waitFor(() => expect(active()).toBe('A.md'));
		expect(titles()).toEqual(['A']);

		shell.press('t', { mod: true });
		expect(titles()).toEqual(['A', 'New tab']);
		expect(activeTitle()).toBe('New tab');
		expect(document.getElementById('no-file')!.hidden).toBe(false);
		treeItem('B.md').click();
		await vi.waitFor(() => expect(active()).toBe('B.md'));
		expect(titles()).toEqual(['A', 'B']);

		treeItem('C.md').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, ctrlKey: true }));
		await vi.waitFor(() => expect(active()).toBe('C.md'));
		expect(titles()).toEqual(['A', 'B', 'C']);
		expect(activeTitle()).toBe('C');
	});

	it('keeps each tab’s cursor and edits, and saves when leaving a tab', async () => {
		headers()[0]!.click();
		await vi.waitFor(() => expect(active()).toBe('A.md'));
		editor().setCursor({ line: 0, ch: 5 });
		editor().replaceSelection(' edited');
		editor().setCursor({ line: 0, ch: 3 });

		headers()[1]!.click();
		await vi.waitFor(() => expect(active()).toBe('B.md'));
		await vi.waitFor(() => expect(shell.backend.read('A.md')).resolves.toBe('alpha edited\n'));
		expect(shell.editorText()).toBe('bravo\n');

		headers()[0]!.click();
		await vi.waitFor(() => expect(active()).toBe('A.md'));
		expect(shell.editorText()).toBe('alpha edited\n');
		expect(editor().getCursor()).toEqual({ line: 0, ch: 3 });
		// The undo history came back with the tab.
		editor().undo();
		expect(shell.editorText()).toBe('alpha\n');
		editor().redo();
	});

	it('has its own back/forward history in each tab', async () => {
		treeItem('B.md').click();
		await vi.waitFor(() => expect(active()).toBe('B.md'));
		shell.app.commands.executeCommandById('app:go-back');
		await vi.waitFor(() => expect(active()).toBe('A.md'));
		// The second tab only ever showed B.
		headers()[1]!.click();
		await vi.waitFor(() => expect(active()).toBe('B.md'));
		expect(document.querySelector('.view-header-nav-button[aria-label^="Navigate back"]')!.classList.contains('is-disabled')).toBe(true);
	});

	it('closes with ⌘W, going back to the last tab used, and reopens with ⇧⌘T where it was', async () => {
		headers()[2]!.click();
		await vi.waitFor(() => expect(active()).toBe('C.md'));
		shell.press('w', { mod: true });
		expect(titles()).toEqual(['A', 'B']);
		await vi.waitFor(() => expect(active()).toBe('B.md'));
		shell.press('t', { mod: true, shift: true });
		expect(titles()).toEqual(['A', 'B', 'C']);
		await vi.waitFor(() => expect(active()).toBe('C.md'));

		headers()[0]!.click();
		await vi.waitFor(() => expect(active()).toBe('A.md'));
		shell.press('w', { mod: true });
		expect(titles()).toEqual(['B', 'C']);
		await vi.waitFor(() => expect(active()).toBe('C.md'));
		shell.press('t', { mod: true, shift: true });
		expect(titles()).toEqual(['A', 'B', 'C']);
		await vi.waitFor(() => expect(active()).toBe('A.md'));
		headers()[2]!.click();
		await vi.waitFor(() => expect(active()).toBe('C.md'));
	});

	it('switches with the tab commands', async () => {
		shell.app.commands.executeCommandById('workspace:next-tab');
		await vi.waitFor(() => expect(active()).toBe('A.md'));
		shell.app.commands.executeCommandById('workspace:previous-tab');
		await vi.waitFor(() => expect(active()).toBe('C.md'));
		shell.press('2', { mod: true });
		await vi.waitFor(() => expect(active()).toBe('B.md'));
		shell.press('9', { mod: true });
		await vi.waitFor(() => expect(active()).toBe('C.md'));
	});

	it('opens a new tab for plugins asking for a new leaf', async () => {
		await shell.app.workspace.getLeaf('tab').openFile(file('A.md'));
		await vi.waitFor(() => expect(active()).toBe('A.md'));
		expect(titles()).toEqual(['A', 'B', 'C', 'A']);
		// Closing the root leaf closes the tab.
		shell.app.workspace.getLeaf(false).detach();
		expect(titles()).toEqual(['A', 'B', 'C']);
	});

	it('empties tabs whose note is deleted, follows renames, and remembers the tabs', async () => {
		await vi.waitFor(() => expect(active()).toBe('C.md'));
		await shell.app.vault.trash(file('B.md'));
		await vi.waitFor(() => expect(titles()).toEqual(['A', 'New tab', 'C']));
		await shell.app.fileManager.renameFile(file('A.md'), 'Alpha.md');
		await vi.waitFor(() => expect(titles()).toEqual(['Alpha', 'New tab', 'C']));
		expect(shell.app.loadLocalStorage('emerald-layout')).toEqual({
			type: 'split',
			direction: 'vertical',
			sizes: [1],
			children: [
				{
					type: 'tabs',
					tabs: [
						{ file: 'Alpha.md', mode: 'source' },
						{ file: null, mode: 'source' },
						{ file: 'C.md', mode: 'source' },
					],
					active: 2,
					current: true,
				},
			],
		});
	});

	it('closing the last tab leaves an empty one', async () => {
		for (let i = 0; i < 3; i++) shell.press('w', { mod: true });
		expect(titles()).toEqual(['New tab']);
		await vi.waitFor(() => expect(active()).toBeUndefined());
		expect(document.getElementById('no-file')!.hidden).toBe(false);
		// ⇧⌘T puts the last closed tab in place of the empty one.
		shell.press('t', { mod: true, shift: true });
		await vi.waitFor(() => expect(titles()).toEqual(['Alpha']));
	});
});
