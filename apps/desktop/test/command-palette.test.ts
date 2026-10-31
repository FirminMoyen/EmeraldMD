// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { startShell } from './shell-harness';

it('puts pinned commands first, then the recent ones, and shows the user’s hotkeys', async () => {
	const shell = await startShell(
		{ 'A.md': 'a' },
		{
			'.obsidian/command-palette.json': JSON.stringify({ pinned: ['workspace:split-vertical'] }),
			'.obsidian/hotkeys.json': JSON.stringify({ 'graph:open': [{ modifiers: ['Mod', 'Shift'], key: 'G' }] }),
		},
	);
	const open = async () => {
		shell.press('p', { mod: true });
		return vi.waitFor(() => {
			const items = [...document.querySelectorAll<HTMLElement>('.prompt .suggestion-item')];
			if (!items.length) throw new Error('no palette');
			return items;
		});
	};
	let items = await open();
	expect(items[0]!.querySelector('.suggestion-title')?.textContent).toBe('Split right');
	expect(items[0]!.querySelector('.suggestion-flair')).not.toBeNull();
	const graph = items.find((el) => el.querySelector('.suggestion-title')?.textContent === 'Graph view: Open graph view')!;
	expect(graph.querySelector('.suggestion-hotkey')?.textContent).toContain('G');
	expect(graph.querySelector('.suggestion-hotkey')?.textContent).toMatch(/⇧|Shift/);
	// Running a command makes it come right after the pinned ones next time.
	const outline = items.find((el) => el.querySelector('.suggestion-title')?.textContent === 'Outline: Show outline')!;
	outline.click();
	expect(shell.app.loadLocalStorage('emerald-recent-commands')).toEqual(['outline:open']);
	items = await open();
	expect(items.slice(0, 2).map((el) => el.querySelector('.suggestion-title')?.textContent)).toEqual(['Split right', 'Outline: Show outline']);
	shell.press('Escape');
});
