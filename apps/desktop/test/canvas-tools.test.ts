// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import type { CanvasData } from '@emeraldmd/canvas';
import { PATH_TYPE } from '../src/file-explorer';
import { startShell } from './shell-harness';

const CANVAS: CanvasData = {
	nodes: [
		{ id: 'a', type: 'text', text: 'Idea', x: 0, y: 0, width: 200, height: 60 },
		{ id: 'b', type: 'text', text: 'Plan', x: 400, y: 0, width: 200, height: 60 },
	],
	edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
};

const control = (label: string) => document.querySelector<HTMLElement>(`.canvas-view [aria-label="${label}"]`)!;
const menuItems = () => [...document.querySelectorAll<HTMLElement>('.menu .menu-item')];
const menuItem = (title: string) => menuItems().find((el) => el.textContent === title)!;
const rightClick = (el: Element) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));

it('adds cards, colours, groups and removes them from menus, undoes, and takes files dropped from the explorer', async () => {
	const shell = await startShell({ 'Board.canvas': JSON.stringify(CANVAS), 'Note.md': '# Note', 'Pics/cat.png': 'png' }, {});
	const app = shell.app;
	await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath('Board.canvas')!);
	const view = app.workspace.getLeavesOfType('canvas')[0]!.view as unknown as { save(): Promise<void> };
	const saved = async (): Promise<CanvasData> => {
		await view.save();
		return JSON.parse(await app.vault.read(app.vault.getFileByPath('Board.canvas')!)) as CanvasData;
	};
	await vi.waitFor(() => expect(document.querySelectorAll('.canvas-view .canvas-node')).toHaveLength(2));
	expect(control('Undo').classList.contains('is-disabled')).toBe(true);

	// "Add card" adds a text card and edits it; undo takes it back out.
	control('Add card').click();
	expect(document.querySelectorAll('.canvas-view .canvas-node')).toHaveLength(3);
	expect(document.querySelector('.canvas-node-editor')).toBeTruthy();
	(document.querySelector('.canvas-node-editor') as HTMLElement).blur();
	expect(control('Undo').classList.contains('is-disabled')).toBe(false);
	control('Undo').click();
	expect(document.querySelectorAll('.canvas-view .canvas-node')).toHaveLength(2);
	expect(control('Redo').classList.contains('is-disabled')).toBe(false);

	// A card's menu: colour it.
	// Cards are drawn again after each edit: look them up each time.
	const card = () => document.querySelector('.canvas-view .canvas-node[data-id="a"]')!;
	rightClick(card());
	expect(menuItems().map((el) => el.textContent)).toEqual(expect.arrayContaining(['Edit', 'Color', 'Create group', 'Remove']));
	menuItem('Color').click();
	menuItem('Green').click();
	expect((await saved()).nodes.find((n) => n.id === 'a')?.color).toBe('4');

	// Grouping puts a group under the card.
	rightClick(card());
	menuItem('Create group').click();
	const grouped = await saved();
	expect(grouped.nodes[0]!.type).toBe('group');
	expect(grouped.nodes).toHaveLength(3);

	// An edge's menu: its label.
	rightClick(document.querySelector('.canvas-view .canvas-edge')!);
	menuItem('Edit label').click();
	const input = document.querySelector<HTMLInputElement>('.canvas-label-input')!;
	input.value = 'leads to';
	input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	expect((await saved()).edges[0]!.label).toBe('leads to');

	// The background's menu: a note from the vault, at the click.
	rightClick(document.querySelector('.canvas-view .canvas-wrapper')!);
	menuItem('Add note from vault').click();
	await vi.waitFor(() => expect(document.querySelectorAll('.prompt .suggestion-item').length).toBeGreaterThan(0));
	expect([...document.querySelectorAll('.prompt .suggestion-item')].map((el) => el.textContent)).toEqual(['Note.md']);
	document.querySelector<HTMLElement>('.prompt .suggestion-item')!.click();
	expect((await saved()).nodes.filter((n) => n.type === 'file').map((n) => n.type === 'file' && n.file)).toEqual(['Note.md']);

	// Removing the selected card (from its menu) also removes its edges.
	rightClick(document.querySelector('.canvas-view .canvas-node[data-id="b"]')!);
	menuItem('Remove').click();
	const removed = await saved();
	expect(removed.nodes.some((n) => n.id === 'b')).toBe(false);
	expect(removed.edges).toEqual([]);

	// Files dragged from the file explorer become file cards.
	const dataTransfer = new DataTransfer();
	dataTransfer.setData(PATH_TYPE, 'Pics/cat.png\nMissing.md');
	const drop = Object.defineProperty(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }), 'dataTransfer', { value: dataTransfer });
	document.querySelector('.canvas-view .canvas-wrapper')!.dispatchEvent(drop);
	expect(drop.defaultPrevented).toBe(true);
	const dropped = await saved();
	expect(dropped.nodes.filter((n) => n.type === 'file').map((n) => n.type === 'file' && n.file)).toEqual(['Note.md', 'Pics/cat.png']);
	await vi.waitFor(() => expect(document.querySelector('.canvas-view .canvas-file-media.mod-image img')).toBeTruthy());

	// ⌘Z in the canvas undoes the drop.
	(document.querySelector('.canvas-view .canvas-wrapper') as HTMLElement).focus();
	shell.press('z', { mod: true });
	expect((await saved()).nodes.filter((n) => n.type === 'file')).toHaveLength(1);
});
