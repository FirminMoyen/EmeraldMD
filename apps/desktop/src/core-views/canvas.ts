/** `.canvas` files (JSON Canvas) in the main area, on @emeraldmd/canvas. */

import { MarkdownRenderer, Notice, TextFileView, type WorkspaceLeaf } from '@emeraldmd/api';
import { CANVAS_CSS, CanvasView, parseCanvas, serializeCanvas, type FileNode } from '@emeraldmd/canvas';
import type { CoreViewHost } from './host';

export const CANVAS_VIEW = 'canvas';
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

let stylesInstalled = false;
function installStyles(): void {
	if (stylesInstalled) return;
	stylesInstalled = true;
	const style = document.createElement('style');
	style.id = 'emeraldmd-canvas-styles';
	style.textContent = CANVAS_CSS;
	document.head.prepend(style);
}

export class CanvasFileView extends TextFileView {
	private canvas: CanvasView | null = null;
	/** Only write the file after an edit, so opening a canvas never reformats it. */
	private edited = false;

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
			},
		});
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
	}

	clear(): void {
		this.canvas?.setData({ nodes: [], edges: [] });
	}

	/** Notes show their content, images the picture, other files their name. */
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
		} else if (IMAGE.test(file.path)) {
			el.createEl('img', { cls: 'canvas-file-image', attr: { src: this.app.vault.getResourcePath(file), alt: file.name } });
		}
	}

	private async openFileCard(node: FileNode): Promise<void> {
		const file = this.app.vault.getFileByPath(node.file);
		if (file) await this.host.openFile(file);
		else new Notice(`${node.file} does not exist.`);
	}
}
