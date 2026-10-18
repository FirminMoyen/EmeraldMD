// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import '../src';
import { CodeMirrorEditor, moment, RandomNote, UniqueNoteCreator } from '../src';
import { createTestApp } from '../src/testing';

afterEach(() => document.body.replaceChildren());

describe('small core plugins', () => {
	it('lists commands after "/" and runs the one chosen in place of what was typed', async () => {
		const { app } = await createTestApp({ 'Note.md': '' }, {});
		await app.internalPlugins.load(app);
		await app.internalPlugins.setEnabled('slash-command', true);
		const ran: string[] = [];
		app.commands.addCommand({ id: 'test:shout', name: 'Shout loudly', callback: () => ran.push('shout') });
		const suggest = app.workspace.editorSuggest.suggests.find((s) => s.constructor.name === 'CommandSuggest')!;
		const view = new EditorView({ state: EditorState.create({ doc: 'Hello /shou', selection: { anchor: 11 } }), parent: document.body });
		const editor = new CodeMirrorEditor(view);
		expect(suggest.onTrigger(editor.getCursor(), editor, null)).toEqual({ start: { line: 0, ch: 6 }, end: { line: 0, ch: 11 }, query: 'shou' });
		// Not inside a path.
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'see a/b' }, selection: { anchor: 7 } });
		expect(suggest.onTrigger(editor.getCursor(), editor, null)).toBeNull();
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Hello /shou' }, selection: { anchor: 11 } });
		await suggest.trigger(editor, null, view);
		const items = suggest.getSuggestions(suggest.context!) as { command: { id: string } }[];
		expect(items[0]!.command.id).toBe('test:shout');
		suggest.selectSuggestion(items[0] as never, new MouseEvent('click'));
		expect(editor.getValue()).toBe('Hello ');
		expect(ran).toEqual(['shout']);
	});

	it('opens a random note other than the open one', async () => {
		const { app } = await createTestApp({ 'A.md': '', 'B.md': '' }, {});
		await app.internalPlugins.load(app);
		await app.internalPlugins.setEnabled('random-note', true);
		const random = app.internalPlugins.getEnabledPluginById('random-note') as RandomNote;
		vi.spyOn(app.workspace, 'getActiveFile').mockReturnValue(app.vault.getFileByPath('A.md'));
		expect(random.pick()?.path).toBe('B.md');
	});

	it('creates unique notes named by the time, in a folder, from a template', async () => {
		const { app } = await createTestApp({ 'Templates/Zettel.md': '# {{title}}\n' }, {});
		await app.internalPlugins.load(app);
		await app.internalPlugins.setEnabled('zk-prefixer', true);
		const creator = app.internalPlugins.getEnabledPluginById('zk-prefixer') as UniqueNoteCreator;
		creator.options = { folder: 'Zettel', template: 'Templates/Zettel' };
		const file = await creator.create(moment('2026-10-18T21:05:00'));
		expect(file?.path).toBe('Zettel/202610182105.md');
		expect(await app.vault.read(file!)).toBe('# 202610182105\n');
		// The same minute again: a free name.
		expect((await creator.create(moment('2026-10-18T21:05:30')))?.path).toBe('Zettel/202610182105 1.md');
	});
});
