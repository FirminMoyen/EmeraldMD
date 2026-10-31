/**
 * A pane of the main area: a tab group with its own note view and editor.
 * Several panes side by side are splits (see splits.ts). Each tab keeps its
 * note's editor state while another shows (tabs.ts); the pane saves its note
 * (autosave, and before another note shows).
 *
 * DOM: `.workspace-tabs(.mod-active) > .workspace-tab-header-container +
 * .workspace-tab-container > .workspace-leaf`, as themes expect.
 */

import {
	CodeMirrorEditor,
	Component,
	editorInfoExtensions,
	hasCodeBlockProcessor,
	MarkdownRenderer,
	MarkdownView,
	PropertiesEditor,
	isPropertiesYaml,
	Menu,
	onCodeBlockProcessorsChanged,
	setIcon,
	setLivePreviewEffect,
	setTooltip,
	type App,
	type MarkdownViewModeType,
	type WorkspaceLeaf,
} from '@emeraldmd/api';
import { getLinkpath, TFile, type TAbstractFile } from '@emeraldmd/core';
import { frontmatterAt, MarkdownEditor } from '@emeraldmd/editor';
import type { Extension } from '@codemirror/state';
import { draggedTab, emptyTab, isEmptyTab, TabBar, type Tab } from './tabs';

/** Same autosave delay as Obsidian. */
const SAVE_DELAY_MS = 2000;
/** How many notes back/forward remembers. */
const HISTORY_LIMIT = 50;

/** A pane's tabs as they are saved: each tab's note and mode, and which one is current. */
export interface SavedTabs {
	tabs: { file: string | null; mode: MarkdownViewModeType; pinned?: boolean }[];
	active: number;
}

/** What a pane needs from the app. */
export interface PaneHost {
	readonly app: App;
	/** The vault can only be read (a server vault opened with a read-only token). */
	readOnly?(): boolean;
	notice(message: string, duration?: number): void;
	/**
	 * Saves `text` to `file` after the saves already queued (of every pane),
	 * so a note is never read back mid-save. False if it failed: the app keeps
	 * the text and saves it again later (see `unsavedText`).
	 */
	saveText(file: TFile, text: string): Promise<boolean>;
	/** Resolves once every queued save has finished. */
	saved(): Promise<void>;
	/** Text of `file` whose save failed (the server was unreachable…), still to be saved; it is newer than the file. */
	unsavedText(file: TFile): string | undefined;
	/** Makes this pane the current one (a click or the focus inside it). */
	activate(pane: NotePane): void;
	/** Whether this pane is the current one. */
	isCurrent(pane: NotePane): boolean;
	/** Tabs, notes or modes changed: the layout is saved for next time. */
	saveLayout(): void;
	/** The pane shows another note (or none): file tree, side panels, window title. */
	shown(pane: NotePane): void;
	/** The pane's status changed (saving, unsaved edits). */
	statusChanged(pane: NotePane): void;
	/** A tab was closed, for "Undo close tab". */
	closed(pane: NotePane, tab: Tab, index: number): void;
	/** The pane's last tab was closed: true if the app removed the pane (another one is left). */
	removeIfEmpty(pane: NotePane): boolean;
	nextTabClock(): number;
	openExternal(url: string): Promise<void>;
	trash(file: TAbstractFile): Promise<void>;
	propertiesInDocument(): 'visible' | 'hidden' | 'source';
	/** The editor extensions plugins registered. */
	editorExtensions(): Extension[];
	/** The context menu of a tab's header. */
	tabMenu(pane: NotePane, tab: Tab, event: MouseEvent): void;
	/** A tab dragged from the bar `from` was dropped on `to`, at `index` among its tabs. */
	moveTab(tab: Tab, from: TabBar, to: NotePane, index: number): void;
	/** A tab dragged from the bar `from` was dropped on an edge of `target`: a new pane there gets it. */
	splitWithTab(tab: Tab, from: TabBar, target: NotePane, direction: 'vertical' | 'horizontal', before: boolean): void;
}

type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

/** The note view's parts, taken from the page for the first pane and made for the others. */
export interface PaneParts {
	title: HTMLInputElement;
	trash: HTMLElement;
	editor: HTMLElement;
	noFile: HTMLElement;
}

function makeParts(): PaneParts {
	const title = createEl('input', { cls: 'view-header-title', attr: { spellcheck: 'false', 'aria-label': 'Note name' } });
	const trash = createEl('button', { cls: 'clickable-icon view-action', attr: { 'aria-label': 'Move to trash', title: 'Move to trash' } });
	setIcon(trash, 'trash-2');
	const editor = createDiv('markdown-source-view mod-cm6');
	const noFile = createDiv({ cls: 'empty-view', text: 'No note is open. Pick one on the left, or press Ctrl/Cmd+N.' });
	noFile.hidden = true;
	return { title, trash, editor, noFile };
}

/** Why reading or saving failed, for a notice: network failures (fetch's TypeError) read as an unreachable server. */
export function reasonOf(err: unknown): string {
	if (err instanceof TypeError) return 'the server is unreachable';
	return err instanceof Error ? err.message : String(err);
}

function isInside(file: TAbstractFile, folder: TAbstractFile): boolean {
	for (let f: TAbstractFile | null = file; f; f = f.parent) if (f === folder) return true;
	return false;
}

