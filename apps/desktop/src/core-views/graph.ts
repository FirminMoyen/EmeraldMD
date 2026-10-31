/** Graph view (main area) and local graph (right sidebar), on @emeraldmd/graph. */

import { debounce, ItemView, type WorkspaceLeaf } from '@emeraldmd/api';
import { buildGraph, GraphView, graphInputFromVault, type GraphFilters, type GraphNode } from '@emeraldmd/graph';
import { cssColor, DEFAULT_GRAPH_SETTINGS, DEFAULT_LOCAL_SETTINGS, displayOf, forcesOf, GraphControls, graphSettingsSaver, loadGraphSettings, type GraphChange, type GraphSettings } from './graph-settings';
import type { CoreViewHost } from './host';

export const GRAPH_VIEW = 'graph';
export const LOCAL_GRAPH_VIEW = 'localgraph';

abstract class BaseGraphView extends ItemView {
	protected graph: GraphView | null = null;
	protected readonly refresh = debounce(() => this.redraw(), 300, true);

	constructor(
		leaf: WorkspaceLeaf,
		protected readonly host: CoreViewHost,
	) {
		super(leaf);
	}

	protected abstract filters(): GraphFilters;

	protected override async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('graph-view-container');
		this.graph = new GraphView(this.contentEl, { onOpen: (node) => void this.openNode(node) });
		this.registerEvent(this.app.metadataCache.on('resolved', () => this.refresh()));
		this.registerEvent(this.app.vault.on('rename', () => this.refresh()));
		this.registerEvent(this.app.vault.on('delete', () => this.refresh()));
		this.redraw();
	}

	protected override async onClose(): Promise<void> {
		this.graph?.destroy();
		this.graph = null;
	}

	protected redraw(): void {
		if (!this.graph) return;
		this.graph.setData(buildGraph(graphInputFromVault(this.app.vault, this.app.metadataCache), this.filters()));
		this.graph.setFocused(this.app.workspace.getActiveFile()?.path ?? null);
	}

	private async openNode(node: GraphNode): Promise<void> {
		if (node.kind === 'tag') return this.host.openSearch(`tag:${node.id}`);
		if (node.kind === 'unresolved') return this.app.workspace.openLinkText(node.id, '');
		const file = this.app.vault.getFileByPath(node.id);
		if (file) await this.host.openFile(file);
	}
}

/** A graph with the settings panel: filters, colour groups (by search query), display and forces. */
abstract class SettingsGraphView extends BaseGraphView {
	protected settings: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS, colorGroups: [] };
	private controls: GraphControls | null = null;
	/** Notes found by the filter's search (null: no search), and each colour group's notes. */
	protected searchResults: Set<string> | null = null;
	private groupColors = new Map<string, string>();
	private queryRun = 0;
	/** The local graph adds its own section to the panel. */
	protected readonly local: boolean = false;

	protected abstract loadSettings(): Promise<GraphSettings>;
	protected abstract saveSettings(settings: GraphSettings): void;

	protected override async onOpen(): Promise<void> {
		this.addAction('maximize', 'Zoom to fit', () => this.graph?.zoomToFit());
		this.settings = await this.loadSettings();
		await super.onOpen();
		this.graph?.setForces(forcesOf(this.settings));
		this.graph?.setDisplay(displayOf(this.settings));
		this.graph?.setNodeColor((node) => (node.kind === 'note' ? (this.groupColors.get(node.id) ?? null) : null));
		this.controls = new GraphControls(this.contentEl, this.settings, (change) => this.onSettingsChange(change), this.local);
		// Searches and colour groups follow the notes as they change.
		const rerun = debounce(() => void this.runQueries(), 500, true);
		this.registerEvent(
			this.app.metadataCache.on('resolved', () => {
				if (this.settings.search.trim() || this.settings.colorGroups.some((g) => g.query.trim())) rerun();
			}),
		);
		void this.runQueries();
	}

	private onSettingsChange(change: GraphChange): void {
		this.saveSettings(this.settings);
		if (change === 'display') this.graph?.setDisplay(displayOf(this.settings));
		else if (change === 'forces') this.graph?.setForces(forcesOf(this.settings));
		else if (change === 'filter' || change === 'groups') void this.runQueries();
		else if (change === 'local') this.redraw();
	}

	/** The panel's filters, for `buildGraph`. */
	protected panelFilters(): GraphFilters {
		const s = this.settings;
		return { showTags: s.showTags, showAttachments: s.showAttachments, showOrphans: s.showOrphans, showUnresolved: !s.hideUnresolved, ...(this.searchResults ? { files: this.searchResults } : {}) };
	}

	/** Runs the filter's search and the colour groups' queries (Obsidian's search syntax), then redraws. */
	private async runQueries(): Promise<void> {
		const run = ++this.queryRun;
		const search = this.host.search;
		const notes = async (query: string): Promise<Set<string> | null> => {
			if (!query.trim()) return null;
			if (!search) return new Set(this.app.vault.getMarkdownFiles().filter((f) => f.path.toLowerCase().includes(query.trim().toLowerCase())).map((f) => f.path));
			try {
				return new Set((await search(query, { limit: 100_000 })).files.map((f) => f.path));
			} catch {
				// A query being typed may not parse yet.
				return new Set();
			}
		};
		const found = await notes(this.settings.search);
		const colors = new Map<string, string>();
		for (const group of this.settings.colorGroups) {
			const members = await notes(group.query);
			for (const path of members ?? []) if (!colors.has(path)) colors.set(path, cssColor(group.color));
		}
		if (run !== this.queryRun) return;
		this.searchResults = found;
		this.groupColors = colors;
		this.redraw();
	}
}

