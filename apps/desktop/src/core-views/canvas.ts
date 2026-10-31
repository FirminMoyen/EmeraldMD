/**
 * `.canvas` files (JSON Canvas) in the main area, on @emeraldmd/canvas, with
 * Obsidian's tools around it: zoom and undo controls, a menu to add cards
 * (text, a note or media from the vault), context menus on cards, edges and
 * the background (colour, edit, group, remove), and files dropped from the
 * file explorer.
 */

import { FuzzySuggestModal, MarkdownRenderer, Menu, Modal, Notice, TextFileView, mediaKind, renderMedia, resourceUrl, setIcon, type App, type WorkspaceLeaf } from '@emeraldmd/api';
import { CANVAS_CSS, CanvasView, parseCanvas, serializeCanvas, type CanvasEdge, type CanvasNode, type FileNode, type NewNode, type Point } from '@emeraldmd/canvas';
import type { TFile } from '@emeraldmd/core';
import { PATH_TYPE } from '../file-explorer';
import type { CoreViewHost } from './host';

export const CANVAS_VIEW = 'canvas';

/** The preset colours, as Obsidian names them in its menus. */
const COLORS: [string, string][] = [
	['1', 'Red'],
	['2', 'Orange'],
	['3', 'Yellow'],
	['4', 'Green'],
	['5', 'Cyan'],
	['6', 'Purple'],
];

const CARD = { width: 260, height: 60 };
const FILE_CARD = { width: 400, height: 400 };

let stylesInstalled = false;
function installStyles(): void {
	if (stylesInstalled) return;
	stylesInstalled = true;
	const style = document.createElement('style');
	style.id = 'emeraldmd-canvas-styles';
	style.textContent = CANVAS_CSS;
	document.head.prepend(style);
}

/** Picks a vault file: notes, or media. */
class FilePicker extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly media: boolean,
		private readonly choose: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder(media ? 'Choose an image, audio, video or PDF file…' : 'Choose a note…');
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((f) => (this.media ? mediaKind(f.extension) !== null : f.extension === 'md'));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.choose(file);
	}
}

/** Asks for an edge's label. */
class LabelModal extends Modal {
	constructor(
		app: App,
		private readonly label: string,
		private readonly save: (label: string) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText('Edit label');
		const input = this.contentEl.createEl('input', { type: 'text', cls: 'canvas-label-input', value: this.label, attr: { placeholder: 'Label', spellcheck: 'false' } });
		const done = () => {
			this.save(input.value);
			this.close();
		};
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				done();
			}
		});
		const buttons = this.contentEl.createDiv('modal-button-container');
		buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
		buttons.createEl('button', { cls: 'mod-cta', text: 'Save' }).addEventListener('click', done);
		input.focus();
		input.select();
	}
}

