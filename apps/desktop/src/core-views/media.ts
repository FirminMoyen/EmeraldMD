/**
 * Images, audio, video and PDFs in tabs, as Obsidian's `image`, `audio`,
 * `video` and `pdf` views: the file fills the view (images fit, players
 * centred, PDFs in the system's viewer), and is shown again when it
 * changes on disk.
 */

import { Component, FileView, MEDIA_EXTENSIONS, renderMedia, resourceUrl, type MediaKind, type WorkspaceLeaf } from '@emeraldmd/api';
import type { TAbstractFile, TFile } from '@emeraldmd/core';

const ICONS: Record<MediaKind, string> = { image: 'image', audio: 'file-audio', video: 'file-video', pdf: 'file-text' };

export const MEDIA_KINDS = Object.keys(MEDIA_EXTENSIONS) as MediaKind[];

export class MediaFileView extends FileView {
	private shown = new Component();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly kind: MediaKind,
	) {
		super(leaf);
		this.icon = ICONS[kind];
	}

	getViewType(): string {
		return this.kind;
	}

	override canAcceptExtension(extension: string): boolean {
		return MEDIA_EXTENSIONS[this.kind].includes(extension.toLowerCase());
	}

	override getDisplayText(): string {
		return this.file?.name ?? 'No file';
	}

	protected override async onOpen(): Promise<void> {
		this.contentEl.addClass('media-view', `${this.kind}-view`);
		this.registerEvent(
			this.app.vault.on('modify', (file: TAbstractFile) => {
				if (file === this.file) void this.show(this.file);
			}),
		);
	}

	protected override async onClose(): Promise<void> {
		this.shown.unload();
	}

	override async onLoadFile(file: TFile): Promise<void> {
		await this.show(file);
	}

	override async onUnloadFile(): Promise<void> {
		this.shown.unload();
		this.contentEl.empty();
	}

	private async show(file: TFile): Promise<void> {
		this.shown.unload();
		this.shown = new Component();
		this.shown.load();
		const shown = this.shown;
		const url = await resourceUrl(this.app, file, shown);
		if (shown !== this.shown || file !== this.file) return;
		this.contentEl.empty();
		const container = this.contentEl.createDiv(`${this.kind}-container`);
		renderMedia(container, this.kind, url, { alt: file.name });
	}
}
