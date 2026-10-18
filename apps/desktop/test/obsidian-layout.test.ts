// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { Workspaces } from '@emeraldmd/api';
import { fromObsidianLayout, toObsidianLayout } from '../src/obsidian-layout';
import { startShell, type Shell } from './shell-harness';

/** A layout as Obsidian writes it in workspace.json: two tab groups side by side, the right one active. */
const OBSIDIAN = {
	main: {
		id: 'a1',
		type: 'split',
		children: [
			{
				id: 'b1',
				type: 'tabs',
				dimension: 60,
				children: [
					{ id: 'c1', type: 'leaf', state: { type: 'markdown', state: { file: 'A.md', mode: 'source', source: false }, icon: 'lucide-file', title: 'A' } },
					{ id: 'c2', type: 'leaf', state: { type: 'graph', state: {}, title: 'Graph view' } },
				],
				currentTab: 0,
			},
			{ id: 'b2', type: 'tabs', dimension: 40, children: [{ id: 'c3', type: 'leaf', state: { type: 'markdown', state: { file: 'B.md', mode: 'preview' } } }] },
		],
		direction: 'vertical',
	},
	left: { id: 'l', type: 'split', children: [], direction: 'horizontal', width: 300 },
	right: { id: 'r', type: 'split', children: [], direction: 'horizontal', width: 300, collapsed: true },
	active: 'c3',
	lastOpenFiles: ['B.md', 'A.md'],
};

describe('Obsidian layouts', () => {
	it('converts workspace.json to the layout here and back', () => {
		const converted = fromObsidianLayout(OBSIDIAN)!;
		expect(converted.sidebars).toEqual({ right: false });
		expect(converted.saved).toEqual({
			type: 'split',
			direction: 'vertical',
			sizes: [0.6, 0.4],
			children: [
				{ type: 'tabs', tabs: [{ file: 'A.md', mode: 'source' }, { file: null, mode: 'source' }], active: 0 },
				{ type: 'tabs', tabs: [{ file: 'B.md', mode: 'preview' }], active: 0, current: true },
			],
		});
		const back = toObsidianLayout(converted.saved, { left: true, right: false });
		expect(back.right).toEqual({ collapsed: true });
		const main = back.main as { type: string; children: { dimension?: number; children: { id: string; state: { state: { file?: string; mode?: string } } }[] }[] };
		expect(main.type).toBe('split');
		expect(main.children.map((c) => c.dimension)).toEqual([60, 40]);
		expect(main.children[1]!.children[0]!.state.state).toEqual({ file: 'B.md', mode: 'preview', source: false });
		expect(back.active).toBe(main.children[1]!.children[0]!.id);
		expect(fromObsidianLayout({})).toBeNull();
	});
});

describe('the shell and Obsidian layouts', () => {
	let shell: Shell;
	const panes = () => [...document.querySelectorAll<HTMLElement>('.workspace-split.mod-root .workspace-tabs')];
	const titles = () => panes().map((p) => [...p.querySelectorAll('.workspace-tab-header-inner-title')].map((t) => t.textContent));

	it('opens a vault with the tabs and splits Obsidian left in workspace.json', async () => {
		shell = await startShell({ 'A.md': 'alpha', 'B.md': 'bravo', 'C.md': 'charlie' }, { '.obsidian/workspace.json': JSON.stringify(OBSIDIAN) });
		await vi.waitFor(() => expect(titles()).toEqual([['A', 'New tab'], ['B']]));
		expect(panes()[1]!.classList.contains('mod-active')).toBe(true);
		expect(shell.app.workspace.getActiveFile()?.path).toBe('B.md');
		expect(document.getElementById('right-split')!.classList.contains('is-collapsed')).toBe(true);
	});

	it('saves and loads named layouts (Workspaces), in workspaces.json as Obsidian does', async () => {
		await shell.app.internalPlugins.setEnabled('workspaces', true);
		const workspaces = shell.app.internalPlugins.getEnabledPluginById('workspaces') as Workspaces;
		await workspaces.save('Writing');
		const file = JSON.parse((await shell.config.read('.obsidian/workspaces.json'))!) as { workspaces: Record<string, { main: unknown }>; active: string };
		expect(file.active).toBe('Writing');
		expect(fromObsidianLayout(file.workspaces.Writing)?.saved.type).toBe('split');

		// Change the layout, then go back to the saved one.
		shell.app.commands.executeCommandById('workspace:split-horizontal');
		await vi.waitFor(() => expect(panes()).toHaveLength(3));
		await workspaces.load('Writing');
		await vi.waitFor(() => expect(titles()).toEqual([['A', 'New tab'], ['B']]));
		expect(shell.app.workspace.getActiveFile()?.path).toBe('B.md');
	});
});
