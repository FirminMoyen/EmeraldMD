// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { startShell } from './shell-harness';

describe('selective sync', () => {
	it('leaves folders and file types out of sync', async () => {
		const filters: unknown[] = [];
		const synced = { localPath: '/vault', serverUrl: 'https://notes.example.com', vaultId: 'notes', name: 'Notes', syncConfig: false, filter: { excludedFolders: [], excludedTypes: [] } };
		const shell = await startShell({ 'Home.md': 'hi', 'Archive/Old.md': 'old', 'Media/clip.mp4': 'v' }, {}, false, {
			open_vault_sync: () => synced,
			sync_now: () => null,
			set_sync_filter: (args) => {
				filters.push(args.filter);
				return null;
			},
		});
		await vi.waitFor(() => expect(document.querySelector('.emerald-sync-status')).not.toBeNull());
		shell.app.setting.open();
		shell.app.setting.openTabById('sync');
		const setting = (name: string) =>
			vi.waitFor(() => {
				const el = [...document.querySelectorAll<HTMLElement>('.setting-item')].find((item) => item.querySelector('.setting-item-name')?.textContent === name);
				if (!el) throw new Error(`no setting ${name}`);
				return el;
			});

		(await setting('Sync videos')).querySelector<HTMLElement>('.checkbox-container')!.click();
		await vi.waitFor(() => expect(filters.at(-1)).toEqual({ excludedFolders: [], excludedTypes: ['video'] }));

		(await setting('Excluded folders')).querySelector<HTMLButtonElement>('button')!.click();
		const archive = await vi.waitFor(() => {
			const item = [...document.querySelectorAll<HTMLElement>('.prompt .suggestion-item')].find((el) => el.textContent === 'Archive');
			if (!item) throw new Error('no folder list');
			return item;
		});
		archive.click();
		await vi.waitFor(() => expect(filters.at(-1)).toEqual({ excludedFolders: ['Archive'], excludedTypes: ['video'] }));
		// The folder is listed, and can be synced again.
		const row = await setting('Archive');
		row.querySelector<HTMLElement>('.clickable-icon')!.click();
		await vi.waitFor(() => expect(filters.at(-1)).toEqual({ excludedFolders: [], excludedTypes: ['video'] }));
	});
});
