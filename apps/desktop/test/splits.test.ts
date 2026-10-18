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

describe('dragging tabs', () => {
	it('reorders tabs, moves them between panes, and splits when dropped on an edge', async () => {
		const shell = (globalThis as { app?: import('@emeraldmd/api').App }).app!;
		const headersOf = (pane: HTMLElement) => [...pane.querySelectorAll<HTMLElement>('.workspace-tab-header')];
		const dataTransfer = () => new DataTransfer();
		const drag = (from: HTMLElement, to: HTMLElement, at: { x: number; y: number }) => {
			const transfer = dataTransfer();
			// happy-dom keeps neither the `dataTransfer` nor the pointer position passed to DragEvent.
			const event = (type: string) =>
				Object.defineProperties(new DragEvent(type, { bubbles: true, cancelable: true }), {
					dataTransfer: { value: transfer },
					clientX: { value: at.x },
					clientY: { value: at.y },
				});
			from.dispatchEvent(event('dragstart'));
			to.dispatchEvent(event('dragover'));
			to.dispatchEvent(event('drop'));
			from.dispatchEvent(event('dragend'));
		};
		// Two panes: [B, A] and [A]; add a tab C to the first pane.
		panes()[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		await shell.workspace.getLeaf('tab').openFile(shell.vault.getFileByPath('C.md') as TFile);
		await vi.waitFor(() => expect(titlesOf(panes()[0]!)).toEqual(['A', 'C']));

		// Within a bar (happy-dom has no layout: a drop lands after the last header).
		drag(headersOf(panes()[0]!)[0]!, panes()[0]!.querySelector('.workspace-tab-header-container')!, { x: 9999, y: 0 });
		expect(titlesOf(panes()[0]!)).toEqual(['C', 'A']);

		// The note area has no layout in happy-dom: give it a 100×100 box.
		const box = (pane: HTMLElement) => {
			const el = pane.querySelector<HTMLElement>('.workspace-tab-container')!;
			Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) });
			return el;
		};
		// Dropped in the middle of the other pane's note: the tab moves there and is current.
		drag(headersOf(panes()[0]!)[1]!, box(panes()[1]!), { x: 50, y: 50 });
		await vi.waitFor(() => expect(titlesOf(panes()[1]!)).toEqual(['A', 'A']));
		expect(titlesOf(panes()[0]!)).toEqual(['C']);
		expect(panes()[1]!.classList.contains('mod-active')).toBe(true);

		// Dropped near the right edge: a new pane on that side gets it.
		drag(headersOf(panes()[1]!)[1]!, box(panes()[1]!), { x: 95, y: 50 });
		await vi.waitFor(() => expect(panes()).toHaveLength(3));
		expect(panes().map(titlesOf)).toEqual([['C'], ['A'], ['A']]);
		expect(panes()[2]!.classList.contains('mod-active')).toBe(true);

		// The last tab of a pane moved away: the pane closes.
		drag(headersOf(panes()[0]!)[0]!, box(panes()[1]!), { x: 50, y: 50 });
		await vi.waitFor(() => expect(panes()).toHaveLength(2));
		expect(panes().map(titlesOf)).toEqual([['A', 'C'], ['A']]);
		await vi.waitFor(() => expect(shell.workspace.getActiveFile()?.path).toBe('C.md'));
	});
});
