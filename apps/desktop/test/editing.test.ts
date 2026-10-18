// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { startShell } from './shell-harness';

it('runs Obsidian’s editing commands from their hotkeys, and folds headings', async () => {
	const shell = await startShell({ 'Note.md': '# One\nsome words\n## Two\nmore\n- task' }, {});
	await shell.app.workspace.openLinkText('Note', '');
	await vi.waitFor(() => expect(shell.editorText()).toContain('some words'));
	const editor = shell.app.workspace.activeEditor!.editor!;
	// With the editor focused, happy-dom reports selection changes in the middle of CodeMirror's updates.
	(document.activeElement as HTMLElement | null)?.blur();
	const key = (k: string, mods: { mod?: boolean; shift?: boolean } = { mod: true }) => shell.press(k, mods);

	editor.setSelection({ line: 1, ch: 0 }, { line: 1, ch: 4 });
	key('b');
	expect(editor.getLine(1)).toBe('**some** words');
	editor.setSelection({ line: 1, ch: 9 }, { line: 1, ch: 14 });
	key('i');
	expect(editor.getLine(1)).toBe('**some** *words*');
	editor.setCursor({ line: 4, ch: 3 });
	key('l');
	expect(editor.getLine(4)).toBe('- [ ] task');
	editor.setSelection({ line: 3, ch: 0 }, { line: 3, ch: 4 });
	key('k');
	expect(editor.getLine(3)).toBe('[more]()');
	key('/');
	expect(editor.getValue()).toContain('%%');

	shell.app.commands.executeCommandById('editor:set-heading-3');
	shell.app.commands.executeCommandById('editor:fold-all');
	await vi.waitFor(() => expect(document.querySelector('.cm-foldPlaceholder')).not.toBeNull());
	shell.app.commands.executeCommandById('editor:unfold-all');
	await vi.waitFor(() => expect(document.querySelector('.cm-foldPlaceholder')).toBeNull());
	expect(document.querySelector('.cm-foldGutter')).not.toBeNull();
});

it('has Obsidian’s editor menu, with submenus and items from plugins (editor-menu)', async () => {
	const shell = (globalThis as { app?: import('@emeraldmd/api').App }).app!;
	const seen: string[] = [];
	const ref = shell.workspace.on('editor-menu', (menu: import('@emeraldmd/api').Menu, editor: import('@emeraldmd/api').Editor) => {
		seen.push(editor.getLine(0));
		menu.addItem((item) => item.setTitle('From a plugin').setSection('plugin'));
	});
	const editor = shell.workspace.activeEditor!.editor!;
	editor.setValue('plain words');
	editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 5 });
	document.querySelector('.cm-content')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
	const titles = () => [...document.querySelectorAll('.menu:not(.mod-submenu) > .menu-item .menu-item-title')].map((el) => el.textContent);
	expect(titles()).toEqual(['Cut', 'Copy', 'Paste', 'Select all', 'Format', 'Paragraph', 'Insert', 'From a plugin']);
	expect(seen).toEqual(['plain words']);
	// Format opens its submenu; Bold acts on the selection.
	const format = [...document.querySelectorAll<HTMLElement>('.menu-item')].find((el) => el.textContent === 'Format')!;
	format.dispatchEvent(new MouseEvent('mouseenter'));
	const bold = [...document.querySelectorAll<HTMLElement>('.menu.mod-submenu .menu-item')].find((el) => el.textContent === 'Bold')!;
	bold.click();
	expect(editor.getValue()).toBe('**plain** words');
	expect(document.querySelector('.menu')).toBeNull();
	shell.workspace.offref(ref);
});
