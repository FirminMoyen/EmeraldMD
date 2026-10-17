// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { startShell } from './shell-harness';

describe('back and forward', () => {
	it('walks the notes opened, skipping deleted ones', async () => {
		const shell = await startShell({ 'A.md': 'a', 'B.md': 'b', 'C.md': 'c' }, {});
		const open = async (path: string) => {
			document.querySelector<HTMLElement>(`.nav-file-title[data-path="${path}"]`)!.click();
			await vi.waitFor(() => expect(shell.app.workspace.getActiveFile()?.path).toBe(path));
		};
		const active = () => shell.app.workspace.getActiveFile()?.path;
		const back = document.querySelector<HTMLElement>('.view-header-nav-button[aria-label^="Navigate back"]')!;
		const forward = document.querySelector<HTMLElement>('.view-header-nav-button[aria-label^="Navigate forward"]')!;

		await open('A.md');
		await open('B.md');
		await open('C.md');
		expect(forward.classList.contains('is-disabled')).toBe(true);
		shell.app.commands.executeCommandById('app:go-back');
		await vi.waitFor(() => expect(active()).toBe('B.md'));
		back.click();
		await vi.waitFor(() => expect(active()).toBe('A.md'));
		expect(forward.classList.contains('is-disabled')).toBe(false);
		shell.app.commands.executeCommandById('app:go-forward');
		await vi.waitFor(() => expect(active()).toBe('B.md'));

		// Opening a note drops the forward history; deleted notes are skipped.
		await open('A.md');
		expect(forward.classList.contains('is-disabled')).toBe(true);
		await shell.app.vault.trash(shell.app.vault.getFileByPath('B.md')!);
		await open('C.md');
		shell.app.commands.executeCommandById('app:go-back');
		await vi.waitFor(() => expect(active()).toBe('A.md'));
		shell.app.commands.executeCommandById('app:go-back');
		await vi.waitFor(() => expect(active()).not.toBe('B.md'));
	});
});
