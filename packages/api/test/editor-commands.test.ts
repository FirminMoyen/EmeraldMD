// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import '../src';
import { CodeMirrorEditor, setHeading, toggleBullet, toggleChecklist, toggleNumbered, toggleQuote, toggleWrap } from '../src';

function editorWith(doc: string, anchor: number, head = anchor) {
	const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor, head } }), parent: document.body });
	return { editor: new CodeMirrorEditor(view), view };
}

describe('editing commands', () => {
	it('wraps the selection or the word at the cursor, and unwraps', () => {
		const { editor, view } = editorWith('make this bold', 5, 9);
		toggleWrap(editor, '**');
		expect(editor.getValue()).toBe('make **this** bold');
		expect(editor.getSelection()).toBe('this');
		toggleWrap(editor, '**');
		expect(editor.getValue()).toBe('make this bold');
		expect(editor.getSelection()).toBe('this');
		// No selection: the word at the cursor.
		view.dispatch({ selection: { anchor: 11 } });
		toggleWrap(editor, '==');
		expect(editor.getValue()).toBe('make this ==bold==');
		// A selection that includes the markers unwraps too, even at the end of the line.
		view.dispatch({ selection: { anchor: 10, head: 18 } });
		toggleWrap(editor, '==');
		expect(editor.getValue()).toBe('make this bold');
		expect(editor.getSelection()).toBe('bold');
	});

	it('toggles list items, checkboxes, quotes and headings by line', () => {
		expect(toggleChecklist('task')).toBe('- [ ] task');
		expect(toggleChecklist('  - task')).toBe('  - [ ] task');
		expect(toggleChecklist('- [ ] task')).toBe('- [x] task');
		expect(toggleChecklist('1. [x] task')).toBe('1. [ ] task');
		expect(toggleBullet('item')).toBe('- item');
		expect(toggleBullet('- item')).toBe('item');
		expect(toggleBullet('1. item')).toBe('- item');
		expect(toggleNumbered('item', 3)).toBe('3. item');
		expect(toggleNumbered('2. item', 1)).toBe('item');
		expect(toggleQuote('text')).toBe('> text');
		expect(toggleQuote('> text')).toBe('text');
		expect(setHeading('## Title', 1)).toBe('# Title');
		expect(setHeading('Title', 3)).toBe('### Title');
		expect(setHeading('# Title', 0)).toBe('Title');
	});
});
