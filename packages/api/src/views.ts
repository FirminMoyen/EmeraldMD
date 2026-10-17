/**
 * Views shown in workspace leaves. DOM: `.workspace-leaf-content[data-type] >
 * .view-header + .view-content`, the structure themes and plugins style.
 */

import { TFile } from '@emeraldmd/core';
import type { App } from './app';
import { Component } from './component';
import { debounce } from './util';
import type { Editor, MarkdownFileInfo } from './editor';
import { setIcon } from './icons';
import type { Scope } from './keymap';
import type { Menu } from './menu';
import { setTooltip } from './tooltip';
import { MarkdownRenderChild, MarkdownRenderer } from './markdown';
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
	/** @internal */
	titleEl: HTMLElement;
	/** @internal */
	actionsEl: HTMLElement;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.headerEl = this.containerEl.createDiv('view-header');
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

/** Reading view of a note (`view.previewMode`). */
export interface MarkdownPreviewView extends MarkdownSubView {
	containerEl: HTMLElement;
	rerender(full?: boolean): void;
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
	/** @internal The editing mode (the shell's CodeMirror editor). */
	readonly sourceMode: MarkdownSubView;
	/** @internal Called after the mode changes, so the shell can update its controls. */
	onModeChange: ((mode: MarkdownViewModeType) => void) | null = null;
	private readonly readingEl: HTMLElement;
	private renderChild: MarkdownRenderChild | null = null;
	private renderGeneration = 0;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		// `.markdown-reading-view > .markdown-preview-view.markdown-rendered`, the structure themes style.
		this.readingEl = this.contentEl.createDiv('markdown-reading-view');
		const previewEl = this.readingEl.createDiv('markdown-preview-view markdown-rendered');
		this.sourceMode = {
			getScroll: () => this.editor?.getScrollInfo().top ?? 0,
			applyScroll: (scroll) => this.editor?.scrollTo(null, scroll),
			get: () => this.getViewData(),
			set: (data, clear) => this.setViewData(data, clear),
		};
		this.previewMode = {
			containerEl: previewEl,
			getScroll: () => this.readingEl.scrollTop,
			applyScroll: (scroll) => (this.readingEl.scrollTop = scroll),
			get: () => this.getViewData(),
			set: () => void this.renderPreview(),
			rerender: () => void this.renderPreview(),
		};
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

	override getState(): Record<string, unknown> {
		return { ...super.getState(), mode: this.getMode() };
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const mode = (state as { mode?: unknown } | null)?.mode;
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
		this.previewMode.containerEl.replaceChildren(target);
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
