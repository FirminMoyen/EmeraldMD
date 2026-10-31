/**
 * Views shown in workspace leaves. DOM: `.workspace-leaf-content[data-type] >
 * .view-header + .view-content`, the structure themes and plugins style.
 */

import { TFile } from '@emeraldmd/core';
import type { App } from './app';
import { Component } from './component';
import { debounce, getFrontMatterInfo } from './util';
import type { Editor, MarkdownFileInfo } from './editor';
import { setIcon } from './icons';
import type { Scope } from './keymap';
import type { Menu } from './menu';
import { setTooltip } from './tooltip';
import { MarkdownRenderChild, MarkdownRenderer } from './markdown';
import { PropertiesEditor, stringifyFrontmatter } from './properties';
import type { WorkspaceLeaf } from './workspace';

export interface ViewStateResult {
	history: boolean;
}

export abstract class View extends Component {
	app: App;
	icon = '';
	navigation = false;
	leaf: WorkspaceLeaf;
	containerEl: HTMLElement;
	scope: Scope | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super();
		this.leaf = leaf;
		this.app = leaf.app;
		this.containerEl = createDiv('workspace-leaf-content');
	}

	protected async onOpen(): Promise<void> {}

	protected async onClose(): Promise<void> {}

	/** @internal Lets the leaf open and close views; `onOpen`/`onClose` are protected in the typings. */
	open(): Promise<void> {
		return this.onOpen();
	}

	/** @internal */
	close(): Promise<void> {
		return this.onClose();
	}

	abstract getViewType(): string;

	getState(): Record<string, unknown> {
		return {};
	}

	async setState(_state: unknown, _result: ViewStateResult): Promise<void> {}

	getEphemeralState(): Record<string, unknown> {
		return {};
	}

	setEphemeralState(_state: unknown): void {}

	getIcon(): string {
		return this.icon;
	}

	onResize(): void {}

	abstract getDisplayText(): string;

	onPaneMenu(_menu: Menu, _source: string): void {}
}

export abstract class ItemView extends View {
	contentEl: HTMLElement;
	/** @internal */
	headerEl: HTMLElement;
	/** @internal Back and forward buttons (`.view-header-nav-buttons`), filled by the shell. */
	navButtonsEl: HTMLElement;
	/** @internal */
	titleEl: HTMLElement;
	/** @internal */
	actionsEl: HTMLElement;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.headerEl = this.containerEl.createDiv('view-header');
		this.navButtonsEl = this.headerEl.createDiv('view-header-left').createDiv('view-header-nav-buttons');
		this.titleEl = this.headerEl.createDiv('view-header-title-container').createDiv('view-header-title');
		this.actionsEl = this.headerEl.createDiv('view-actions');
		this.contentEl = this.containerEl.createDiv('view-content');
	}

	addAction(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
		const el = this.actionsEl.createEl('a', { cls: 'clickable-icon view-action', attr: { 'aria-label': title } });
		setIcon(el, icon);
		setTooltip(el, title);
		el.addEventListener('click', callback);
		return el;
	}

	override async open(): Promise<void> {
		this.titleEl.setText(this.getDisplayText());
		await super.open();
	}
}

export class EmptyView extends ItemView {
	getViewType(): string {
		return 'empty';
	}

	getDisplayText(): string {
		return 'New tab';
	}
}

export abstract class FileView extends ItemView {
	allowNoFile = false;
	file: TFile | null = null;
	override navigation = true;

	getDisplayText(): string {
		return this.file?.basename ?? 'No file';
	}

	override onload(): void {
		this.registerEvent(
			this.app.vault.on('rename', (file: unknown) => {
				if (this.file && file === this.file) void this.onRename(this.file);
			}),
		);
	}

	override getState(): Record<string, unknown> {
		return this.file ? { file: this.file.path } : {};
	}

	override async setState(state: unknown, _result: ViewStateResult): Promise<void> {
		const path = (state as { file?: unknown } | null)?.file;
		if (typeof path !== 'string') return;
		const file = this.app.vault.getFileByPath(path);
		if (file) await this.loadFile(file);
	}

	/** @internal */
	async loadFile(file: TFile): Promise<void> {
		if (this.file === file) return;
		if (this.file) await this.onUnloadFile(this.file);
		this.file = file;
		this.titleEl.setText(this.getDisplayText());
		await this.onLoadFile(file);
	}

	async onLoadFile(_file: TFile): Promise<void> {}

	async onUnloadFile(_file: TFile): Promise<void> {}

