/**
 * The workspace: one root leaf for notes (the shell's editor, or a plugin
 * view), plus tabbed side docks for plugin views. Splits, tabs in the root
 * area and popout windows come later; `getLeaf()` always returns the root leaf.
 */

import { Events, TFile, getLinkpath, parseLinktext } from '@emeraldmd/core';
import type { Extension } from '@codemirror/state';
import type { App } from './app';
import { editorSuggestExtension, EditorSuggests } from './suggest';
import { setIcon } from './icons';
import type { Menu } from './menu';
import { setTooltip } from './tooltip';
import { debounce, type Debouncer } from './util';
import { EmptyView, MarkdownView, View } from './views';
import type { MarkdownFileInfo } from './editor';

export type PaneType = 'tab' | 'split' | 'window';
export type SplitDirection = 'vertical' | 'horizontal';
export type Side = 'left' | 'right';
export type ViewCreator = (leaf: WorkspaceLeaf) => View;

export interface ViewState {
	type: string;
	state?: Record<string, unknown>;
	active?: boolean;
	pinned?: boolean;
	group?: WorkspaceLeaf;
}

export interface OpenViewState {
	state?: Record<string, unknown>;
	eState?: Record<string, unknown>;
	active?: boolean;
	group?: WorkspaceLeaf;
}

/**
 * What the desktop shell (or a headless test) provides to the workspace.
 * The main area has one leaf per pane (tab group); `leaf` says which pane,
 * the current one when left out.
 */
export interface WorkspaceHost {
	/** Shows `file` in a pane's note editor. */
	openFile(file: TFile, leaf?: WorkspaceLeaf): Promise<void>;
	/** Saves pending changes in every note editor. */
	save(): Promise<void>;
	/** Applies plugin editor extensions to the note editors. */
	setEditorExtensions(extensions: Extension[]): void;
	/** Opens an empty tab in a pane and makes it current (for `getLeaf(true)`). */
	newTab?(leaf?: WorkspaceLeaf): void;
	/** Opens any file a view can show (notes, canvases…) in a pane's current tab; without it, only notes go through `openFile`. */
	openInTab?(file: TFile, leaf?: WorkspaceLeaf): Promise<void>;
	/** Closes a pane's current tab (`detach` on its leaf). */
	closeTab?(leaf?: WorkspaceLeaf): void;
	/** Splits the main area next to `leaf`'s pane; returns the new pane's leaf, made current. */
	split?(leaf: WorkspaceLeaf, direction: SplitDirection, before?: boolean): WorkspaceLeaf;
	/** A pane's leaf became the active leaf (`setActiveLeaf`). */
	activatePane?(leaf: WorkspaceLeaf): void;
	/** The layout in Obsidian's format (`main`, `left`, `right`, `active`), for `getLayout`. */
	getLayout?(): Record<string, unknown>;
	/** Shows a layout in Obsidian's format, for `changeLayout`. */
	changeLayout?(layout: unknown): Promise<void>;
}

const headlessHost = (workspace: Workspace): WorkspaceHost => ({
	async openFile(file, leaf) {
		const view = workspace.noteViews.get(leaf ?? workspace.rootLeaf);
		if (view) view.file = file;
		workspace.trigger('file-open', file);
	},
	async save() {},
	setEditorExtensions() {},
});

/** Registered view types and the file extensions they open (`app.viewRegistry`). */
export class ViewRegistry extends Events {
	viewByType: Record<string, ViewCreator> = {};
	typeByExtension: Record<string, string> = {};

	registerView(type: string, creator: ViewCreator): void {
		if (this.viewByType[type]) throw new Error(`Attempting to register an existing view type "${type}"`);
		this.viewByType[type] = creator;
		this.trigger('view-registered', type);
	}

	unregisterView(type: string): void {
		delete this.viewByType[type];
		this.trigger('view-unregistered', type);
	}

