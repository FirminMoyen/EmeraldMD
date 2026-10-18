// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { startShell } from './shell-harness';

/** The app's per-vault id for the harness's vault (same as appIdFor in main.ts). */
function appIdFor(basePath: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < basePath.length; i++) {
		const c = basePath.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 ^ c, 0x811c9dc5);
	}
	return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).slice(0, 16);
}

it('restores the panes, each showing its note, and keeps the saved current pane', async () => {
	localStorage.setItem(
		`${appIdFor('/vault')}-emerald-layout`,
		JSON.stringify({
			type: 'split',
			direction: 'vertical',
			sizes: [2, 1],
			children: [
				{ type: 'tabs', tabs: [{ file: 'A.md', mode: 'source' }], active: 0 },
				{ type: 'tabs', tabs: [{ file: 'Gone.md', mode: 'source' }, { file: 'B.md', mode: 'source' }], active: 1, current: true },
			],
		}),
	);
	const shell = await startShell({ 'A.md': 'alpha', 'B.md': 'bravo' }, {});
	const panes = () => [...document.querySelectorAll<HTMLElement>('.workspace-split.mod-root .workspace-tabs')];
	await vi.waitFor(() => expect(panes().map((p) => p.querySelector('.cm-content')?.textContent)).toEqual(['alpha', 'bravo']));
	expect(panes()[1]!.classList.contains('mod-active')).toBe(true);
	expect(shell.app.workspace.getActiveFile()?.path).toBe('B.md');
	// A tab whose note is gone is left out; sizes come back.
	expect(panes()[1]!.querySelectorAll('.workspace-tab-header')).toHaveLength(1);
	expect(panes()[0]!.style.flexGrow).toBe('2');
});
