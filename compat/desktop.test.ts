// The desktop UI (apps/desktop/src/main.ts, IPC mocked) with a real community
// plugin, Hider: its command runs from the command palette and its settings tab renders.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startShell } from '../apps/desktop/test/shell-harness';
import type { PinnedPlugin } from './smoke';

const { plugins } = JSON.parse(readFileSync('compat/plugins.json', 'utf8')) as { plugins: PinnedPlugin[] };
const hider = plugins.find((p) => p.id === 'obsidian-hider')!;
const dir = join('compat', '.cache', 'plugins', hider.id, hider.version);

describe.skipIf(!existsSync(join(dir, 'main.js')))('Hider in the desktop UI', () => {
	it('runs its command from the palette and shows its settings tab', async () => {
		const files = (name: string) => readFileSync(join(dir, name), 'utf8');
		const shell = await startShell(
			{ 'Welcome.md': '# Welcome\n' },
			{
				'.obsidian/community-plugins.json': '["obsidian-hider"]',
				'.obsidian/plugins/obsidian-hider/manifest.json': files('manifest.json'),
				'.obsidian/plugins/obsidian-hider/main.js': files('main.js'),
				'.obsidian/plugins/obsidian-hider/styles.css': files('styles.css'),
			},
			true,
		);
		expect(shell.app.plugins.getPlugin('obsidian-hider')).not.toBeNull();
		expect(document.head.querySelector('style[data-plugin-id="obsidian-hider"]')).not.toBeNull();

		shell.press('p', { mod: true });
		shell.typeInto(document.querySelector<HTMLInputElement>('.prompt-input')!, 'hider status');
		await vi.waitFor(() => expect(document.querySelector('.suggestion-item.is-selected')?.textContent).toBe('Hider: Toggle status bar'));
		shell.press('Enter');
		await vi.waitFor(() => expect(document.body.classList.contains('hider-status')).toBe(true));
		await vi.waitFor(() => expect(JSON.parse(shell.config.files.get('.obsidian/plugins/obsidian-hider/data.json')!).hideStatus).toBe(true));

		shell.press(',', { mod: true });
		const nav = [...document.querySelectorAll('.vertical-tab-nav-item')].find((n) => n.textContent === 'Hider') as HTMLElement;
		nav.click();
		const rows = [...document.querySelectorAll('.vertical-tab-content .setting-item-name')].map((n) => n.textContent);
		expect(rows).toContain('Hide status bar');
		expect(document.querySelector('.vertical-tab-content .setting-tab-error')).toBeNull();
	});
});
