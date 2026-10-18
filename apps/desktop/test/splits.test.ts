// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { TFile } from '@emeraldmd/core';
import { startShell, type Shell } from './shell-harness';

const panes = () => [...document.querySelectorAll<HTMLElement>('.workspace-split.mod-root .workspace-tabs')];
const titlesOf = (pane: HTMLElement) => [...pane.querySelectorAll('.workspace-tab-header-inner-title')].map((el) => el.textContent);
const editorTextOf = (pane: HTMLElement) => pane.querySelector('.cm-content')?.textContent ?? '';
const treeItem = (path: string) => document.querySelector<HTMLElement>(`.nav-file-title[data-path="${path}"]`)!;

describe('splits', () => {
	let shell: Shell;
	const active = () => shell.app.workspace.getActiveFile()?.path;
	const file = (path: string) => shell.app.vault.getFileByPath(path) as TFile;

	it('splits right with the same note, in a new current pane', async () => {
		shell = await startShell({ 'A.md': 'alpha', 'B.md': 'bravo', 'C.md': 'charlie' }, {});
		treeItem('A.md').click();
		await vi.waitFor(() => expect(active()).toBe('A.md'));
		shell.app.commands.executeCommandById('workspace:split-vertical');
		await vi.waitFor(() => expect(panes()).toHaveLength(2));
		expect(document.querySelector('.workspace-split.mod-root.mod-vertical > .workspace-leaf-resize-handle')).not.toBeNull();
		expect(panes()[1]!.classList.contains('mod-active')).toBe(true);
		expect(panes().map(titlesOf)).toEqual([['A'], ['A']]);
		await vi.waitFor(() => expect(editorTextOf(panes()[1]!)).toBe('alpha'));
	});

	it('opens files in the current pane, and a click makes a pane current', async () => {
		treeItem('B.md').click();
		await vi.waitFor(() => expect(active()).toBe('B.md'));
		expect(panes().map(titlesOf)).toEqual([['A'], ['B']]);
		panes()[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		expect(panes()[0]!.classList.contains('mod-active')).toBe(true);
		expect(active()).toBe('A.md');
		expect(shell.app.workspace.getLeavesOfType('markdown')).toHaveLength(2);
	});

	it('shows edits saved in one pane in another pane on the same note', async () => {
		panes()[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		treeItem('A.md').click();
		await vi.waitFor(() => expect(editorTextOf(panes()[1]!)).toBe('alpha'));
		panes()[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		const editor = shell.app.workspace.activeEditor!.editor!;
		editor.setCursor({ line: 0, ch: 5 });
		editor.replaceSelection(' edited');
		shell.app.commands.executeCommandById('editor:save-file');
		await vi.waitFor(() => expect(editorTextOf(panes()[1]!)).toBe('alpha edited'));
	});

	it('nests a split down, saves the layout, and closing a pane’s last tab removes it', async () => {
		panes()[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		shell.app.commands.executeCommandById('workspace:split-horizontal');
		await vi.waitFor(() => expect(panes()).toHaveLength(3));
		expect(document.querySelector('.workspace-split.mod-root.mod-vertical > .workspace-split.mod-horizontal')).not.toBeNull();
		const saved = shell.app.loadLocalStorage('emerald-layout') as { type: string; children: { type: string; direction?: string }[] };
		expect(saved.type).toBe('split');
		expect(saved.children.map((c) => c.type)).toEqual(['tabs', 'split']);
		expect(saved.children[1]!.direction).toBe('horizontal');

		shell.press('w', { mod: true });
		await vi.waitFor(() => expect(panes()).toHaveLength(2));
		expect(document.querySelector('.workspace-split.mod-horizontal')).toBeNull();
		expect(panes()[1]!.classList.contains('mod-active')).toBe(true);
	});

	it('gives plugins a new pane for getLeaf("split")', async () => {
		const leaf = shell.app.workspace.getLeaf('split');
		await leaf.openFile(file('C.md'));
		await vi.waitFor(() => expect(panes()).toHaveLength(3));
		expect(active()).toBe('C.md');
		let roots = 0;
		shell.app.workspace.iterateRootLeaves(() => roots++);
		expect(roots).toBe(3);
		// Detaching a pane's only tab closes the pane.
		leaf.detach();
		await vi.waitFor(() => expect(panes()).toHaveLength(2));
	});
});