	registerExtensions(extensions: string[], type: string): void {
		for (const ext of extensions) {
			if (this.typeByExtension[ext]) throw new Error(`Attempting to register an existing file extension "${ext}"`);
			this.typeByExtension[ext] = type;
		}
		this.trigger('extensions-updated');
	}

	unregisterExtensions(extensions: string[]): void {
		for (const ext of extensions) delete this.typeByExtension[ext];
		this.trigger('extensions-updated');
	}

	isExtensionRegistered(extension: string): boolean {
		return extension in this.typeByExtension;
	}

	getTypeByExtension(extension: string): string | undefined {
		return this.typeByExtension[extension];
	}

	getViewCreatorByType(type: string): ViewCreator | undefined {
		return this.viewByType[type];
	}
}

let nextLeafId = 1;

export abstract class WorkspaceItem extends Events {
	abstract parent: WorkspaceParent | null;

	getRoot(): WorkspaceItem {
		let item: WorkspaceItem = this;
		while (item.parent) item = item.parent;
		return item;
	}

	getContainer(): WorkspaceItem {
		return this.getRoot();
	}
}

export abstract class WorkspaceParent extends WorkspaceItem {}

export class WorkspaceLeaf extends WorkspaceItem {
	id = String(nextLeafId++);
	app: App;
	parent: WorkspaceSidedock | WorkspaceRoot | null;
	view: View;
	containerEl: HTMLElement;
	hoverPopover: unknown = null;
	/** @internal */
	pinned = false;
	/** @internal */
	group: string | null = null;
	/** @internal Views the shell owns (the root editor) are hidden instead of unloaded when replaced. */
	persistentViews = new Set<View>();

	constructor(app: App, parent: WorkspaceSidedock | WorkspaceRoot | null) {
		super();
		this.app = app;
		this.parent = parent;
		this.containerEl = createDiv('workspace-leaf');
		this.view = new EmptyView(this);
		this.containerEl.appendChild(this.view.containerEl);
		this.view.containerEl.dataset.type = 'empty';
	}

	get isDeferred(): boolean {
		return false;
	}

	async loadIfDeferred(): Promise<void> {}

	async open(view: View): Promise<View> {
		const old = this.view;
		if (old !== view) {
			if (this.persistentViews.has(old)) old.containerEl.detach();
			else await closeView(old);
		}
		this.view = view;
		view.containerEl.dataset.type = view.getViewType();
		if (!view.containerEl.isConnected || view.containerEl.parentElement !== this.containerEl) {
			this.containerEl.appendChild(view.containerEl);
		}
		if (!view._loaded) {
			view.load();
			await view.open();
		}
		this.app.workspace.onLeafChanged(this);
		return view;
	}

	async openFile(file: TFile, openState?: OpenViewState): Promise<void> {
		await this.app.workspace.openFileInLeaf(this, file, openState);
	}

	getViewState(): ViewState {
		return { type: this.view.getViewType(), state: this.view.getState(), pinned: this.pinned };
	}

	async setViewState(viewState: ViewState, eState?: unknown): Promise<void> {
		const workspace = this.app.workspace;
		const noteView = workspace.noteViews.get(this);
		if (viewState.type === 'markdown' && noteView) {
			const path = viewState.state?.file;
			const file = typeof path === 'string' ? this.app.vault.getFileByPath(path) : null;
			if (file) await workspace.openFileInLeaf(this, file);
			else await this.open(noteView);
		} else if (viewState.type !== this.view.getViewType()) {
			const creator = this.app.viewRegistry.getViewCreatorByType(viewState.type);
			await this.open(creator ? creator(this) : new EmptyView(this));
		}
		if (viewState.state) await this.view.setState(viewState.state, { history: false });
		if (eState !== undefined) this.view.setEphemeralState(eState);
		if (viewState.pinned !== undefined) this.setPinned(viewState.pinned);
		if (viewState.active) workspace.setActiveLeaf(this, { focus: true });
		this.parent?.onLeafUpdated?.(this);
		workspace.requestLayoutChange();
	}

