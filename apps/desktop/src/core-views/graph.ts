/** Graph view (main area) and local graph (right sidebar), on @emeraldmd/graph. */

import { debounce, ItemView, type WorkspaceLeaf } from '@emeraldmd/api';
import { buildGraph, GraphView, graphInputFromVault, type GraphFilters, type GraphNode } from '@emeraldmd/graph';
import type { CoreViewHost } from './host';

export const GRAPH_VIEW = 'graph';
export const LOCAL_GRAPH_VIEW = 'localgraph';

abstract class BaseGraphView extends ItemView {
	protected graph: GraphView | null = null;
	protected readonly refresh = debounce(() => this.redraw(), 300, true);
	private fitted = false;

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
		if (!this.fitted) {
			this.fitted = true;
			setTimeout(() => this.graph?.zoomToFit(), 1200);
		}
	}

	private async openNode(node: GraphNode): Promise<void> {
		if (node.kind === 'tag') return this.host.openSearch(`tag:${node.id}`);
		if (node.kind === 'unresolved') return this.app.workspace.openLinkText(node.id, '');
		const file = this.app.vault.getFileByPath(node.id);
		if (file) await this.host.openFile(file);
	}
}

export class GlobalGraphView extends BaseGraphView {
	private showTags = false;
	private showAttachments = false;
	private showOrphans = true;

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

	protected override async onOpen(): Promise<void> {
		const toggle = (icon: string, title: string, get: () => boolean, set: (v: boolean) => void) => {
			const button = this.addAction(icon, title, () => {
				set(!get());
				button.toggleClass('is-active', get());
				this.redraw();
			});
			button.toggleClass('is-active', get());
		};
		toggle('tags', 'Show tags', () => this.showTags, (v) => (this.showTags = v));
		toggle('paperclip', 'Show attachments', () => this.showAttachments, (v) => (this.showAttachments = v));
		toggle('circle-dot', 'Show orphans', () => this.showOrphans, (v) => (this.showOrphans = v));
		this.addAction('maximize', 'Zoom to fit', () => this.graph?.zoomToFit());
		await super.onOpen();
	}

	protected filters(): GraphFilters {
		return { showTags: this.showTags, showAttachments: this.showAttachments, showOrphans: this.showOrphans, showUnresolved: true };
	}
}

/** The neighbourhood of the active note, two links deep. */
export class LocalGraphView extends BaseGraphView {
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

	protected filters(): GraphFilters {
		const center = this.app.workspace.getActiveFile()?.path;
		return center ? { local: { center, depth: 2 }, showUnresolved: true } : { search: '\u0000' };
	}
}
