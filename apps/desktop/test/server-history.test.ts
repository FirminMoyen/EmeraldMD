// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import type { RemoteBackend } from '@emeraldmd/core';
import { registerServerHistory, serverHistorySource } from '../src/remote/history';
import { startShell } from './shell-harness';

/** A server with two versions of Note.md, and a deleted note and image. */
function fakeServer() {
	const texts: Record<string, Record<number, string>> = {
		'Note.md': { 200: 'second', 100: 'first' },
		'Gone/Old.md': { 50: 'old text' },
	};
	const encoder = new TextEncoder();
	return {
		versions: vi.fn(async (path: string) =>
			Object.keys(texts[path] ?? {})
				.map(Number)
				.sort((a, b) => b - a)
				.map((time) => ({ time, size: texts[path]![time]!.length })),
		),
		readVersion: vi.fn(async (path: string, time: number) => encoder.encode(texts[path]![time]!).buffer),
		deletedFiles: vi.fn(async () => [
			{ path: 'Gone/Old.md', deletedAt: 60, size: 8 },
			{ path: 'photo.png', deletedAt: 70, size: 9000 },
		]),
	} as unknown as RemoteBackend;
}

it('reads versions and deleted notes from the server', async () => {
	const source = serverHistorySource(async () => fakeServer());
	expect(await source.list('Note.md')).toEqual([
		{ path: 'Note.md', time: 200, text: 'second' },
		{ path: 'Note.md', time: 100, text: 'first' },
	]);
	// Attachments are left out: the modal shows text.
	expect(await source.paths()).toEqual([{ path: 'Gone/Old.md', time: 60 }]);
});

it('shows a note’s versions and restores a deleted note with its folder', async () => {
	const shell = await startShell({ 'Note.md': 'current' }, {});
	registerServerHistory(shell.app, async () => fakeServer());
	await shell.app.workspace.getLeaf(false).openFile(shell.app.vault.getFileByPath('Note.md')!);
	expect(shell.app.commands.executeCommandById('server-history:open')).toBe(true);
	const items = await vi.waitFor(() => {
		const found = [...document.querySelectorAll('.mod-file-recovery .file-recovery-item')];
		if (found.length !== 2) throw new Error('no versions yet');
		return found;
	});
	expect(document.querySelector('.mod-file-recovery .modal-title')?.textContent).toBe('Version history: Note.md');
	expect(items).toHaveLength(2);
	expect(document.querySelector('.file-recovery-content pre')?.textContent).toBe('second');
	document.querySelector<HTMLElement>('.mod-file-recovery .modal-close-button')!.click();

	expect(shell.app.commands.executeCommandById('server-history:deleted')).toBe(true);
	const deleted = await vi.waitFor(() => {
		const el = document.querySelector<HTMLElement>('.mod-file-recovery .file-recovery-item');
		if (!el) throw new Error('no deleted files yet');
		return el;
	});
	expect(document.querySelector('.mod-file-recovery .modal-title')?.textContent).toBe('Deleted files');
	expect(deleted.querySelector('.file-recovery-path')?.textContent).toBe('Gone/Old.md');
	deleted.click();
	const restore = await vi.waitFor(() => {
		const button = [...document.querySelectorAll<HTMLButtonElement>('.file-recovery-actions button')].find((b) => b.textContent === 'Restore');
		if (!button) throw new Error('no restore button yet');
		return button;
	});
	restore.click();
	const confirm = await vi.waitFor(() => {
		const button = [...document.querySelectorAll<HTMLButtonElement>('.modal-button-container button')].find((b) => b.textContent === 'Restore');
		if (!button) throw new Error('no confirmation yet');
		return button;
	});
	confirm.click();
	await vi.waitFor(() => {
		if (!shell.app.vault.getFileByPath('Gone/Old.md')) throw new Error('not restored yet');
	});
	expect(await shell.app.vault.read(shell.app.vault.getFileByPath('Gone/Old.md')!)).toBe('old text');
});