	getEphemeralState(): unknown {
		return this.view.getEphemeralState();
	}

	setEphemeralState(state: unknown): void {
		this.view.setEphemeralState(state);
	}

	togglePinned(): void {
		this.setPinned(!this.pinned);
	}

	setPinned(pinned: boolean): void {
		this.pinned = pinned;
		this.trigger('pinned-change', pinned);
	}

	setGroupMember(other: WorkspaceLeaf): void {
		this.setGroup(other.group ?? other.id);
	}

	setGroup(group: string): void {
		this.group = group;
		this.trigger('group-change', group);
	}

	detach(): void {
		const workspace = this.app.workspace;
		const noteView = workspace.noteViews.get(this);
		if (noteView) {
			// A pane's leaf stays: with tabs, detaching it closes the pane's current tab; else it shows the note editor again.
			if (workspace.host.closeTab) workspace.host.closeTab(this);
			else if (this.view !== noteView) void this.open(noteView);
			return;
		}
		void closeView(this.view);
		this.parent?.removeLeaf?.(this);
		this.containerEl.detach();
		workspace.forgetLeaf(this);
	}

	getIcon(): string {
		return this.view.getIcon();
	}

	getDisplayText(): string {
		return this.view.getDisplayText();
	}

	onResize(): void {
		this.view.onResize();
	}
}

async function closeView(view: View): Promise<void> {
	try {
		await view.close();
	} catch (err) {
		console.error(err);
	}
	view.unload();
	view.containerEl.detach();
}

/** The main area. Holds the single root leaf. */
export class WorkspaceRoot extends WorkspaceParent {
	parent = null;
	containerEl: HTMLElement;
	win: Window = window;
	doc: Document = document;

	constructor(containerEl: HTMLElement) {
		super();
		this.containerEl = containerEl;
	}

	onLeafUpdated?(leaf: WorkspaceLeaf): void;
	removeLeaf?(leaf: WorkspaceLeaf): void;
}

interface DockTab {
	id: string;
	title: string;
	icon: string;
	contentEl: HTMLElement;
	headerEl: HTMLElement;
	leaf?: WorkspaceLeaf;
}

/** A side panel with tabs: built-in panes (files, backlinks) and plugin leaves. */
export class WorkspaceSidedock extends WorkspaceParent {
	parent = null;
	containerEl: HTMLElement;
	collapsed = false;
	/** @internal */
	readonly side: Side;
	private readonly app: App;
	private readonly headerEl: HTMLElement;
	private readonly tabsEl: HTMLElement;
	private tabs: DockTab[] = [];
	private active: DockTab | null = null;

	constructor(app: App, side: Side, containerEl: HTMLElement = createDiv()) {
		super();
		this.app = app;
		this.side = side;
		this.containerEl = containerEl;
		this.containerEl.addClass('workspace-sidedock', `mod-${side}`);
		this.headerEl = this.containerEl.createDiv({ cls: 'workspace-tab-header-container', attr: { 'data-tauri-drag-region': '' } });
		this.tabsEl = this.containerEl.createDiv('workspace-tab-container');
		this.updateHeader();
	}

	/** @internal A built-in pane, shown as the first tabs. */
	addStaticTab(id: string, title: string, icon: string, contentEl: HTMLElement): void {
		this.addTab({ id, title, icon, contentEl, headerEl: createDiv() });
	}

	/** @internal */
	createLeaf(): WorkspaceLeaf {
		const leaf = new WorkspaceLeaf(this.app, this);
		this.addTab({ id: `leaf-${leaf.id}`, title: '', icon: '', contentEl: leaf.containerEl, headerEl: createDiv(), leaf });
		return leaf;
	}

