/**
 * Obsidian's layout format (the one in `.obsidian/workspace.json`, in
 * `workspaces.json`, and of `workspace.getLayout()`), to and from the main
 * area's layout here (`SavedLayout`, splits.ts).
 *
 * `main` is a split (`direction`: `vertical` puts children side by side) of
 * splits and tab groups (`type: "tabs"`, `currentTab`), whose children are
 * leaves (`type: "leaf"`, `state: { type, state: { file, mode } }`); a
 * child's `dimension` is its share in percent. `left` and `right` are the
 * sidebars (only `collapsed` is read here), `active` the current leaf's id.
 */

import type { SavedLayout } from './splits';

export interface ObsidianLeaf {
	id?: string;
	type: 'leaf';
	state?: { type?: string; state?: { file?: unknown; mode?: unknown } & Record<string, unknown>; title?: string; icon?: string };
	dimension?: number;
}

export interface ObsidianTabs {
	id?: string;
	type: 'tabs';
	children: ObsidianLeaf[];
	currentTab?: number;
	dimension?: number;
}

export interface ObsidianSplit {
	id?: string;
	type: 'split';
	direction?: 'vertical' | 'horizontal';
	children: (ObsidianSplit | ObsidianTabs)[];
	dimension?: number;
	collapsed?: boolean;
}

export interface ObsidianLayout {
	main?: ObsidianSplit | ObsidianTabs;
	left?: { collapsed?: boolean } & Record<string, unknown>;
	right?: { collapsed?: boolean } & Record<string, unknown>;
	active?: string;
	lastOpenFiles?: string[];
	[key: string]: unknown;
}

/** A random id, like Obsidian's 16 hex digits. */
function newId(): string {
	return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Our layout in Obsidian's format; `sidebars` says which sidebars are open. */
export function toObsidianLayout(saved: SavedLayout, sidebars: { left: boolean; right: boolean }, lastOpenFiles: string[] = []): ObsidianLayout {
	let active: string | undefined;
	const convert = (node: SavedLayout, dimension?: number): ObsidianSplit | ObsidianTabs => {
		if (node.type === 'tabs') {
			const children: ObsidianLeaf[] = node.tabs.map((tab, i) => {
				const id = newId();
				if (node.current && i === node.active) active = id;
				if (!tab.file) return { id, type: 'leaf', state: { type: 'empty', state: {} } };
				const markdown = tab.file.endsWith('.md');
				const type = markdown ? 'markdown' : tab.file.endsWith('.canvas') ? 'canvas' : 'file';
				return { id, type: 'leaf', state: { type, state: markdown ? { file: tab.file, mode: tab.mode, source: false } : { file: tab.file } } };
			});
			return { id: newId(), type: 'tabs', children, currentTab: node.active, ...(dimension !== undefined ? { dimension } : {}) };
		}
		const total = node.sizes.reduce((a, b) => a + b, 0) || 1;
		return {
			id: newId(),
			type: 'split',
			direction: node.direction,
			children: node.children.map((child, i) => convert(child, node.children.length > 1 ? Math.round((1000 * (node.sizes[i] ?? 1)) / total) / 10 : undefined)) as (ObsidianSplit | ObsidianTabs)[],
			...(dimension !== undefined ? { dimension } : {}),
		};
	};
	const main = convert(saved);
	return {
		main: main.type === 'split' ? main : { id: newId(), type: 'split', direction: 'vertical', children: [main] },
		left: { collapsed: !sidebars.left },
		right: { collapsed: !sidebars.right },
		...(active ? { active } : {}),
		lastOpenFiles,
	};
}

/** Obsidian's layout as ours, or null if it has no main area to show. Leaves of views without a file become empty tabs. */
export function fromObsidianLayout(layout: unknown): { saved: SavedLayout; sidebars: { left?: boolean; right?: boolean } } | null {
	const json = layout as ObsidianLayout | null;
	if (!json || typeof json !== 'object' || !json.main || typeof json.main !== 'object') return null;
	const active = typeof json.active === 'string' ? json.active : null;
	const convert = (node: ObsidianSplit | ObsidianTabs): SavedLayout | null => {
		if (node.type === 'tabs') {
			const leaves = Array.isArray(node.children) ? node.children.filter((c) => c && c.type === 'leaf') : [];
			if (!leaves.length) return null;
			const tabs = leaves.map((leaf) => {
				const file = leaf.state?.state?.file;
				const mode = leaf.state?.state?.mode === 'preview' ? ('preview' as const) : ('source' as const);
				return { file: typeof file === 'string' ? file : null, mode };
			});
			const current = Math.min(Math.max(0, Number(node.currentTab) || 0), tabs.length - 1);
			const holdsActive = active !== null && leaves.some((leaf) => leaf.id === active);
			const activeIndex = holdsActive ? leaves.findIndex((leaf) => leaf.id === active) : current;
			return { type: 'tabs', tabs, active: activeIndex, ...(holdsActive ? { current: true } : {}) };
		}
		if (node.type !== 'split' || !Array.isArray(node.children)) return null;
		const children: SavedLayout[] = [];
		const sizes: number[] = [];
		for (const child of node.children) {
			const converted = child && typeof child === 'object' ? convert(child) : null;
			if (!converted) continue;
			children.push(converted);
			const dimension = Number(child.dimension);
			sizes.push(Number.isFinite(dimension) && dimension > 0 ? dimension / 100 : 1);
		}
		if (!children.length) return null;
		return { type: 'split', direction: node.direction === 'horizontal' ? 'horizontal' : 'vertical', sizes, children };
	};
	const saved = convert(json.main);
	if (!saved) return null;
	const sidebars: { left?: boolean; right?: boolean } = {};
	if (json.left && typeof json.left.collapsed === 'boolean') sidebars.left = !json.left.collapsed;
	if (json.right && typeof json.right.collapsed === 'boolean') sidebars.right = !json.right.collapsed;
	return { saved, sidebars };
}
