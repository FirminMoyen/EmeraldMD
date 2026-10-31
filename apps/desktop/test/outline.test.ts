// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import type { HeadingCache } from '@emeraldmd/core';
import { moveSection } from '../src/core-views/outline';
import { startShell } from './shell-harness';

const NOTE = ['# One', 'a', '## One.1', 'b', '# Two', 'c', '## Two.1', 'd', '# Three', 'e', ''].join('\n');

/** The headings of `text`, as the index reports them. */
function headingsOf(text: string): HeadingCache[] {
	const out: HeadingCache[] = [];
	let offset = 0;
	for (const [line, lineText] of text.split('\n').entries()) {
		const m = /^(#{1,6})\s+(.+)$/.exec(lineText);
		if (m) out.push({ heading: m[2]!, level: m[1]!.length, position: { start: { line, col: 0, offset }, end: { line, col: lineText.length, offset: offset + lineText.length } } });
		offset += lineText.length + 1;
	}
	return out;
}

it('moves a section with its subsections before another heading', () => {
	const h = headingsOf(NOTE);
	expect(moveSection(NOTE, h, 2, 0)).toBe(['# Two', 'c', '## Two.1', 'd', '# One', 'a', '## One.1', 'b', '# Three', 'e', ''].join('\n'));
	expect(moveSection(NOTE, h, 0, 4)).toBe(['# Two', 'c', '## Two.1', 'd', '# One', 'a', '## One.1', 'b', '# Three', 'e', ''].join('\n'));
	// The last section has no newline at the end of the text: one is added.
	expect(moveSection('# A\nx\n# B\ny', headingsOf('# A\nx\n# B\ny'), 1, 0)).toBe('# B\ny\n# A\nx\n');
	// Into itself, or where it already is: nothing to do.
	expect(moveSection(NOTE, h, 0, 1)).toBeNull();
	expect(moveSection(NOTE, h, 0, 2)).toBeNull();
});

it('shows a tree that folds and filters, marks the current heading, and moves sections by drag and drop', async () => {
	const shell = await startShell({ 'Note.md': NOTE }, {});
	const app = shell.app;
	const file = app.vault.getFileByPath('Note.md')!;
	app.vault.applyUpdate({ renamed: [], removed: [], upserted: [], metadata: { 'Note.md': { headings: headingsOf(NOTE) } }, links: {} });
	await app.workspace.getLeaf(false).openFile(file);
	app.commands.executeCommandById('outline:open');
	const items = () => [...document.querySelectorAll<HTMLElement>('.outline-view .outline-item')].map((el) => el.textContent);
	await vi.waitFor(() => expect(items()).toEqual(['One', 'One.1', 'Two', 'Two.1', 'Three']));

	// Folding hides the subsections.
	document.querySelector<HTMLElement>('.outline-item[data-index="0"] .collapse-icon')!.click();
	expect(document.querySelector('.outline-item[data-index="0"]')!.parentElement!.classList.contains('is-collapsed')).toBe(true);
	document.querySelector<HTMLElement>('[aria-label="Expand all"]')!.click();

	// The filter keeps matches and their parents.
	document.querySelector<HTMLElement>('[aria-label="Show search filter"]')!.click();
	shell.typeInto(document.querySelector<HTMLInputElement>('.outline-view .search-input-container input')!, 'two.1');
	expect(items()).toEqual(['Two', 'Two.1']);
	document.querySelector<HTMLElement>('[aria-label="Show search filter"]')!.click();
	expect(items()).toHaveLength(5);

	// The heading the cursor is under.
	const editor = app.workspace.activeEditor!.editor!;
	editor.setCursor(editor.offsetToPos(NOTE.indexOf('d')));
	await vi.waitFor(() => expect(document.querySelector('.outline-item.is-active')?.textContent).toBe('Two.1'));

	// Dragging "Two" onto "One" moves the section, in the editor.
	const drag = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
	const two = document.querySelector('.outline-item[data-index="2"]')!;
	const one = document.querySelector('.outline-item[data-index="0"]')!;
	drag(two, 'dragstart');
	drag(one, 'dragover');
	drag(one, 'drop');
	expect(shell.editorText()).toBe(['# Two', 'c', '## Two.1', 'd', '# One', 'a', '## One.1', 'b', '# Three', 'e', ''].join('\n'));
	// One step to undo.
	editor.undo();
	expect(shell.editorText()).toBe(NOTE);
});
