// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { footnotesOf } from '../src/core-views/footnotes';
import { startShell } from './shell-harness';

const NOTE = [
	'Text with a note[^a] and an inline one^[Inline **text**].',
	'Again[^a], then [^missing].',
	'',
	'```',
	'Code [^code] is not a footnote.',
	'```',
	'',
	'[^a]: The first note,',
	'    on two lines.',
	'[^unused]: Never referenced.',
	'',
].join('\n');

it('finds footnotes in the order they are referenced', () => {
	const notes = footnotesOf(NOTE);
	expect(notes.map((n) => [n.inline ? 'inline' : n.id, n.text, n.refs.length])).toEqual([
		['a', 'The first note,\non two lines.', 2],
		['inline', 'Inline **text**', 1],
		['missing', null, 1],
		['unused', 'Never referenced.', 0],
	]);
	expect(NOTE.slice(notes[0]!.at!, notes[0]!.at! + 5)).toBe('[^a]:');
	expect(NOTE.slice(notes[0]!.refs[1]!.from, notes[0]!.refs[1]!.to)).toBe('[^a]');
});

it("lists the active note's footnotes and jumps to them", async () => {
	const shell = await startShell({ 'Note.md': NOTE }, {});
	await shell.app.workspace.getLeaf(false).openFile(shell.app.vault.getFileByPath('Note.md')!);
	shell.app.commands.executeCommandById('footnotes:open');
	const items = await vi.waitFor(() => {
		const found = [...document.querySelectorAll<HTMLElement>('.footnotes-view .footnotes-item')];
		if (found.length !== 4) throw new Error('no footnotes yet');
		return found;
	});
	expect(items.map((i) => i.querySelector('.footnotes-number')?.textContent)).toEqual(['1', '2', '3', '–']);
	await vi.waitFor(() => {
		if (!items[1]!.querySelector('strong')) throw new Error('not rendered yet');
	});
	expect(items[2]!.classList.contains('is-undefined')).toBe(true);
	expect(items[3]!.classList.contains('is-unreferenced')).toBe(true);
	expect(items[0]!.querySelectorAll('.footnotes-ref')).toHaveLength(2);
	items[0]!.click();
	await vi.waitFor(() => {
		const editor = shell.app.workspace.activeEditor!.editor!;
		const head = editor.posToOffset(editor.getCursor());
		if (head !== NOTE.indexOf('[^a]:')) throw new Error(`cursor at ${head}`);
	});
});
