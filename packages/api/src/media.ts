/**
 * Images, audio, video and PDFs, as Obsidian shows them: the file types of
 * each kind, a URL to load a file from (the vault's resource path, or a blob
 * of its bytes for server vaults), and the element that shows it (`<img>`,
 * `<audio>`, `<video>`, or a frame for PDFs). Used by embeds and by the
 * views that open these files in tabs.
 */

import type { TFile } from '@emeraldmd/core';
import type { App } from './app';
import type { Component } from './component';

export type MediaKind = 'image' | 'audio' | 'video' | 'pdf';

/** Extensions of each kind, as Obsidian supports them (`webm` plays in a video element, which also plays audio). */
export const MEDIA_EXTENSIONS: Record<MediaKind, string[]> = {
	image: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif'],
	audio: ['mp3', 'wav', 'm4a', '3gp', 'flac', 'ogg', 'oga', 'opus'],
	video: ['mp4', 'webm', 'ogv', 'mov', 'mkv'],
	pdf: ['pdf'],
};

const MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	bmp: 'image/bmp',
	svg: 'image/svg+xml',
	webp: 'image/webp',
	avif: 'image/avif',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	m4a: 'audio/mp4',
	'3gp': 'audio/3gpp',
	flac: 'audio/flac',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	opus: 'audio/ogg',
	mp4: 'video/mp4',
	webm: 'video/webm',
	ogv: 'video/ogg',
	mov: 'video/quicktime',
	mkv: 'video/x-matroska',
	pdf: 'application/pdf',
};

/** The kind of media a file extension is, or null. */
export function mediaKind(extension: string): MediaKind | null {
	const ext = extension.toLowerCase();
	return (Object.keys(MEDIA_EXTENSIONS) as MediaKind[]).find((kind) => MEDIA_EXTENSIONS[kind].includes(ext)) ?? null;
}

/** A URL to load `file` from: the vault's resource path, or a blob URL (released with `component`) for server vaults. */
export async function resourceUrl(app: App, file: TFile, component: Component): Promise<string> {
	const url = app.vault.getResourcePath(file);
	if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
	const type = MIME[file.extension.toLowerCase()] ?? 'application/octet-stream';
	const blobUrl = URL.createObjectURL(new Blob([await app.vault.readBinary(file)], { type }));
	component.register(() => URL.revokeObjectURL(blobUrl));
	return blobUrl;
}

export interface MediaOptions {
	/** Alt text of an image. */
	alt?: string;
	/** `400` or `400x300` from an embed's `|size`. */
	size?: string;
	/** The page of a PDF to show first. */
	page?: number;
}

/** The element that shows media of `kind` from `src`, added to `el`. */
export function renderMedia(el: HTMLElement, kind: MediaKind, src: string, options: MediaOptions = {}): HTMLElement {
	const size = /^(\d+)(?:x(\d+))?$/.exec(options.size?.trim() ?? '');
	const sized = (media: HTMLElement) => {
		if (size) {
			media.setAttr('width', size[1]!);
			if (size[2]) media.setAttr('height', size[2]);
		}
		return media;
	};
	switch (kind) {
		case 'image':
			return sized(el.createEl('img', { attr: { src, alt: options.alt ?? '' } }));
		case 'audio':
			return el.createEl('audio', { attr: { src, controls: 'true', preload: 'metadata' } });
		case 'video':
			return sized(el.createEl('video', { attr: { src, controls: 'true', preload: 'metadata' } }));
		case 'pdf':
			return el.createEl('iframe', { cls: 'pdf-frame', attr: { src: options.page ? `${src}#page=${options.page}` : src, title: options.alt ?? 'PDF' } });
	}
}