	get leaves(): WorkspaceLeaf[] {
		return this.tabs.flatMap((t) => (t.leaf ? [t.leaf] : []));
	}

	/** @internal */
	onLeafUpdated(leaf: WorkspaceLeaf): void {
		const tab = this.tabs.find((t) => t.leaf === leaf);
		if (!tab) return;
		tab.title = leaf.getDisplayText();
		tab.icon = leaf.getIcon() || 'file';
		this.renderTabHeader(tab);
		this.updateHeader();
	}

	/** @internal */
	removeLeaf(leaf: WorkspaceLeaf): void {
		const tab = this.tabs.find((t) => t.leaf === leaf);
		if (!tab) return;
		this.tabs = this.tabs.filter((t) => t !== tab);
		tab.headerEl.detach();
		tab.contentEl.detach();
		if (this.active === tab) this.activate(this.tabs[0] ?? null);
		this.updateHeader();
	}

	/** @internal Shows the tab holding `leaf`. */
	reveal(leaf: WorkspaceLeaf): void {
		const tab = this.tabs.find((t) => t.leaf === leaf);
		if (tab) this.activate(tab);
		this.expand();
	}

	/** @internal */
	isActiveLeaf(leaf: WorkspaceLeaf): boolean {
		return this.active?.leaf === leaf;
	}

	collapse(): void {
		this.collapsed = true;
		this.containerEl.addClass('is-collapsed');
	}

	expand(): void {
		this.collapsed = false;
		this.containerEl.removeClass('is-collapsed');
	}

	toggle(): void {
		if (this.collapsed) this.expand();
		else this.collapse();
	}

	private addTab(tab: DockTab): void {
		this.tabs.push(tab);
		tab.headerEl.className = 'workspace-tab-header clickable-icon';
		tab.headerEl.addEventListener('click', () => this.activate(tab));
		this.renderTabHeader(tab);
		this.headerEl.appendChild(tab.headerEl);
		tab.contentEl.addClass('workspace-tab-content');
		tab.contentEl.hide();
		this.tabsEl.appendChild(tab.contentEl);
		if (!this.active) this.activate(tab);
		this.updateHeader();
	}

	private renderTabHeader(tab: DockTab): void {
		setIcon(tab.headerEl, tab.icon || 'file');
		setTooltip(tab.headerEl, tab.title);
		tab.headerEl.setAttribute('aria-label', tab.title);
	}

	private activate(tab: DockTab | null): void {
		if (this.active) {
			this.active.contentEl.hide();
			this.active.headerEl.removeClass('is-active');
		}
		this.active = tab;
		if (!tab) return;
		tab.contentEl.show();
		tab.headerEl.addClass('is-active');
		tab.leaf?.onResize();
	}

	private updateHeader(): void {
		this.headerEl.toggle(this.tabs.length > 1);
	}
}

/** A ribbon button, as listed in `leftRibbon.items` (read by plugins that reorder or hide ribbon icons). */
export interface RibbonItem {
	id: string;
	icon: string;
	title: string;
	callback: (evt: MouseEvent) => unknown;
	buttonEl: HTMLElement;
	hidden: boolean;
}

/** The left ribbon of icon buttons (`.side-dock-ribbon`). */
export class WorkspaceRibbon {
	containerEl: HTMLElement;
	/** @internal */
	actionsEl: HTMLElement;
	/** @internal */
	items: RibbonItem[] = [];

	constructor(containerEl: HTMLElement = createDiv()) {
		this.containerEl = containerEl;
		this.containerEl.addClass('workspace-ribbon', 'side-dock-ribbon', 'mod-left');
		this.actionsEl = this.containerEl.createDiv('side-dock-actions');
	}

	/** @internal The element holding the buttons. */
	get ribbonItemsEl(): HTMLElement {
		return this.actionsEl;
	}

