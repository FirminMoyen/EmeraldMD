// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import type { CachedMetadata } from '@emeraldmd/core';
import { startShell } from './shell-harness';

it('lists the active note’s links, those not created yet, and unlinked mentions', async () => {
	const home = 'See [[Plan]] and [[Plan]], ![[Ideas]], and [[Missing]].\nThe roadmap and the Archive are mentioned.';
	const shell = await startShell({ 'Home.md': home, 'Plan.md': '', 'Ideas.md': '', 'Archive.md': '', 'Roadmap.md': '---\naliases: [roadmap]\n---\n' }, {});
	const at = (text: string) => ({ line: 0, col: home.indexOf(text), offset: home.indexOf(text) });
	const link = (target: string, original: string) => ({ link: target, original, position: { start: at(original), end: at(original) } });
	const metadata: Record<string, CachedMetadata> = {
		'Home.md': { links: [link('Plan', '[[Plan]]'), link('Plan', '[[Plan]]'), link('Missing', '[[Missing]]')], embeds: [link('Ideas', '![[Ideas]]')] },
		'Roadmap.md': { frontmatter: { aliases: ['roadmap'] } },
	};
	shell.app.vault.applyUpdate({ renamed: [], removed: [], upserted: [], metadata, links: {} });
	await shell.app.workspace.openLinkText('Home', '');
	shell.app.commands.executeCommandById('outgoing-links:open');
	const pane = await vi.waitFor(() => {
		const el = document.querySelector<HTMLElement>('.outgoing-link-pane');
		if (!el?.querySelector('.outgoing-link-item')) throw new Error('no links listed');
		return el;
	});
	const names = () => [...pane.querySelectorAll('.outgoing-link-item')].map((el) => el.querySelector('.tree-item-inner')?.textContent);
	expect(names()).toEqual(['Ideas', 'Plan', 'Missing']);
	expect(pane.querySelector('.outgoing-link-item[title="Plan.md"] .tree-item-flair')?.textContent).toBe('2');
	expect(pane.querySelector('.outgoing-link-item.is-unresolved')?.textContent).toBe('Missing');

	// Unlinked mentions are looked for once their section is opened (names and aliases, whole words).
	[...pane.querySelectorAll<HTMLElement>('.outgoing-link-header')].find((el) => el.textContent?.startsWith('Unlinked mentions'))!.click();
	await vi.waitFor(() => expect(names()).toEqual(['Ideas', 'Plan', 'Missing', 'Archive', 'Roadmap']));
});