	async onRename(_file: TFile): Promise<void> {
		this.titleEl.setText(this.getDisplayText());
	}

	canAcceptExtension(_extension: string): boolean {
		return false;
	}
}

export abstract class EditableFileView extends FileView {}

export abstract class TextFileView extends EditableFileView {
	data = '';
	requestSave: () => void;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.requestSave = debounce(() => void this.save(), 2000, true);
	}

	override async onUnloadFile(_file: TFile): Promise<void> {
		await this.save();
	}

	override async onLoadFile(file: TFile): Promise<void> {
		this.data = await this.app.vault.read(file);
		this.setViewData(this.data, true);
	}

	async save(_clear?: boolean): Promise<void> {
		if (!this.file) return;
		const data = this.getViewData();
		if (data === this.data) return;
		this.data = data;
		await this.app.vault.modify(this.file, data);
	}

	abstract getViewData(): string;
	abstract setViewData(data: string, clear: boolean): void;
	abstract clear(): void;
}

export interface MarkdownSubView {
	getScroll(): number;
	applyScroll(scroll: number): void;
	get(): string;
	set(data: string, clear: boolean): void;
}

export type MarkdownViewModeType = 'source' | 'preview';

/** The reading view of a note (`view.previewMode`). */
export class MarkdownPreviewView implements MarkdownSubView {
	constructor(
		private readonly view: MarkdownView,
		readonly containerEl: HTMLElement,
		/** The element that scrolls. */
		private readonly scroller: HTMLElement,
	) {}

	get file(): TFile | null {
		return this.view.file;
	}

	get(): string {
		return this.view.getViewData();
	}

	/** Shows the note's current text (the view holds it). */
	set(_data: string, _clear: boolean): void {
		void this.view.renderPreview();
	}

	clear(): void {
		this.containerEl.empty();
	}

	rerender(_full?: boolean): void {
		void this.view.renderPreview();
	}

	getScroll(): number {
		return this.scroller.scrollTop;
	}

	applyScroll(scroll: number): void {
		this.scroller.scrollTop = scroll;
	}
}

/** The editing mode of a note (`view.editMode`): the shell's CodeMirror editor. */
export class MarkdownEditView implements MarkdownSubView {
	constructor(private readonly view: MarkdownView) {}

	get file(): TFile | null {
		return this.view.file;
	}

	get(): string {
		return this.view.getViewData();
	}

	set(data: string, clear: boolean): void {
		this.view.setViewData(data, clear);
	}

	clear(): void {
		this.view.clear();
	}

	getSelection(): string {
		return this.view.editor?.getSelection() ?? '';
	}

	getScroll(): number {
		return this.view.editor?.getScrollInfo().top ?? 0;
	}

	applyScroll(scroll: number): void {
		this.view.editor?.scrollTo(null, scroll);
	}
}

/**
 * The note editor. In EmeraldMD the desktop shell owns the CodeMirror
 * instance and assigns `editor` and `file`; loading and saving files goes
 * through the shell (see `WorkspaceHost`).
 */