	/** @internal Removes a button added with `addRibbonItemButton`. */
	removeRibbonItem(buttonEl: HTMLElement): void {
		this.items = this.items.filter((item) => item.buttonEl !== buttonEl);
		buttonEl.detach();
	}

	/** @internal Used by `Plugin.addRibbonIcon`. */
	addRibbonItemButton(id: string, icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
		const el = this.actionsEl.createDiv({ cls: 'clickable-icon side-dock-ribbon-action', attr: { 'aria-label': title, 'data-id': id } });
		this.items.push({ id, icon, title, callback, buttonEl: el, hidden: false });
		setIcon(el, icon);
		setTooltip(el, title, { placement: 'right' });
		el.addEventListener('click', (evt) => {
			try {
				const result = callback(evt);
				if (result instanceof Promise) result.catch((err: unknown) => console.error(err));
			} catch (err) {
				console.error(err);
			}
		});
		return el;
	}
}

export class Workspace extends Events {
	leftSplit: WorkspaceSidedock;
	rightSplit: WorkspaceSidedock;
	leftRibbon: WorkspaceRibbon;
	/** @deprecated No longer used. */
	rightRibbon: WorkspaceRibbon;
	rootSplit: WorkspaceRoot;
	activeLeaf: WorkspaceLeaf | null;
	containerEl: HTMLElement;
	layoutReady = false;
	requestSaveLayout: Debouncer<[], Promise<void>>;
	/** @internal The pane leaf used last: where files open, and what commands act on. */
	rootLeaf: WorkspaceLeaf;
	/** @internal The main area's leaves, one per pane (tab group), in layout order. */
	rootLeaves: WorkspaceLeaf[];
	/** @internal Each pane leaf's note view (the shell's editor). */
	readonly noteViews = new Map<WorkspaceLeaf, MarkdownView>();
	/** @internal */
	host: WorkspaceHost;
	/** @internal */
	editorSuggest = new EditorSuggests();
	/** @internal */
	hoverLinkSources: Record<string, { display: string; defaultMod: boolean }> = {};
	private readonly app: App;
	private readonly layoutReadyCallbacks: (() => unknown)[] = [];
	private readonly editorExtensions: Extension[] = [];
	private readonly lastOpenFiles: string[] = [];
	private readonly extraLeaves = new Set<WorkspaceLeaf>();
	private readonly requestLayoutChangeDebounced: Debouncer<[], void>;

	constructor(app: App, containerEl: HTMLElement = createDiv()) {
		super();
		this.app = app;
		this.containerEl = containerEl;
		this.containerEl.addClass('workspace');
		this.host = headlessHost(this);
		this.rootSplit = new WorkspaceRoot(createDiv('workspace-split mod-root'));
		this.rootLeaf = new WorkspaceLeaf(app, this.rootSplit);
		this.rootLeaves = [this.rootLeaf];
		this.rootSplit.containerEl.appendChild(this.rootLeaf.containerEl);
		this.activeLeaf = this.rootLeaf;
		this.leftSplit = new WorkspaceSidedock(app, 'left');
		this.rightSplit = new WorkspaceSidedock(app, 'right');
		this.leftRibbon = new WorkspaceRibbon();
		this.rightRibbon = new WorkspaceRibbon(createDiv());
		this.requestSaveLayout = debounce(async () => {}, 2000);
		this.requestLayoutChangeDebounced = debounce(() => this.trigger('layout-change'), 0);
	}

	/** @internal Connects the shell, with the first pane's note view. */
	setHost(host: WorkspaceHost, markdownView: MarkdownView): void {
		this.host = host;
		this.addRootLeaf(this.rootLeaf, markdownView);
		this.updateOptions();
	}

	/** @internal The current pane's note view. */
	get markdownView(): MarkdownView | null {
		return this.noteViews.get(this.rootLeaf) ?? null;
	}

	/** @internal A new leaf for a pane of the main area (the shell gives it a note view with `addRootLeaf`). */
	createRootLeaf(): WorkspaceLeaf {
		return new WorkspaceLeaf(this.app, this.rootSplit);
	}