export class NotePane {
	readonly leaf: WorkspaceLeaf;
	readonly view: MarkdownView;
	readonly editor: MarkdownEditor;
	readonly tabBar: TabBar;
	/** `.workspace-tabs`: the tab headers and the leaf. */
	readonly containerEl: HTMLElement;
	/** The note in the editor (null for an empty tab, a canvas or a plugin's view). */
	activeFile: TFile | null = null;
	saving = false;
	private dirty = false;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	/** Stops redrawing Live Preview when plugins add or remove code block processors. */
	private stopCodeBlockUpdates: () => void = () => {};
	private applyingExternalChange = false;
	/** Increases each time a tab starts to show, so a slower earlier one gives up. */
	private showing = 0;
	private navigating = false;
	private readonly el: PaneParts;
	private readonly navButtons: { back: HTMLElement; forward: HTMLElement };
	/** `.workspace-tab-container`, where tabs dragged from elsewhere can be dropped. */
	private readonly tabContainerEl: HTMLElement;
	private dropOverlay: HTMLElement | null = null;
	private readonly noHistory = { back: [] as TFile[], forward: [] as TFile[] };
	/** What the empty view says when no note is open. */
	private readonly noFileText: string;
	/** The current tab's note could not be read (see `showUnreadable`). */
	private unreadable = false;

