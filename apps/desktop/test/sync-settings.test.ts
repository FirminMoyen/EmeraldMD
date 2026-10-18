// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { emit } from '@tauri-apps/api/event';
import { startShell } from './shell-harness';

describe('synced vault settings', () => {
	it('offers to sync .obsidian, and to reload when settings arrive from another device', async () => {
		const calls: unknown[] = [];
		const synced = { localPath: '/vault', serverUrl: 'https://notes.example.com', vaultId: 'notes', name: 'Notes', syncConfig: false };
		const shell = await startShell({ 'Home.md': 'hi' }, {}, false, {
			open_vault_sync: () => synced,
			sync_now: () => null,
			set_sync_config: (args) => {
				calls.push(args);
				return null;
			},
		});
		await vi.waitFor(() => expect(document.querySelector('.emerald-sync-status')).not.toBeNull());

		shell.app.setting.open();
		shell.app.setting.openTabById('sync');
		const toggle = await vi.waitFor(() => {
			const setting = [...document.querySelectorAll('.setting-item')].find((el) => el.textContent?.includes('Sync settings, themes and plugins'));
			const el = setting?.querySelector<HTMLElement>('.checkbox-container');
			if (!el) throw new Error('no toggle');
			return el;
		});
		expect(document.querySelector('.vertical-tab-content')?.textContent).toContain('notes.example.com');
		toggle.click();
		await vi.waitFor(() => expect(calls).toEqual([{ enabled: true }]));
		shell.app.setting.close();

		// Settings other than themes and snippets need a reload.
		await emit('config-synced', ['.obsidian/snippets/a.css']);
		await emit('config-synced', ['.obsidian/app.json']);
		await vi.waitFor(() => expect(document.querySelectorAll('.notice').length).toBe(1));
		const notice = document.querySelector('.notice')!;
		expect(notice.textContent).toContain('Settings changed on another device.');
		expect(notice.querySelector('button')?.textContent).toBe('Reload');
	});
});