export class CanvasFileView extends TextFileView {
	private canvas: CanvasView | null = null;
	/** Only write the file after an edit, so opening a canvas never reformats it. */
	private edited = false;
	private undoButton: HTMLElement | null = null;
	private redoButton: HTMLElement | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: CoreViewHost,
	) {
		super(leaf);
		this.icon = 'layout-dashboard';
	}

	getViewType(): string {
		return CANVAS_VIEW;
	}

	override canAcceptExtension(extension: string): boolean {
		return extension === 'canvas';
	}

	protected override async onOpen(): Promise<void> {
		installStyles();
		this.contentEl.empty();
		this.contentEl.addClass('canvas-view');
		this.canvas = new CanvasView(this.contentEl, {
			renderMarkdown: (el, markdown) => void MarkdownRenderer.render(this.app, markdown, el, this.file?.path ?? '', this),
			renderFile: (el, node) => this.renderFileCard(el, node),
			onOpenFile: (node) => void this.openFileCard(node),
			onOpenLink: (url) => window.open(url, '_blank', 'noopener'),
			onChange: () => {
				this.edited = true;
				this.requestSave();
				this.refreshHistory();
			},
			onContextMenu: (event, target) => this.showMenu(event, target),
			onDrop: (event, at) => this.drop(event, at),
		});
		this.renderControls();
		this.renderCardMenu();
	}

	protected override async onClose(): Promise<void> {
		await this.save();
		this.canvas?.destroy();
		this.canvas = null;
	}

	getViewData(): string {
		return this.edited && this.canvas ? serializeCanvas(this.canvas.getData()) : this.data;
	}

	setViewData(data: string, clear: boolean): void {
		if (clear) this.edited = false;
		try {
			const { data: parsed, warnings } = parseCanvas(data);
			this.canvas?.setData(parsed);
			if (clear) requestAnimationFrame(() => this.canvas?.zoomToFit());
			if (warnings.length) new Notice(`${this.file?.name}: skipped ${warnings.length} item(s) that could not be shown.`);
		} catch (err) {
			this.canvas?.setData({ nodes: [], edges: [] });
			new Notice(`${this.file?.name}: ${(err as Error).message}`);
		}
		this.refreshHistory();
	}

	clear(): void {
		this.canvas?.setData({ nodes: [], edges: [] });
		this.refreshHistory();
	}

	/** Zoom and undo buttons, on the right. */
	private renderControls(): void {
		const controls = this.contentEl.createDiv('canvas-controls');
		const group = () => controls.createDiv('canvas-control-group');
		const button = (parent: HTMLElement, icon: string, label: string, onClick: () => void) => {
			const el = parent.createDiv({ cls: 'canvas-control-item clickable-icon', attr: { 'aria-label': label, 'data-tooltip-position': 'left' } });
			setIcon(el, icon);
			el.addEventListener('click', () => {
				onClick();
				this.canvas?.el.focus();
			});
			return el;
		};
		const zoom = group();
		button(zoom, 'plus', 'Zoom in', () => this.canvas?.zoomBy(1.25));
		button(zoom, 'rotate-ccw', 'Reset zoom', () => this.canvas?.resetZoom());
		button(zoom, 'maximize', 'Zoom to fit', () => this.canvas?.zoomToFit());
		button(zoom, 'minus', 'Zoom out', () => this.canvas?.zoomBy(0.8));
		const history = group();
		this.undoButton = button(history, 'undo-2', 'Undo', () => this.canvas?.undo());
		this.redoButton = button(history, 'redo-2', 'Redo', () => this.canvas?.redo());
		this.refreshHistory();
	}

	private refreshHistory(): void {
		this.undoButton?.toggleClass('is-disabled', !this.canvas?.canUndo());
		this.redoButton?.toggleClass('is-disabled', !this.canvas?.canRedo());
	}

	/** Buttons to add cards, at the bottom. */
	private renderCardMenu(): void {
		const menu = this.contentEl.createDiv('canvas-card-menu');
		const button = (icon: string, label: string, onClick: () => void) => {
			const el = menu.createDiv({ cls: 'canvas-card-menu-button clickable-icon', attr: { 'aria-label': label, 'data-tooltip-position': 'top' } });
			setIcon(el, icon);
			el.addEventListener('click', onClick);
		};
		button('sticky-note', 'Add card', () => this.addCard());
		button('file-text', 'Add note from vault', () => this.pickFile(false));
		button('image', 'Add media from vault', () => this.pickFile(true));
	}

	/** A text card, being edited. */
	private addCard(at?: Point): void {
		const [card] = this.canvas?.addNodes([{ type: 'text', text: '', ...CARD }], at) ?? [];
		if (card) this.canvas?.edit(card);
	}

	private pickFile(media: boolean, at?: Point): void {
		new FilePicker(this.app, media, (file) => this.canvas?.addNodes([this.fileCard(file.path)], at)).open();
	}

	private fileCard(path: string): NewNode {
		return { type: 'file', file: path, ...FILE_CARD };
	}

	/** Files from the file explorer become file cards, web links link cards. */
	private drop(event: DragEvent, at: Point): boolean {
		const transfer = event.dataTransfer;
		if (!transfer || !this.canvas) return false;
		const paths = (transfer.getData(PATH_TYPE) || '').split('\n').filter((path) => this.app.vault.getFileByPath(path));
		if (paths.length) {
			this.canvas.addNodes(paths.map((path) => this.fileCard(path)), at);
			return true;
		}
		const urls = (transfer.getData('text/uri-list') || transfer.getData('text/plain') || '')
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => /^https?:\/\/\S+$/i.test(line));
		if (urls.length) {
			this.canvas.addNodes(urls.map((url) => ({ type: 'link', url, ...FILE_CARD })), at);
			return true;
		}
		return false;
	}

	private showMenu(event: MouseEvent, target: { node?: CanvasNode; edge?: CanvasEdge; at: Point }): void {
		const canvas = this.canvas;
		if (!canvas) return;
		const menu = new Menu();
		const { nodes, edge } = canvas.getSelection();
		if (target.node || target.edge) {
			if (edge) {
				menu.addItem((item) =>
					item
						.setTitle('Edit label')
						.setIcon('pencil')
						.onClick(() => new LabelModal(this.app, edge.label ?? '', (label) => canvas.setEdgeLabel(edge, label)).open()),
				);
			} else if (nodes.length === 1) {
				const node = nodes[0]!;
				if (node.type === 'text' || node.type === 'group') menu.addItem((item) => item.setTitle(node.type === 'group' ? 'Edit label' : 'Edit').setIcon('pencil').onClick(() => canvas.edit(node)));
				if (node.type === 'file') menu.addItem((item) => item.setTitle('Open').setIcon('file').onClick(() => void this.openFileCard(node)));
				if (node.type === 'link') menu.addItem((item) => item.setTitle('Open link').setIcon('external-link').onClick(() => window.open(node.url, '_blank', 'noopener')));
			}
			menu.addItem((item) => {
				item.setTitle('Color').setIcon('palette');
				const colors = item.setSubmenu();
				colors.addItem((sub) => sub.setTitle('None').onClick(() => canvas.setColor(null)));
				for (const [id, name] of COLORS) {
					colors.addItem((sub) => {
						sub.setTitle(name).onClick(() => canvas.setColor(id));
						sub.dom.addClass('canvas-color-item', `mod-canvas-color-${id}`);
					});
				}
			});
			if (nodes.length) menu.addItem((item) => item.setTitle('Create group').setIcon('box-select').onClick(() => canvas.groupSelection()));
			menu.addSeparator();
			menu.addItem((item) => item.setTitle('Remove').setIcon('trash-2').setWarning(true).onClick(() => canvas.removeSelection()));
		} else {
			menu.addItem((item) => item.setTitle('Add card').setIcon('sticky-note').onClick(() => this.addCard(target.at)));
			menu.addItem((item) => item.setTitle('Add note from vault').setIcon('file-text').onClick(() => this.pickFile(false, target.at)));
			menu.addItem((item) => item.setTitle('Add media from vault').setIcon('image').onClick(() => this.pickFile(true, target.at)));
			menu.addSeparator();
			menu.addItem((item) => item.setTitle('Zoom to fit').setIcon('maximize').onClick(() => canvas.zoomToFit()));
		}
		menu.showAtMouseEvent(event);
	}

	/** Notes show their content, media the media, other files their name. */
	private renderFileCard(el: HTMLElement, node: FileNode): void {
		const file = this.app.vault.getFileByPath(node.file);
		el.empty();
		el.createDiv({ cls: 'canvas-file-name', text: node.file.slice(node.file.lastIndexOf('/') + 1) + (node.subpath ?? '') });
		if (!file) {
			el.addClass('is-unresolved');
			return;
		}
		if (file.extension === 'md') {
			const body = el.createDiv('canvas-file-preview markdown-rendered');
			void this.app.vault.cachedRead(file).then((text) => MarkdownRenderer.render(this.app, text, body, file.path, this));
			return;
		}
		const kind = mediaKind(file.extension);
		if (!kind) return;
		const body = el.createDiv(`canvas-file-media mod-${kind}`);
		void resourceUrl(this.app, file, this).then((src) => {
			const media = renderMedia(body, kind, src, { alt: file.name });
			if (kind === 'image') media.addClass('canvas-file-image');
		});
	}

	private async openFileCard(node: FileNode): Promise<void> {
		const file = this.app.vault.getFileByPath(node.file);
		if (file) await this.host.openFile(file);
		else new Notice(`${node.file} does not exist.`);
	}
}
