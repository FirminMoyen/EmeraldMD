// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src';
import { diffLines, FileRecovery, MemorySnapshotStore } from '../src';
import type { TFile } from '@emeraldmd/core';
import { createTestApp } from '../src/testing';

afterEach(() => document.body.replaceChildren());

const MINUTE = 60_000;

async function setup() {
	const test = await createTestApp({ 'Note.md': 'one', 'Other.md': 'other' }, {});
	await test.app.internalPlugins.load(test.app);
	const recovery = test.app.internalPlugins.getEnabledPluginById('file-recovery') as FileRecovery;
	const store = new MemorySnapshotStore();
	recovery.store = store;
	const note = test.app.vault.getFileByPath('Note.md') as TFile;
	return { ...test, recovery, store, note };
}

describe('File recovery', () => {
	it('is on by default, and takes at most one snapshot per note per interval, when the text changed', async () => {
		const { recovery, store, note, app } = await setup();
		expect(recovery.interval).toBe(5);
		expect(recovery.keep).toBe(7);
		const t0 = 1_000_000_000_000;
		await recovery.snapshot(note, t0);
		await app.vault.modify(note, 'two');
		await recovery.snapshot(note, t0 + MINUTE);
		await recovery.snapshot(note, t0 + 6 * MINUTE);
		// Same text as the last snapshot: none.
		await recovery.snapshot(note, t0 + 12 * MINUTE);
		expect((await store.list('Note.md')).map((s) => s.text)).toEqual(['two', 'one']);
	});

	it('snapshots notes as they change, and drops old snapshots', async () => {
		const { recovery, store, note, app } = await setup();
		await app.vault.modify(note, 'changed');
		await vi.waitFor(async () => expect((await store.list('Note.md'))[0]?.text).toBe('changed'));
		await store.add({ path: 'Other.md', time: Date.now() - 8 * 24 * 60 * MINUTE, text: 'old' });
		await recovery.prune();
		expect(await store.list('Other.md')).toEqual([]);
		expect((await store.paths()).map((p) => p.path)).toEqual(['Note.md']);
	});

	it('shows the history and restores a version, keeping the current text as a snapshot', async () => {
		const { recovery, store, note, app } = await setup();
		await store.add({ path: 'Note.md', time: Date.now() - 10 * MINUTE, text: 'first\nshared' });
		await app.vault.modify(note, 'second\nshared');
		recovery.openHistory(note);
		const items = await vi.waitFor(() => {
			const found = document.querySelectorAll<HTMLElement>('.mod-file-recovery .file-recovery-item');
			if (!found.length) throw new Error('no snapshots listed');
			return found;
		});
		items[items.length - 1]!.click();
		await vi.waitFor(() => expect(document.querySelector('.file-recovery-content pre')?.textContent).toBe('first\nshared'));
		const toggle = document.querySelector<HTMLInputElement>('.file-recovery-toggle input')!;
		toggle.checked = true;
		toggle.dispatchEvent(new Event('change'));
		expect([...document.querySelectorAll('.file-recovery-line')].map((l) => l.className.split('mod-')[1])).toEqual(['removed', 'added', 'same']);

		[...document.querySelectorAll<HTMLButtonElement>('.file-recovery-actions button')].find((b) => b.textContent === 'Restore')!.click();
		const confirm = await vi.waitFor(() => {
			const button = [...document.querySelectorAll<HTMLButtonElement>('.modal-button-container button')].find((b) => b.textContent === 'Restore');
			if (!button) throw new Error('no confirmation');
			return button;
		});
		confirm.click();
		await vi.waitFor(() => expect(app.vault.read(note)).resolves.toBe('first\nshared'));
		expect((await store.list('Note.md')).some((s) => s.text === 'second\nshared')).toBe(true);
	});

	it('diffs by line', () => {
		expect(diffLines('a\nb\nc', 'a\nc\nd')).toEqual([
			{ kind: 'same', text: 'a' },
			{ kind: 'removed', text: 'b' },
			{ kind: 'same', text: 'c' },
			{ kind: 'added', text: 'd' },
		]);
	});
});
