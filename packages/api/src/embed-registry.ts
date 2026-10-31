/**
 * `app.embedRegistry`: how `![[file]]` embeds of a file type are drawn, by
 * extension. Core plugins (Bases) and community plugins register creators;
 * a creator returns a Component that draws into `context.containerEl` and
 * is unloaded with the rendered Markdown.
 */

import { Events, type TFile } from '@emeraldmd/core';
import type { App } from './app';
import type { Component } from './component';

export interface EmbedContext {
	app: App;
	containerEl: HTMLElement;
	/** The embed's link text, as written. */
	linktext: string;
	/** The note the embed is in. */
	sourcePath: string;
	displayText?: string;
	depth?: number;
	showInline?: boolean;
	state?: unknown;
}

export type EmbedCreator = (context: EmbedContext, file: TFile, subpath: string) => Component;

export class EmbedRegistry extends Events {
	embedByExtension: Record<string, EmbedCreator> = {};

	registerExtension(extension: string, creator: EmbedCreator): void {
		if (this.embedByExtension[extension]) throw new Error(`Attempting to register an existing embed extension "${extension}"`);
		this.embedByExtension[extension] = creator;
	}

	registerExtensions(extensions: string[], creator: EmbedCreator): void {
		for (const ext of extensions) this.registerExtension(ext, creator);
	}

	unregisterExtension(extension: string): void {
		delete this.embedByExtension[extension];
	}

	unregisterExtensions(extensions: string[]): void {
		for (const ext of extensions) this.unregisterExtension(ext);
	}

	isExtensionRegistered(extension: string): boolean {
		return extension in this.embedByExtension;
	}

	getEmbedCreator(file: TFile): EmbedCreator | null {
		return this.embedByExtension[file.extension] ?? null;
	}
}
