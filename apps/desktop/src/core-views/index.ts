/**
 * Built-in views, registered like Obsidian's core plugins: search, graph,
 * local graph, outline, outgoing links, tags, bookmarks, canvas files, and
 * the quick switcher.
 */

import type { App } from '@emeraldmd/api';
import { BOOKMARKS_VIEW, BookmarksView } from './bookmarks';
import { CANVAS_VIEW, CanvasFileView } from './canvas';
import { GlobalGraphView, GRAPH_VIEW, LOCAL_GRAPH_VIEW, LocalGraphView } from './graph';
import type { CoreViewHost } from './host';
import { OUTGOING_VIEW, OutgoingLinksView } from './outgoing';
import { OUTLINE_VIEW, OutlineView } from './outline';
import { QuickSwitcher } from './quick-switcher';
import { SEARCH_VIEW, SearchView } from './search';
import { TAGS_VIEW, TagsView } from './tags';

export type { CoreViewHost } from './host';
export { SEARCH_VIEW, SearchView } from './search';

const EMPTY_CANVAS = '{\n\t"nodes": [],\n\t"edges": []\n}';

export function registerCoreViews(app: App, host: CoreViewHost): void {
	const views = app.viewRegistry;
	views.registerView(SEARCH_VIEW, (leaf) => new SearchView(leaf, host));
	views.registerView(GRAPH_VIEW, (leaf) => new GlobalGraphView(leaf, host));
	views.registerView(LOCAL_GRAPH_VIEW, (leaf) => new LocalGraphView(leaf, host));
	views.registerView(OUTLINE_VIEW, (leaf) => new OutlineView(leaf, host));
	views.registerView(OUTGOING_VIEW, (leaf) => new OutgoingLinksView(leaf, host));
	views.registerView(TAGS_VIEW, (leaf) => new TagsView(leaf, host));
	views.registerView(CANVAS_VIEW, (leaf) => new CanvasFileView(leaf, host));
	views.registerView(BOOKMARKS_VIEW, (leaf) => new BookmarksView(leaf, host));
	views.registerExtensions(['canvas'], CANVAS_VIEW);

	const ws = app.workspace;
	const openGraph = () => ws.rootLeaf.setViewState({ type: GRAPH_VIEW, active: true });
	const newCanvas = async () => {
		const file = await app.vault.create(app.vault.getAvailablePath('Untitled', 'canvas'), EMPTY_CANVAS);
		await host.openFile(file);
	};

	const add = app.commands.addCommand.bind(app.commands);
	add({ id: 'switcher:open', name: 'Quick switcher: Open quick switcher', hotkeys: [{ modifiers: ['Mod'], key: 'O' }], callback: () => new QuickSwitcher(app, host).open() });
	add({ id: 'global-search:open', name: 'Search: Search in all files', hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'F' }], callback: () => host.openSearch('') });
	add({ id: 'graph:open', name: 'Graph view: Open graph view', hotkeys: [{ modifiers: ['Mod'], key: 'G' }], callback: openGraph });
	add({ id: 'graph:open-local', name: 'Graph view: Open local graph', callback: () => ws.ensureSideLeaf(LOCAL_GRAPH_VIEW, 'right') });
	add({ id: 'outline:open', name: 'Outline: Show outline', callback: () => ws.ensureSideLeaf(OUTLINE_VIEW, 'right') });
	add({ id: 'outgoing-links:open', name: 'Outgoing links: Show outgoing links', callback: () => ws.ensureSideLeaf(OUTGOING_VIEW, 'right') });
	add({ id: 'tag-pane:open', name: 'Tags view: Show tags', callback: () => ws.ensureSideLeaf(TAGS_VIEW, 'right') });
	add({ id: 'canvas:new-file', name: 'Canvas: Create new canvas', callback: newCanvas });
	add({
		id: 'bookmarks:open',
		name: 'Bookmarks: Show bookmarks',
		checkCallback: (checking) => {
			if (!app.internalPlugins.getEnabledPluginById('bookmarks')) return false;
			if (!checking) void ws.ensureSideLeaf(BOOKMARKS_VIEW, 'left');
			return true;
		},
	});

	ws.leftRibbon.addRibbonItemButton('switcher:open', 'file-search', 'Open quick switcher', () => new QuickSwitcher(app, host).open());
	ws.leftRibbon.addRibbonItemButton('graph:open', 'git-fork', 'Open graph view', openGraph);
	ws.leftRibbon.addRibbonItemButton('canvas:new-file', 'layout-dashboard', 'Create new canvas', newCanvas);

	// Tags in rendered Markdown (reading view, canvas cards) search for the tag, as in Obsidian.
	document.addEventListener('click', (evt) => {
		const tag = (evt.target as Element | null)?.closest?.('.markdown-rendered a.tag, .canvas-node a.tag');
		if (!tag) return;
		evt.preventDefault();
		void host.openSearch(`tag:${tag.textContent ?? ''}`);
	});

	ws.onLayoutReady(async () => {
		// Side panes, behind the file explorer and backlinks tabs.
		await ws.ensureSideLeaf(SEARCH_VIEW, 'left', { reveal: false });
		if (app.internalPlugins.getEnabledPluginById('bookmarks')) await ws.ensureSideLeaf(BOOKMARKS_VIEW, 'left', { reveal: false });
		await ws.ensureSideLeaf(OUTGOING_VIEW, 'right', { reveal: false });
		await ws.ensureSideLeaf(OUTLINE_VIEW, 'right', { reveal: false });
		await ws.ensureSideLeaf(TAGS_VIEW, 'right', { reveal: false });
		await ws.ensureSideLeaf(LOCAL_GRAPH_VIEW, 'right', { reveal: false });
	});
}

/** Shows the search pane, optionally with a query, and focuses it. */
export async function revealSearch(app: App, query: string): Promise<void> {
	const leaf = await app.workspace.ensureSideLeaf(SEARCH_VIEW, 'left', { reveal: true });
	const view = leaf.view;
	if (view instanceof SearchView) {
		if (query) view.setQuery(query);
		view.focus();
	}
}