	/** @internal Registers a pane's leaf and its note view, at `index` in layout order. */
	addRootLeaf(leaf: WorkspaceLeaf, view: MarkdownView, index = this.rootLeaves.length): void {
		this.noteViews.set(leaf, view);
		leaf.persistentViews.add(view);
		if (!this.rootLeaves.includes(leaf)) this.rootLeaves.splice(index, 0, leaf);
		void leaf.open(view);
	}

	/** @internal A pane was closed: its views close too. */
	removeRootLeaf(leaf: WorkspaceLeaf): void {
		const view = leaf.view;
		const noteView = this.noteViews.get(leaf);
		if (view !== noteView) void closeView(view);
		if (noteView) void closeView(noteView);
		this.noteViews.delete(leaf);
		this.rootLeaves = this.rootLeaves.filter((l) => l !== leaf);
		if (this.rootLeaf === leaf && this.rootLeaves[0]) this.rootLeaf = this.rootLeaves[0];
		if (this.activeLeaf === leaf) this.setActiveLeaf(this.rootLeaf);
		leaf.containerEl.detach();
		this.requestLayoutChange();
	}

	get activeEditor(): MarkdownFileInfo | null {
		const view = this.rootLeaf.view;
		return view instanceof MarkdownView && view.file && view.editor ? view : null;
	}

	onLayoutReady(callback: () => unknown): void {
		if (this.layoutReady) runSafely(callback);
		else this.layoutReadyCallbacks.push(callback);
	}

	/** @internal Called once the shell has opened the vault and loaded plugins. */
	setLayoutReady(): void {
		if (this.layoutReady) return;
		this.layoutReady = true;
		for (const cb of this.layoutReadyCallbacks.splice(0)) runSafely(cb);
		this.trigger('layout-ready');
		this.trigger('layout-change');
	}

	/** Shows a layout as `getLayout` returns it (Obsidian's `workspace.json` format). */
	async changeLayout(workspace: unknown): Promise<void> {
		await this.host.changeLayout?.(workspace);
	}

	/** The layout in Obsidian's `workspace.json` format: `main` (splits, tab groups, leaves), `left`, `right`, `active`. */
	getLayout(): Record<string, unknown> {
		if (this.host.getLayout) return this.host.getLayout();
		return {};
	}

	createLeafInParent(_parent: unknown, _index: number): WorkspaceLeaf {
		return this.getLeaf();
	}

	createLeafBySplit(leaf: WorkspaceLeaf, direction: SplitDirection = 'vertical', before?: boolean): WorkspaceLeaf {
		const pane = this.rootLeaves.includes(leaf) ? leaf : this.rootLeaf;
		return this.host.split?.(pane, direction, before) ?? this.getLeaf(true);
	}

	splitActiveLeaf(direction: SplitDirection = 'vertical'): WorkspaceLeaf {
		return this.createLeafBySplit(this.rootLeaf, direction);
	}

	async duplicateLeaf(leaf: WorkspaceLeaf): Promise<WorkspaceLeaf> {
		return leaf;
	}

	getUnpinnedLeaf(): WorkspaceLeaf {
		return this.rootLeaf;
	}

	/**
	 * The current pane's leaf. Asked for a new leaf, the app first opens a new
	 * tab there (`true`, `'tab'`, `'window'`: there are no popout windows), or
	 * a new pane next to it (`'split'`), so the file opened next goes there.
	 */
	getLeaf(newLeaf?: PaneType | boolean | 'split', direction: SplitDirection = 'vertical'): WorkspaceLeaf {
		if (newLeaf === 'split') return this.createLeafBySplit(this.rootLeaf, direction);
		if (newLeaf) this.host.newTab?.(this.rootLeaf);
		return this.rootLeaf;
	}