	constructor(
		private readonly host: PaneHost,
		leaf: WorkspaceLeaf,
		parts: PaneParts = makeParts(),
	) {
		const app = host.app;
		this.leaf = leaf;
		// A plugin pinning the leaf (`leaf.setPinned`) pins the current tab.
		leaf.on('pinned-change', (pinned: boolean) => {
			if (this.tab) this.setPinned(this.tab, pinned);
		});
		this.el = parts;
		this.noFileText = parts.noFile.textContent ?? '';
		this.editor = new MarkdownEditor({
			parent: parts.editor,
			onChange: () => this.onEdit(),
			// For views that follow the cursor (the outline's current heading).
			onCursor: (offset) => {
				if (this.activeFile) app.workspace.trigger('emerald:cursor', this.activeFile, offset);
			},
			onOpenLink: (link, newTab) => void this.openLink(link, newTab),
			onOpenUrl: (url) => void host.openExternal(url),
			onHoverLink: (event, linktext, targetEl) => {
				app.workspace.trigger('hover-link', { event, source: 'editor', hoverParent: this.view, targetEl, linktext, sourcePath: this.activeFile?.path ?? '' });
			},
			onFiles: (files, pos) => void this.insertAttachments(files, pos),
			livePreview: {
				renderMarkdown: (markdown, el) => this.renderInEditor(markdown, el),
				isResolved: (link) => Boolean(app.metadataCache.getFirstLinkpathDest(getLinkpath(link), this.activeFile?.path ?? '')),
				renderProperties: (yaml, el) => this.renderProperties(yaml, el),
				validProperties: isPropertiesYaml,
				propertiesInDocument: () => host.propertiesInDocument(),
				isRenderedCodeBlock: (language) => hasCodeBlockProcessor(language),
			},
		});
		parts.trash.addEventListener('click', () => void (this.activeFile && host.trash(this.activeFile)));
		this.editor.view.contentDOM.addEventListener('contextmenu', (event) => this.showEditorMenu(event));
		parts.title.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') parts.title.blur();
			if (e.key === 'Escape') {
				parts.title.value = this.activeFile?.basename ?? '';
				parts.title.blur();
			}
		});
		parts.title.addEventListener('change', () => void this.renameActiveFile(parts.title.value));
		// Plugins load after the first note shows: their code blocks render once they register.
		this.stopCodeBlockUpdates = onCodeBlockProcessorsChanged(() => this.editor.refreshLivePreview());

		const view = new MarkdownView(leaf);
		this.view = view;
		view.editor = new CodeMirrorEditor(this.editor.view);
		view.titleEl.replaceWith(parts.title);
		// Reading view toggle, like the book/pencil button in Obsidian's note header.
		const modeButton = view.addAction('book-open', 'Reading view (⌘E)', () => void this.toggleReading());
		view.onModeChange = (mode) => {
			setIcon(modeButton, mode === 'preview' ? 'pencil' : 'book-open');
			modeButton.setAttribute('aria-label', mode === 'preview' ? 'Edit (⌘E)' : 'Reading view (⌘E)');
			const tab = this.tab;
			if (tab && leaf.view === view && tab.file === this.activeFile && tab.mode !== mode) {
				tab.mode = mode;
				host.saveLayout();
			}
		};
		const navButton = (icon: string, label: string, direction: -1 | 1) => {
			const el = view.navButtonsEl.createEl('button', { cls: 'clickable-icon view-header-nav-button is-disabled', attr: { 'aria-label': label } });
			setIcon(el, icon);
			setTooltip(el, label);
			el.addEventListener('click', () => void this.navigate(direction));
			return el;
		};
		this.navButtons = { back: navButton('arrow-left', 'Navigate back (⌥⌘←)', -1), forward: navButton('arrow-right', 'Navigate forward (⌥⌘→)', 1) };
		// The mouse's back and forward buttons.
		view.containerEl.addEventListener('mouseup', (event) => {
			if (event.button === 3 || event.button === 4) void this.navigate(event.button === 3 ? -1 : 1);
		});
		view.onLivePreviewChange = (on) => this.editor.setLivePreview(on, [setLivePreviewEffect.of(on)]);
		view.livePreview = app.vault.getConfig('livePreview') !== false;
		this.editor.setLivePreview(view.livePreview, [setLivePreviewEffect.of(view.livePreview)]);
		view.actionsEl.append(parts.trash);
		view.contentEl.append(parts.editor, parts.noFile);

		this.tabBar = new TabBar({
			activate: (tab) => this.activateTab(tab),
			close: (tab) => this.closeTab(tab),
			unpin: (tab) => this.setPinned(tab, false),
			newTab: () => this.newTab(),
			menu: (tab, event) => host.tabMenu(this, tab, event),
			drop: (tab, from, index) => host.moveTab(tab, from, this, index),
		});
		this.containerEl = createDiv('workspace-tabs mod-top');
		this.containerEl.append(this.tabBar.containerEl);
		this.tabContainerEl = this.containerEl.createDiv('workspace-tab-container');
		this.tabContainerEl.append(leaf.containerEl);
		this.listenForDroppedTabs();
		// A click or the focus anywhere in the pane makes it the current one.
		this.containerEl.addEventListener('mousedown', () => host.activate(this), true);
		this.containerEl.addEventListener('focusin', () => host.activate(this));
		this.setExtensions(host.editorExtensions());
	}

	get tab(): Tab | null {
		return this.tabBar.active;
	}

	/** Notes visited before and after the open one in the current tab (back/forward). */
	get history(): Tab['history'] {
		return this.tab?.history ?? this.noHistory;
	}

	get hasUnsavedEdits(): boolean {
		return this.dirty;
	}

	/**
	 * Tabs dragged over the note: dropped in the middle, the tab moves here;
	 * near an edge, a new pane opens on that side with it. Listened to before
	 * the editor, which would otherwise take the drop as text.
	 */
	private listenForDroppedTabs(): void {
		const el = this.tabContainerEl;
		const zoneOf = (event: DragEvent): DropZone => {
			const r = el.getBoundingClientRect();
			const x = (event.clientX - r.left) / (r.width || 1);
			const y = (event.clientY - r.top) / (r.height || 1);
			const edge = Math.min(x, 1 - x, y, 1 - y);
			if (edge > 0.25) return 'center';
			return edge === x ? 'left' : edge === 1 - x ? 'right' : edge === y ? 'top' : 'bottom';
		};
		el.addEventListener(
			'dragover',
			(event) => {
				if (!draggedTab()) return;
				event.preventDefault();
				event.stopPropagation();
				if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
				this.showDropZone(zoneOf(event));
			},
			true,
		);
		el.addEventListener('dragleave', (event) => {
			if (!(event.relatedTarget instanceof Node) || !el.contains(event.relatedTarget)) this.showDropZone(null);
		});
		el.addEventListener(
			'drop',
			(event) => {
				const drag = draggedTab();
				this.showDropZone(null);
				if (!drag) return;
				event.preventDefault();
				event.stopPropagation();
				const zone = zoneOf(event);
				if (zone === 'center') this.host.moveTab(drag.tab, drag.bar, this, this.tabBar.tabs.length);
				else this.host.splitWithTab(drag.tab, drag.bar, this, zone === 'left' || zone === 'right' ? 'vertical' : 'horizontal', zone === 'left' || zone === 'top');
			},
			true,
		);
	}

	/** Highlights where a dropped tab would go (`null`: hides it). */
	private showDropZone(zone: DropZone | null): void {
		if (!zone) {
			this.dropOverlay?.detach();
			this.dropOverlay = null;
			return;
		}
		this.dropOverlay ??= this.tabContainerEl.createDiv('workspace-drop-overlay');
		this.dropOverlay.dataset.zone = zone;
	}

	/** Marks the pane as the current one (`.mod-active`, as themes style it). */
	setActive(active: boolean): void {
		this.containerEl.toggleClass('mod-active', active);
		this.leaf.containerEl.toggleClass('mod-active', active);
	}

	focus(): void {
		if (this.activeFile && this.view.getMode() === 'source') this.editor.focus();
	}

	setExtensions(extensions: Extension[]): void {
		this.editor.setExtensions([editorInfoExtensions(this.view, () => this.editor.view, () => this.editor.isLivePreview()), ...extensions]);
	}

	/** Applies Settings → Editor (app.json) to the editor and the reading view. */
	applySettings(): void {
		const vault = this.host.app.vault;
		const get = (key: string) => vault.getConfig(key);
		const readable = get('readableLineLength') !== false;
		this.editor.configure({
			lineNumbers: get('showLineNumber') === true,
			spellcheck: get('spellcheck') === true,
			tabSize: Math.min(8, Math.max(1, Number(get('tabSize')) || 4)),
			useTab: get('useTab') !== false,
			autoPairBrackets: get('autoPairBrackets') !== false,
			readableLineLength: readable,
			vim: get('vimMode') === true,
			folding: get('foldHeading') !== false || get('foldIndent') !== false,
			readOnly: this.host.readOnly?.() ?? false,
		});
		this.view.previewMode.containerEl.toggleClass('is-readable-line-width', readable);
	}

	/** Redraws properties after "Properties in document" changed. */
	refreshProperties(): void {
		this.editor.refreshLivePreview();
		void this.view.renderPreview();
	}

	destroy(): void {
		clearTimeout(this.saveTimer);
		this.stopCodeBlockUpdates();
		this.editor.destroy();
		this.containerEl.detach();
	}

	// Tabs

	/** Opens a file in the current tab, or in a new one. */
	async openFile(file: TFile, options: { newTab?: boolean } = {}): Promise<void> {
		const app = this.host.app;
		const type = file.extension === 'md' ? 'markdown' : app.viewRegistry.getTypeByExtension(file.extension);
		if (!type) {
			this.host.notice(`${file.name}: there is no viewer for this kind of file.`);
			return;
		}
		// A pinned tab keeps its note: other notes open next to it.
		const pinned = this.tab?.pinned && this.tab.file && this.tab.file !== file && !this.navigating;
		if (options.newTab || pinned) this.newTab();
		const tab = this.tab!;
		const shown = this.leaf.view as { file?: unknown };
		// Already open here: keep the cursor and undo history.
		if (tab.file === file && (this.activeFile === file || shown.file === file)) return this.editor.focus();
		if (!this.navigating && tab.file && tab.file !== file) {
			tab.history.back.push(tab.file);
			if (tab.history.back.length > HISTORY_LIMIT) tab.history.back.shift();
			tab.history.forward = [];
		}
		void this.flush();
		tab.file = file;
		tab.state = null;
		tab.scroll = 0;
		tab.viewState = type === 'markdown' ? null : { type, state: { file: file.path } };
		tab.title = tab.icon = undefined;
		this.tabBar.render();
		this.host.saveLayout();
		await this.showTab(tab);
	}

	/** Opens a file; for notes, `select` is a UTF-16 range to select and scroll to. */
	async openFileAt(file: TFile, select?: { from: number; to: number }): Promise<void> {
		await this.openFile(file);
		const editor = this.view.editor;
		if (!select || file !== this.activeFile) return;
		const from = editor.offsetToPos(select.from);
		const to = editor.offsetToPos(select.to);
		editor.setSelection(from, to);
		editor.scrollIntoView({ from, to }, true);
		editor.focus();
	}

	/** Makes `tab` current: keeps the state of the one being left and shows this one. */
	activateTab(tab: Tab): void {
		const bar = this.tabBar;
		if (tab === bar.active || !bar.tabs.includes(tab)) return;
		this.leaveTab();
		this.setActiveTab(tab);
		void this.showTab(tab);
	}

	private setActiveTab(tab: Tab): void {
		this.tabBar.active = tab;
		tab.lastActive = this.host.nextTabClock();
		// The leaf is the current tab, for plugins (`leaf.pinned`); set without its event.
		this.leaf.pinned = Boolean(tab.pinned);
		this.tabBar.render();
		this.host.saveLayout();
	}

	/** Pins or unpins a tab. */
	setPinned(tab: Tab, pinned: boolean): void {
		if (Boolean(tab.pinned) === pinned) return;
		tab.pinned = pinned || undefined;
		if (tab === this.tab && this.leaf.pinned !== pinned) this.leaf.setPinned(pinned);
		this.tabBar.render();
		this.host.saveLayout();
	}

	/** Before another tab shows: saves the current note and keeps the editor's state (or the view's) with the tab. */
	leaveTab(): void {
		const tab = this.tab;
		if (!tab) return;
		// flush() reads the text before its first await, so the editor can change right after.
		void this.flush();
		if (this.leaf.view === this.view) {
			if (tab.file && tab.file === this.activeFile) {
				tab.state = this.editor.getState();
				tab.mode = this.view.getMode();
				tab.scroll = this.view.currentMode.getScroll();
			}
		} else if (!isEmptyTab(tab)) {
			tab.viewState = this.leaf.getViewState();
		}
	}

	/** An empty tab after the current one, made current. */
	newTab(): Tab {
		const bar = this.tabBar;
		this.leaveTab();
		const tab = emptyTab(this.defaultMode());
		bar.tabs.splice(bar.active ? bar.tabs.indexOf(bar.active) + 1 : bar.tabs.length, 0, tab);
		this.setActiveTab(tab);
		// Synchronous, so a plugin can put its own view in the leaf right after `getLeaf(true)`.
		this.showEmptyTab();
		return tab;
	}

	/**
	 * Closes a tab; closing the current one goes back to the tab used most
	 * recently. Closing the last tab closes the pane if another one is left,
	 * else leaves an empty tab.
	 */
	closeTab(tab: Tab): void {
		this.removeTab(tab, true);
	}

	private removeTab(tab: Tab, record: boolean): void {
		const bar = this.tabBar;
		const i = bar.tabs.indexOf(tab);
		if (i === -1) return;
		const current = tab === bar.active;
		if (current) this.leaveTab();
		if (record && !isEmptyTab(tab)) this.host.closed(this, tab, i);
		bar.tabs.splice(i, 1);
		if (!current) {
			bar.render();
			this.host.saveLayout();
			return;
		}
		const next = bar.tabs.reduce<Tab | null>((best, t) => (!best || t.lastActive > best.lastActive ? t : best), null);
		if (next) {
			this.setActiveTab(next);
			void this.showTab(next);
			return;
		}
		if (this.host.removeIfEmpty(this)) return;
		const empty = emptyTab(this.defaultMode());
		bar.tabs.push(empty);
		this.setActiveTab(empty);
		this.showEmptyTab();
	}

	/** Takes a tab out without recording it as closed (it moves to another pane); like `closeTab` otherwise. */
	release(tab: Tab): void {
		this.removeTab(tab, false);
	}

	/** A tab from another pane: put at `index`, made current and shown (its note loads afresh here). */
	takeTab(tab: Tab, index: number): void {
		const bar = this.tabBar;
		this.leaveTab();
		// Editor state belongs to the editor it came from.
		tab.state = null;
		bar.tabs.splice(Math.min(index, bar.tabs.length), 0, tab);
		this.setActiveTab(tab);
		this.host.activate(this);
		void this.showTab(tab);
	}

	/** Moves one of this pane's tabs to `index` (counted with the tab still in place). */
	reorder(tab: Tab, index: number): void {
		const bar = this.tabBar;
		const from = bar.tabs.indexOf(tab);
		if (from === -1) return;
		bar.tabs.splice(from, 1);
		bar.tabs.splice(index > from ? index - 1 : index, 0, tab);
		bar.render();
		this.host.saveLayout();
	}

	/** Puts back a closed tab at `index` (an empty current tab gives it its place) and shows it. */
	reopen(tab: Tab, index: number): void {
		const bar = this.tabBar;
		const current = bar.active;
		this.leaveTab();
		if (current && isEmptyTab(current) && !current.history.back.length) bar.tabs.splice(bar.tabs.indexOf(current), 1);
		bar.tabs.splice(Math.min(index, bar.tabs.length), 0, tab);
		this.setActiveTab(tab);
		void this.showTab(tab);
	}

	/** Tabs showing a deleted file become empty. */
	onDeleted(file: TAbstractFile): void {
		const bar = this.tabBar;
		let changed = false;
		for (const tab of bar.tabs) {
			if (!tab.file || !isInside(tab.file, file)) continue;
			changed = true;
			tab.file = null;
			tab.state = null;
			tab.viewState = null;
			if (tab === bar.active) this.showEmptyTab();
		}
		if (!changed) return;
		bar.render();
		this.host.saveLayout();
	}

	/** A file or folder was renamed: headers follow. True if this pane shows it. */
	onRenamed(file: TAbstractFile): boolean {
		if (!this.tabBar.tabs.some((tab) => tab.file && isInside(tab.file, file))) return false;
		this.tabBar.render();
		this.renderHeader();
		return true;
	}

	onModified(file: TFile): void {
		if (file === this.activeFile) void this.reloadIfChangedOnDisk(file);
	}

	/** Shows a tab in the leaf: its note in the editor (restoring its state), another view, or nothing. */
	async showTab(tab: Tab): Promise<void> {
		const app = this.host.app;
		const view = this.view;
		if (isEmptyTab(tab)) return this.showEmptyTab();
		this.unreadable = false;
		const seq = ++this.showing;
		const current = () => seq === this.showing && this.tab === tab;
		// A save of this note may be in flight (the tab was left a moment ago).
		await this.host.saved();
		if (!current()) return;
		const file = tab.file;
		let viewState = tab.viewState;
		if (!viewState && file && file.extension !== 'md') {
			const type = app.viewRegistry.getTypeByExtension(file.extension);
			if (type) viewState = tab.viewState = { type, state: { file: file.path } };
		}
		if (viewState || !file || file.extension !== 'md') {
			this.clearNote();
			if (viewState) await this.leaf.setViewState(viewState);
			else this.host.notice(`${file?.name ?? 'This tab'}: there is no viewer for this kind of file.`);
			if (current()) this.afterShow(tab.file);
			return;
		}
		let text = this.host.unsavedText(file);
		if (text === undefined) {
			try {
				text = await app.vault.read(file);
			} catch (err) {
				// A server vault while the server is unreachable: say so, rather than leave the previous note in place.
				if (current()) this.showUnreadable(file, err);
				return;
			}
		}
		if (!current()) return;
		if (this.leaf.view !== view) await this.leaf.open(view);
		if (!current()) return;
		this.activeFile = file;
		view.file = file;
		view.data = text;
		const state = tab.state;
		tab.state = null;
		if (state) {
			this.editor.restoreState(state, [setLivePreviewEffect.of(view.livePreview)]);
			// Changed on disk while the tab was in the background: show the new text, keeping undo.
			if (state.doc.toString() !== text) this.applyExternalText(text);
		} else {
			this.editor.setValue(text);
		}
		this.el.editor.hidden = false;
		this.el.noFile.hidden = true;
		this.el.noFile.textContent = this.noFileText;
		if (view.getMode() !== tab.mode) await view.setMode(tab.mode);
		else await view.renderPreview();
		if (!current()) return;
		const scroll = tab.scroll;
		if (scroll) requestAnimationFrame(() => current() && view.currentMode.applyScroll(scroll));
		// Only the current pane takes the focus (focusing another would make it current).
		if (tab.mode === 'source' && this.host.isCurrent(this)) this.editor.focus();
		this.afterShow(file);
	}

	/** An empty tab: the note view with nothing open ("No file is open"). */
	showEmptyTab(): void {
		++this.showing;
		this.clearNote();
		if (this.leaf.view !== this.view) void this.leaf.open(this.view);
		this.el.editor.hidden = true;
		this.el.noFile.textContent = this.noFileText;
		this.el.noFile.hidden = false;
		this.afterShow(null);
	}

	/** A note that could not be read: the tab stays, with the reason; opening it again retries. */
	private showUnreadable(file: TFile, err: unknown): void {
		this.clearNote();
		if (this.leaf.view !== this.view) void this.leaf.open(this.view);
		this.el.editor.hidden = true;
		this.el.noFile.textContent = `Could not open ${file.name}: ${reasonOf(err)}. It opens once the vault is reachable again.`;
		this.el.noFile.hidden = false;
		this.unreadable = true;
		this.afterShow(file);
	}

	/** The vault is reachable again: a note that could not be read is read again. */
	retryUnreadable(): void {
		if (this.unreadable && this.tab) void this.showTab(this.tab);
	}

	/** Empties the note editor (its edits were saved when the tab was left). */
	private clearNote(): void {
		clearTimeout(this.saveTimer);
		this.dirty = false;
		this.activeFile = null;
		this.view.file = null;
		this.editor.setValue('');
	}

	private afterShow(file: TFile | null): void {
		const workspace = this.host.app.workspace;
		this.renderHeader();
		this.renderNavButtons();
		this.tabBar.render();
		if (file) workspace.recordOpenFile(file);
		this.host.shown(this);
		workspace.trigger('file-open', file);
	}

	/** A plugin (or a view) changed what the leaf shows: the current tab follows. */
	syncWithLeaf(): void {
		const tab = this.tab;
		const shown = this.leaf.view;
		if (!tab || shown === this.view) return;
		const file = (shown as { file?: unknown }).file;
		if (this.activeFile) {
			void this.flush();
			this.clearNote();
		}
		tab.file = file instanceof TFile ? file : null;
		tab.title = shown.getDisplayText();
		tab.icon = shown.getIcon();
		if (!tab.viewState || tab.viewState.type !== shown.getViewType()) tab.viewState = { type: shown.getViewType() };
		this.tabBar.render();
		this.host.saveLayout();
	}

	defaultMode(): MarkdownViewModeType {
		return this.host.app.vault.getConfig('defaultViewMode') === 'preview' ? 'preview' : 'source';
	}

	/** The tabs, to save: each tab's note and mode. */
	serialize(): SavedTabs {
		const bar = this.tabBar;
		return {
			tabs: bar.tabs.map((tab) => ({ file: tab.file?.path ?? null, mode: tab.mode, ...(tab.pinned ? { pinned: true } : {}) })),
			active: bar.active ? bar.tabs.indexOf(bar.active) : 0,
		};
	}

	/**
	 * Restores saved tabs (only the current one loads its note, when shown);
	 * tabs whose note is gone are left out. With nothing left, one tab with
	 * `fallback`. Returns false if nothing was saved.
	 */
	restore(saved: unknown, fallback: TFile | null = null): boolean {
		const bar = this.tabBar;
		const vault = this.host.app.vault;
		const data = saved as { tabs?: unknown; active?: unknown } | null;
		let active: Tab | null = null;
		const entries: unknown[] = Array.isArray(data?.tabs) ? data.tabs : [];
		for (const [i, entry] of entries.entries()) {
			const { file: path, mode, pinned } = (entry ?? {}) as { file?: unknown; mode?: unknown; pinned?: unknown };
			const file = typeof path === 'string' ? vault.getFileByPath(path) : null;
			// A note deleted or renamed outside the app since: its tab goes.
			if (typeof path === 'string' && !file) continue;
			const tab = emptyTab(mode === 'preview' ? 'preview' : 'source');
			tab.file = file;
			if (pinned === true) tab.pinned = true;
			bar.tabs.push(tab);
			if (i === data?.active) active = tab;
		}
		if (!bar.tabs.length) {
			const tab = emptyTab(this.defaultMode());
			tab.file = fallback;
			bar.tabs.push(tab);
			active = tab;
		}
		this.setActiveTab(active ?? bar.tabs[0]!);
		return entries.length > 0;
	}

	/** Makes the tab showing `file` current, or adds a tab for it (shown with `showTab`). */
	selectFile(file: TFile): void {
		const tab = this.tabBar.tabs.find((t) => t.file === file);
		if (tab) return this.setActiveTab(tab);
		const added = emptyTab(this.defaultMode());
		added.file = file;
		this.tabBar.tabs.push(added);
		this.setActiveTab(added);
	}

	// Navigation

	/** Opens the previous (-1) or next (1) note in the history, skipping deleted ones. */
	async navigate(direction: -1 | 1): Promise<void> {
		const vault = this.host.app.vault;
		const from = direction < 0 ? this.history.back : this.history.forward;
		const to = direction < 0 ? this.history.forward : this.history.back;
		let target: TFile | undefined;
		while ((target = from.pop()) && !vault.getFileByPath(target.path)) {}
		if (!target) return this.renderNavButtons();
		const current = this.tab?.file;
		if (current && current !== target) to.push(current);
		this.navigating = true;
		try {
			await this.openFile(target);
		} finally {
			this.navigating = false;
		}
	}

	private renderNavButtons(): void {
		const vault = this.host.app.vault;
		const exists = (file: TFile) => Boolean(vault.getFileByPath(file.path));
		this.navButtons.back.toggleClass('is-disabled', !this.history.back.some(exists));
		this.navButtons.forward.toggleClass('is-disabled', !this.history.forward.some(exists));
	}

	/** Switches the open note between editing and the reading view (saving first). */
	async toggleReading(): Promise<void> {
		if (!this.activeFile) return;
		await this.flush();
		await this.view.setMode(this.view.getMode() === 'preview' ? 'source' : 'preview');
	}

	private async openLink(linktext: string, newTab = false): Promise<void> {
		const app = this.host.app;
		const linkpath = getLinkpath(linktext);
		if (!linkpath) return;
		let target = app.metadataCache.getFirstLinkpathDest(linkpath, this.activeFile?.path ?? '');
		if (!target) {
			// Like Obsidian, following a link to a missing note creates it.
			const path = linkpath.toLowerCase().endsWith('.md') ? linkpath : `${linkpath}.md`;
			try {
				target = await app.vault.create(path, '');
			} catch (err) {
				this.host.notice(`Could not create ${path}: ${err}`);
				return;
			}
		}
		await this.openFile(target, { newTab });
	}

	// Editing and saving

	private onEdit(): void {
		if (!this.activeFile || this.applyingExternalChange) return;
		this.dirty = true;
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
		this.host.statusChanged(this);
		this.host.app.workspace.trigger('editor-change', this.view.editor, this.view);
	}

	/**
	 * Saves pending edits to the note now. The text is taken before this
	 * returns, so the editor may show another note right after; saves of all
	 * panes run one after another.
	 */
	flush(): Promise<void> {
		clearTimeout(this.saveTimer);
		const file = this.activeFile;
		if (!this.dirty || !file) return this.host.saved();
		const text = this.editor.getValue();
		this.dirty = false;
		this.saving = true;
		this.host.statusChanged(this);
		return this.host.saveText(file, text).then((saved) => {
			if (saved && this.view.file === file) this.view.data = text;
			this.saving = false;
			this.host.statusChanged(this);
		});
	}

	/** Shows a change made outside the app (or in another pane), unless there are unsaved edits here. */
	private async reloadIfChangedOnDisk(file: TFile): Promise<void> {
		// Edits still waiting to be saved are newer than the file.
		if (this.dirty || this.host.unsavedText(file) !== undefined) return;
		const text = await this.host.app.vault.cachedRead(file);
		if (file !== this.activeFile || this.dirty || text === this.editor.getValue()) return;
		this.applyExternalText(text);
		void this.view.renderPreview();
		this.host.statusChanged(this);
	}

	/** Puts text changed outside the app into the editor, keeping undo history and the cursor where possible. */
	private applyExternalText(text: string): void {
		this.applyingExternalChange = true;
		try {
			this.editor.replaceValue(text);
		} finally {
			this.applyingExternalChange = false;
		}
	}

	private async renameActiveFile(newName: string): Promise<void> {
		const file = this.activeFile;
		if (!file) return;
		newName = newName.trim();
		if (!newName || newName === file.basename) {
			this.el.title.value = file.basename;
			return;
		}
		if (/[\\/:]/.test(newName)) {
			this.host.notice('Note names cannot contain \\ / or :');
			this.el.title.value = file.basename;
			return;
		}
		const folder = file.parent && !file.parent.isRoot() ? file.parent.path + '/' : '';
		try {
			await this.flush();
			await this.host.app.fileManager.renameFile(file, `${folder}${newName}.${file.extension}`);
		} catch (err) {
			this.host.notice(`Could not rename: ${err}`);
			this.el.title.value = file.basename;
		}
	}

	/** Puts the note's name in the title field, to type a new one. */
	selectTitle(): void {
		this.el.title.select();
	}

	private renderHeader(): void {
		const file = this.activeFile;
		this.el.title.value = file?.basename ?? '';
		this.el.title.disabled = !file;
		this.el.trash.hidden = !file;
	}

	/**
	 * Saves pasted or dropped files as attachments (where the vault's settings
	 * say) and inserts embeds for them, like Obsidian: "Pasted image <time>.png".
	 */
	private async insertAttachments(files: File[], pos: number): Promise<void> {
		const app = this.host.app;
		const note = this.activeFile;
		if (!note) return;
		const embeds: string[] = [];
		for (const file of files) {
			const dot = file.name.lastIndexOf('.');
			const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : (file.type.split('/')[1] ?? 'bin');
			const generic = !file.name || /^image\.\w+$/i.test(file.name);
			const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
			const base = generic ? `Pasted image ${stamp}` : file.name.slice(0, dot > 0 ? dot : undefined);
			try {
				const path = await app.fileManager.getAvailablePathForAttachment(`${base}.${extension}`, note.path);
				const created = await app.vault.createBinary(path, await file.arrayBuffer());
				embeds.push(`!${app.fileManager.generateMarkdownLink(created, note.path)}`);
			} catch (err) {
				this.host.notice(`Could not save ${file.name || 'the pasted file'}: ${err}`);
			}
		}
		if (!embeds.length || this.activeFile !== note) return;
		this.editor.view.dispatch({ changes: { from: pos, insert: embeds.join('\n') }, selection: { anchor: pos + embeds.join('\n').length } });
	}

	/** Renders Markdown into a Live Preview widget (embeds, callouts, tables), like the reading view. */
	private renderInEditor(markdown: string, el: HTMLElement): () => void {
		const component = new Component();
		component.load();
		void MarkdownRenderer.render(this.host.app, markdown, el, this.activeFile?.path ?? '', component).catch((err: unknown) => console.error(err));
		return () => component.unload();
	}

	/** The note's properties at the top of Live Preview; edits go into the note's text. */
	private renderProperties(yaml: string, el: HTMLElement) {
		const properties = new PropertiesEditor(this.host.app, el, { sourcePath: () => this.activeFile?.path ?? '', save: (data) => this.view.saveProperties(data) });
		properties.setYaml(yaml);
		return { update: (next: string) => properties.setYaml(next), destroy: () => properties.destroy() };
	}

	/**
	 * The editor's context menu, as Obsidian's: clipboard, Format, Paragraph
	 * and Insert submenus, and plugins' items (`editor-menu`). With
	 * spellcheck on, the system menu stays: only it offers spelling
	 * suggestions.
	 */
	private showEditorMenu(event: MouseEvent): void {
		const app = this.host.app;
		if (!this.activeFile || app.vault.getConfig('spellcheck') === true) return;
		event.preventDefault();
		const cm = this.editor.view;
		// A click outside the selection moves the cursor there first.
		const pos = cm.posAtCoords({ x: event.clientX, y: event.clientY });
		const sel = cm.state.selection.main;
		if (pos !== null && (pos < sel.from || pos > sel.to)) cm.dispatch({ selection: { anchor: pos } });
		const editor = this.view.editor;
		const selected = editor.getSelection();
		const run = (id: string) => () => app.commands.executeCommandById(id);
		const menu = new Menu();
		const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
		if (selected) {
			menu.addItem((item) =>
				item
					.setTitle('Cut')
					.setIcon('scissors')
					.setSection('clipboard')
					.onClick(async () => {
						await clipboard?.writeText(selected);
						editor.replaceSelection('');
					}),
			);
			menu.addItem((item) => item.setTitle('Copy').setIcon('copy').setSection('clipboard').onClick(() => clipboard?.writeText(selected)));
		}
		menu.addItem((item) =>
			item
				.setTitle('Paste')
				.setIcon('clipboard-paste')
				.setSection('clipboard')
				.onClick(async () => {
					const text = await clipboard?.readText();
					if (text) editor.replaceSelection(text);
				}),
		);
		menu.addItem((item) =>
			item
				.setTitle('Select all')
				.setIcon('text-select')
				.setSection('clipboard')
				.onClick(() => cm.dispatch({ selection: { anchor: 0, head: cm.state.doc.length } })),
		);
		const submenu = (title: string, icon: string, items: [string, string, string][]) =>
			menu.addItem((item) => {
				item.setTitle(title).setIcon(icon).setSection('selection');
				const sub = item.setSubmenu();
				for (const [name, subIcon, id] of items) sub.addItem((i) => i.setTitle(name).setIcon(subIcon).onClick(run(id)));
			});
		submenu('Format', 'type', [
			['Bold', 'bold', 'editor:toggle-bold'],
			['Italic', 'italic', 'editor:toggle-italics'],
			['Strikethrough', 'strikethrough', 'editor:toggle-strikethrough'],
			['Highlight', 'highlighter', 'editor:toggle-highlight'],
			['Code', 'code', 'editor:toggle-code'],
			['Math', 'sigma', 'editor:toggle-inline-math'],
			['Comment', 'percent', 'editor:toggle-comments'],
		]);
		submenu('Paragraph', 'pilcrow', [
			['Bullet list', 'list', 'editor:toggle-bullet-list'],
			['Numbered list', 'list-ordered', 'editor:toggle-numbered-list'],
			['Task list', 'list-checks', 'editor:toggle-checklist-status'],
			...[1, 2, 3, 4, 5, 6].map((n): [string, string, string] => [`Heading ${n}`, `heading-${n}`, `editor:set-heading-${n}`]),
			['Body', 'text', 'editor:set-heading-0'],
			['Quote', 'quote', 'editor:toggle-blockquote'],
		]);
		submenu('Insert', 'plus', [
			['Table', 'table', 'editor:insert-table'],
			['Callout', 'quote', 'editor:insert-callout'],
			['Horizontal rule', 'minus', 'editor:insert-horizontal-rule'],
			['Code block', 'square-code', 'editor:insert-codeblock'],
			['Math block', 'sigma-square', 'editor:insert-mathblock'],
		]);
		app.workspace.trigger('editor-menu', menu, editor, this.view);
		menu.showAtMouseEvent(event);
	}

	/** "Add file property": a new row in the properties editor, or a new line in the YAML (source mode, hidden properties). */
	async addProperty(): Promise<void> {
		const view = this.view;
		const cm = this.editor.view;
		let frontmatter = frontmatterAt(cm.state.doc);
		if (!frontmatter) {
			cm.dispatch({ changes: { from: 0, insert: '---\n---\n' } });
			frontmatter = frontmatterAt(cm.state.doc)!;
		}
		const reading = view.getMode() === 'preview';
		if (this.host.propertiesInDocument() === 'visible' && (reading || this.editor.isLivePreview())) {
			if (reading) await view.renderPreview();
			const root = reading ? view.previewMode.containerEl : cm.dom;
			root.querySelector<HTMLElement>('.metadata-add-button')?.click();
			return;
		}
		if (reading) await view.setMode('source');
		// A new line at the end of the YAML.
		const closing = cm.state.doc.lineAt(frontmatter.to);
		const empty = closing.number === 2;
		const at = empty ? closing.from : cm.state.doc.line(closing.number - 1).to;
		cm.dispatch({ changes: { from: at, insert: '\n' }, selection: { anchor: empty ? at : at + 1 } });
		cm.focus();
	}
}