export class MarkdownView extends TextFileView implements MarkdownFileInfo {
	editor!: Editor;
	hoverPopover: unknown = null;
	currentMode: MarkdownSubView;
	previewMode: MarkdownPreviewView;
	/** The editing mode (the shell's CodeMirror editor). */
	editMode: MarkdownEditView;
	/** @internal The same as `editMode`, as Obsidian also calls it. */
	readonly sourceMode: MarkdownEditView;
	/** @internal Called after the mode changes, so the shell can update its controls. */
	onModeChange: ((mode: MarkdownViewModeType) => void) | null = null;
	/** @internal Whether editing shows Live Preview (true) or plain source (false). */
	livePreview = true;
	/** @internal Set by the shell to switch its editor between Live Preview and source mode. */
	onLivePreviewChange: ((on: boolean) => void) | null = null;
	private readonly readingEl: HTMLElement;
	private renderChild: MarkdownRenderChild | null = null;
	private renderGeneration = 0;
	/** The reading view's properties, kept across renders so a field being edited keeps the focus. */
	private readingProperties: PropertiesEditor | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		// `.markdown-reading-view > .markdown-preview-view.markdown-rendered`, the structure themes style.
		this.readingEl = this.contentEl.createDiv('markdown-reading-view');
		const previewEl = this.readingEl.createDiv('markdown-preview-view markdown-rendered');
		this.sourceMode = this.editMode = new MarkdownEditView(this);
		this.previewMode = new MarkdownPreviewView(this, previewEl, this.readingEl);
		this.currentMode = this.sourceMode;
	}

	getMode(): MarkdownViewModeType {
		return this.currentMode === this.previewMode ? 'preview' : 'source';
	}

	/** Switches between editing (`source`) and the reading view (`preview`). */
	async setMode(mode: MarkdownViewModeType | MarkdownSubView): Promise<void> {
		const next = mode === 'preview' || mode === this.previewMode ? this.previewMode : this.sourceMode;
		if (next === this.currentMode) return;
		this.currentMode = next;
		this.containerEl.toggleClass('is-reading', next === this.previewMode);
		if (next === this.previewMode) await this.renderPreview();
		else this.editor?.focus();
		this.onModeChange?.(this.getMode());
		this.app.workspace.trigger('layout-change');
	}

	/** @internal Switches editing between Live Preview and source mode. */
	setLivePreview(on: boolean): void {
		if (on === this.livePreview) return;
		this.livePreview = on;
		this.onLivePreviewChange?.(on);
		this.app.workspace.trigger('layout-change');
	}

	/** `source: true` is source mode, `false` Live Preview, as in the view state plugins read. */
	override getState(): Record<string, unknown> {
		return { ...super.getState(), mode: this.getMode(), source: !this.livePreview };
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const { mode, source } = (state ?? {}) as { mode?: unknown; source?: unknown };
		if (typeof source === 'boolean') this.setLivePreview(!source);
		if (mode === 'preview' || mode === 'source') await this.setMode(mode);
	}

	/** @internal Re-renders the reading view, when it is showing, from the current text. */
	async renderPreview(): Promise<void> {
		if (this.getMode() !== 'preview') return;
		const generation = ++this.renderGeneration;
		const target = createDiv('markdown-preview-sizer markdown-preview-section');
		const child = new MarkdownRenderChild(target);
		this.addChild(child);
		await MarkdownRenderer.render(this.app, this.getViewData(), target, this.file?.path ?? '', child);
		if (generation !== this.renderGeneration) {
			this.removeChild(child);
			return;
		}
		if (this.renderChild) this.removeChild(this.renderChild);
		this.renderChild = child;
		const header = this.propertiesHeader();
		if (header) target.prepend(header);
		this.previewMode.containerEl.replaceChildren(target);
	}

	/** The note's properties above the reading view, as "Properties in document" says. */
	private propertiesHeader(): HTMLElement | null {
		const info = getFrontMatterInfo(this.getViewData());
		const mode = this.app.vault.getConfig('propertiesInDocument') ?? 'visible';
		if (!info.exists || mode === 'hidden') return null;
		const header = createDiv('mod-header');
		if (mode !== 'source') {
			this.readingProperties ??= new PropertiesEditor(this.app, createDiv(), {
				sourcePath: () => this.file?.path ?? '',
				save: (data) => this.saveProperties(data),
			});
			if (this.readingProperties.setYaml(info.frontmatter)) {
				header.append(this.readingProperties.containerEl);
				return header;
			}
		}
		// Shown as YAML (the setting, or YAML that is not valid).
		header.createEl('pre', { cls: 'frontmatter language-yaml' }).createEl('code', { cls: 'language-yaml', text: info.frontmatter });
		return header;
	}

	/**
	 * @internal Writes the note's properties, from a properties editor, into
	 * the editor (saved with the note's other edits); all of them, in order.
	 */
	saveProperties(data: Record<string, unknown>): void {
		const yaml = stringifyFrontmatter(data);
		const editor = this.editor;
		if (!editor) {
			if (this.file) {
				void this.app.fileManager.processFrontMatter(this.file, (frontmatter) => {
					for (const key of Object.keys(frontmatter)) delete frontmatter[key];
					Object.assign(frontmatter, data);
				});
			}
			return;
		}
		const info = getFrontMatterInfo(editor.getValue());
		const block = yaml ? `---\n${yaml}---\n` : '';
		const end = info.exists ? info.contentStart : 0;
		editor.replaceRange(block, editor.offsetToPos(0), editor.offsetToPos(end));
	}

	getViewType(): string {
		return 'markdown';
	}

	getViewData(): string {
		return this.editor?.getValue() ?? this.data;
	}

	setViewData(data: string, _clear: boolean): void {
		this.editor?.setValue(data);
	}

	clear(): void {}

	showSearch(_replace?: boolean): void {}

	override canAcceptExtension(extension: string): boolean {
		return extension === 'md';
	}

	override async save(): Promise<void> {
		await this.app.workspace.host.save();
	}
}