	moveLeafToPopout(leaf: WorkspaceLeaf): WorkspaceLeaf {
		return leaf;
	}

	openPopoutLeaf(): WorkspaceLeaf {
		return this.rootLeaf;
	}

	async openLinkText(linktext: string, sourcePath: string, newLeaf?: PaneType | boolean, openViewState?: OpenViewState): Promise<void> {
		const { path } = parseLinktext(linktext);
		let file = path ? this.app.metadataCache.getFirstLinkpathDest(getLinkpath(linktext), sourcePath) : this.app.vault.getFileByPath(sourcePath);
		if (!file) {
			const target = path.toLowerCase().endsWith('.md') ? path : `${path}.md`;
			const folder = this.app.fileManager.getNewFileParent(sourcePath);
			file = await this.app.vault.create(folder.isRoot() ? target : `${folder.path}/${target}`, '');
		}
		await this.getLeaf(newLeaf).openFile(file, openViewState);
	}

	setActiveLeaf(leaf: WorkspaceLeaf, params?: { focus?: boolean } | boolean, _focus?: boolean): void {
		if (this.activeLeaf === leaf) return;
		this.activeLeaf = leaf;
		if (this.rootLeaves.includes(leaf) && this.rootLeaf !== leaf) {
			this.rootLeaf = leaf;
			this.host.activatePane?.(leaf);
		}
		this.trigger('active-leaf-change', leaf);
		const focus = typeof params === 'object' ? params.focus : _focus;
		if (focus && leaf.view instanceof MarkdownView) leaf.view.editor?.focus();
	}

	getLeafById(id: string): WorkspaceLeaf | null {
		return this.allLeaves().find((l) => l.id === id) ?? null;
	}

	getGroupLeaves(group: string): WorkspaceLeaf[] {
		return this.allLeaves().filter((l) => l.group === group);
	}

	getMostRecentLeaf(): WorkspaceLeaf | null {
		return this.rootLeaf;
	}

	getLeftLeaf(_split: boolean): WorkspaceLeaf | null {
		return this.createSideLeaf(this.leftSplit);
	}

	getRightLeaf(_split: boolean): WorkspaceLeaf | null {
		return this.createSideLeaf(this.rightSplit);
	}

	async ensureSideLeaf(
		type: string,
		side: Side,
		options: { active?: boolean; split?: boolean; reveal?: boolean; state?: Record<string, unknown> } = {},
	): Promise<WorkspaceLeaf> {
		let leaf = this.getLeavesOfType(type)[0];
		if (!leaf) {
			leaf = this.createSideLeaf(side === 'left' ? this.leftSplit : this.rightSplit);
			await leaf.setViewState({ type, state: options.state, active: options.active });
		}
		if (options.reveal !== false) await this.revealLeaf(leaf);
		return leaf;
	}

	getActiveViewOfType<T extends View>(type: abstract new (...args: never[]) => T): T | null {
		const view = this.activeLeaf?.view;
		if (view instanceof type) return view;
		// Commands run from the palette or a ribbon still target the note editor.
		const root = this.rootLeaf.view;
		return root instanceof type ? root : null;
	}

	getActiveFile(): TFile | null {
		const view = this.activeLeaf?.view as { file?: unknown } | undefined;
		if (view?.file instanceof TFile) return view.file;
		return this.activeEditor?.file ?? null;
	}

	iterateRootLeaves(callback: (leaf: WorkspaceLeaf) => unknown): void {
		for (const leaf of [...this.rootLeaves]) callback(leaf);
	}

	/** CodeMirror 5 editors (legacy). EmeraldMD has none. */
	iterateCodeMirrors(_callback: (cm: unknown) => unknown): void {}

	iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => unknown): void {
		for (const leaf of this.allLeaves()) callback(leaf);
	}

	getLeavesOfType(viewType: string): WorkspaceLeaf[] {
		return this.allLeaves().filter((leaf) => leaf.view.getViewType() === viewType);
	}

	detachLeavesOfType(viewType: string): void {
		for (const leaf of this.getLeavesOfType(viewType)) leaf.detach();
	}

	async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
		if (leaf.parent instanceof WorkspaceSidedock) leaf.parent.reveal(leaf);
	}

	getLastOpenFiles(): string[] {
		return [...this.lastOpenFiles];
	}

	/** Re-applies the editor extensions registered by plugins (after a plugin changed its extension array). */
	updateOptions(): void {
		this.host.setEditorExtensions([editorSuggestExtension(this.editorSuggest), ...this.editorExtensions]);
	}

	/** @internal */
	registerEditorExtension(extension: Extension): void {
		this.editorExtensions.push(extension);
		this.updateOptions();
	}

	/** @internal */
	unregisterEditorExtension(extension: Extension): void {
		const i = this.editorExtensions.indexOf(extension);
		if (i !== -1) this.editorExtensions.splice(i, 1);
		this.updateOptions();
	}

	/** @internal */
	registerHoverLinkSource(id: string, info: { display: string; defaultMod: boolean }): void {
		this.hoverLinkSources[id] = info;
	}

	/** @internal */
	unregisterHoverLinkSource(id: string): void {
		delete this.hoverLinkSources[id];
	}

	handleLinkContextMenu(_menu: Menu, _linktext: string, _sourcePath: string): boolean {
		return false;
	}

	/** @internal */
	async openFileInLeaf(leaf: WorkspaceLeaf, file: TFile, openState?: OpenViewState): Promise<void> {
		const type = file.extension === 'md' ? 'markdown' : this.app.viewRegistry.getTypeByExtension(file.extension);
		const noteView = this.noteViews.get(leaf);
		if (type && noteView && this.host.openInTab) {
			await this.host.openInTab(file, leaf);
		} else if (type === 'markdown' && noteView) {
			await leaf.open(noteView);
			await this.host.openFile(file, leaf);
		} else if (type) {
			await leaf.setViewState({ type, state: { ...(openState?.state ?? {}), file: file.path }, active: openState?.active });
		} else {
			throw new Error(`No view can open ${file.path}`);
		}
		this.recordOpenFile(file);
		if (openState?.eState) leaf.setEphemeralState(openState.eState);
	}

	/** @internal Called by the shell after it opened a file in the root leaf. */
	recordOpenFile(file: TFile): void {
		const i = this.lastOpenFiles.indexOf(file.path);
		if (i !== -1) this.lastOpenFiles.splice(i, 1);
		this.lastOpenFiles.unshift(file.path);
		this.lastOpenFiles.length = Math.min(this.lastOpenFiles.length, 10);
	}

	/** @internal */
	onLeafChanged(leaf: WorkspaceLeaf): void {
		leaf.parent?.onLeafUpdated?.(leaf);
		this.requestLayoutChange();
	}

	/** @internal */
	requestLayoutChange(): void {
		if (this.layoutReady) this.requestLayoutChangeDebounced();
	}

	/** @internal */
	forgetLeaf(leaf: WorkspaceLeaf): void {
		this.extraLeaves.delete(leaf);
		if (this.activeLeaf === leaf) this.setActiveLeaf(this.rootLeaf);
		this.requestLayoutChange();
	}

	private createSideLeaf(dock: WorkspaceSidedock): WorkspaceLeaf {
		const leaf = dock.createLeaf();
		this.extraLeaves.add(leaf);
		return leaf;
	}

	private allLeaves(): WorkspaceLeaf[] {
		return [...this.rootLeaves, ...this.leftSplit.leaves, ...this.rightSplit.leaves];
	}
}

function runSafely(cb: () => unknown): void {
	try {
		const result = cb();
		if (result instanceof Promise) result.catch((err: unknown) => console.error(err));
	} catch (err) {
		console.error(err);
	}
}