/** The whole vault (main area); its settings are the vault's `.obsidian/graph.json`. */
export class GlobalGraphView extends SettingsGraphView {
	private save: (settings: GraphSettings) => void = () => {};

	constructor(leaf: WorkspaceLeaf, host: CoreViewHost) {
		super(leaf, host);
		this.icon = 'git-fork';
		this.navigation = true;
	}

	getViewType(): string {
		return GRAPH_VIEW;
	}

	getDisplayText(): string {
		return 'Graph view';
	}

	protected async loadSettings(): Promise<GraphSettings> {
		this.save = graphSettingsSaver(this.app);
		return loadGraphSettings(this.app);
	}

	protected saveSettings(settings: GraphSettings): void {
		this.save(settings);
	}

	protected filters(): GraphFilters {
		return this.panelFilters();
	}
}

/** Where this device keeps the local graph's settings, per vault. */
const LOCAL_SETTINGS_KEY = 'emerald-local-graph';

/** The neighbourhood of the active note (right sidebar), with Obsidian's local graph settings. */
export class LocalGraphView extends SettingsGraphView {
	protected override readonly local = true;

	constructor(leaf: WorkspaceLeaf, host: CoreViewHost) {
		super(leaf, host);
		this.icon = 'git-fork';
	}

	getViewType(): string {
		return LOCAL_GRAPH_VIEW;
	}

	getDisplayText(): string {
		return 'Local graph';
	}

	protected override async onOpen(): Promise<void> {
		await super.onOpen();
		this.registerEvent(this.app.workspace.on('file-open', () => this.refresh()));
	}

	protected async loadSettings(): Promise<GraphSettings> {
		const saved = this.app.loadLocalStorage(LOCAL_SETTINGS_KEY) as Partial<GraphSettings> | null;
		return { ...DEFAULT_GRAPH_SETTINGS, ...DEFAULT_LOCAL_SETTINGS, colorGroups: [], ...(saved && typeof saved === 'object' ? saved : {}) };
	}

	protected saveSettings(settings: GraphSettings): void {
		this.app.saveLocalStorage(LOCAL_SETTINGS_KEY, settings);
	}

	protected filters(): GraphFilters {
		const center = this.app.workspace.getActiveFile()?.path;
		if (!center) return { search: '\u0000' };
		const s = this.settings;
		return {
			...this.panelFilters(),
			local: { center, depth: s.localJumps ?? 1, incoming: s.localBacklinks !== false, outgoing: s.localForelinks !== false, neighbors: s.localInterlinks === true },
		};
	}
}
