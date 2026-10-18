// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { startShell } from './shell-harness';

const treeItem = (path: string) => document.querySelector<HTMLElement>(`.nav-file-title[data-path="${path}"]`)!;
const notices = () => [...document.querySelectorAll('.notice')].map((el) => el.textContent ?? '');

describe('saves that fail', () => {
	it('keeps the edits, shows them instead of the file, and saves them once possible', async () => {
		const shell = await startShell({ 'A.md': 'alpha', 'B.md': 'bravo' }, {});
		const active = () => shell.app.workspace.getActiveFile()?.path;
		treeItem('A.md').click();
		await vi.waitFor(() => expect(active()).toBe('A.md'));

		// The vault cannot be written (a server vault while the server is down).
		const write = shell.backend.write.bind(shell.backend);
		shell.backend.write = async () => {
			throw new TypeError('Load failed');
		};
		const editor = shell.app.workspace.activeEditor!.editor!;
		editor.setCursor({ line: 0, ch: 5 });
		editor.replaceSelection(' offline');
		shell.app.commands.executeCommandById('editor:save-file');
		await vi.waitFor(() => expect(notices().some((n) => n.startsWith('Could not save A.md: the server is unreachable'))).toBe(true));
		expect(document.getElementById('status-core')!.textContent).toContain('Not saved yet');

		// Another note and back: the edits are still there, not the file's text.
		treeItem('B.md').click();
		await vi.waitFor(() => expect(active()).toBe('B.md'));
		treeItem('A.md').click();
		await vi.waitFor(() => expect(shell.editorText()).toBe('alpha offline'));
		expect(await shell.backend.read('A.md')).toBe('alpha');

		// Writable again: the next save sends them.
		shell.backend.write = write;
		shell.app.commands.executeCommandById('editor:save-file');
		await vi.waitFor(() => expect(shell.backend.read('A.md')).resolves.toBe('alpha offline'));
		await vi.waitFor(() => expect(notices()).toContain('All changes are saved.'));
		expect(document.getElementById('status-core')!.textContent).toContain('Saved');
	});

	it('says why a note cannot be opened, instead of leaving the previous one in place', async () => {
		const shell = (globalThis as { app?: import('@emeraldmd/api').App }).app!;
		const backend = (shell.vault as unknown as { backend: { read(path: string): Promise<string> } }).backend;
		const read = backend.read.bind(backend);
		backend.read = async (path) => {
			// What fetch throws when the server cannot be reached.
			if (path === 'B.md') throw new TypeError('Load failed');
			return read(path);
		};
		await shell.vault.create('C.md', 'charlie');
		treeItem('B.md').click();
		await vi.waitFor(() => expect(document.getElementById('no-file')!.hidden).toBe(false));
		expect(document.getElementById('no-file')!.textContent).toContain('Could not open B.md: the server is unreachable');
		expect(document.getElementById('editor')!.hidden).toBe(true);
		// Edits cannot go to the note shown before.
		expect(shell.workspace.activeEditor).toBeNull();
		backend.read = read;
		treeItem('B.md').click();
		await vi.waitFor(() => expect(document.getElementById('editor')!.hidden).toBe(false));
		expect(document.getElementById('no-file')!.textContent).toContain('No note is open');
	});
});
