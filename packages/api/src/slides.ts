/**
 * Slides (core plugin `slides`, off by default as in Obsidian): presents a
 * note as slides, one per part between `---` lines, rendered like the
 * reading view, full screen. Arrow keys, Space and Page Up/Down move between
 * slides, Home and End go to the first and last, Escape ends. The
 * presentation starts at the slide with the cursor.
 */

import type { App } from './app';
import { Component } from './component';
import { InternalPluginInstance } from './core-plugins';
import { setIcon } from './icons';
import { MarkdownRenderer } from './markdown';
import { Modal } from './modal';
import { getFrontMatterInfo } from './util';

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const SEPARATOR = /^\s{0,3}---\s*$/;

/** A note's slides, and where each starts in the note's text. */
export function splitSlides(text: string): { text: string; start: number }[] {
	const info = getFrontMatterInfo(text);
	const body = info.exists ? info.contentStart : 0;
	const slides: { text: string; start: number }[] = [];
	let start = body;
	let offset = body;
	let fence: string | null = null;
	let previousBlank = true;
	for (const line of text.slice(body).split('\n')) {
		const m = FENCE.exec(line);
		if (fence) {
			if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = null;
		} else if (m) {
			fence = m[1]!;
		} else if (SEPARATOR.test(line) && previousBlank) {
			// Only after a blank line: right under text, `---` makes that text a heading.
			slides.push({ text: text.slice(start, offset), start });
			start = offset + line.length + 1;
		}
		previousBlank = line.trim() === '';
		offset += line.length + 1;
	}
	slides.push({ text: text.slice(start), start });
	return slides.filter((s) => s.text.trim() !== '').map((s) => ({ text: s.text.trim(), start: s.start }));
}

class SlidesModal extends Modal {
	private index: number;
	private rendered = new Component();
	private slideEl!: HTMLElement;
	private counterEl!: HTMLElement;

	constructor(
		app: App,
		private readonly slides: string[],
		private readonly sourcePath: string,
		start: number,
	) {
		super(app);
		this.index = Math.max(0, Math.min(start, slides.length - 1));
		this.containerEl.addClass('mod-slides');
		this.modalEl.addClass('slides-container');
		const move = (by: number) => () => {
			this.show(this.index + by);
			return false;
		};
		for (const key of ['ArrowRight', 'ArrowDown', 'PageDown', ' ']) this.scope.register([], key, move(1));
		for (const key of ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace']) this.scope.register([], key, move(-1));
		this.scope.register([], 'Home', () => (this.show(0), false));
		this.scope.register([], 'End', () => (this.show(this.slides.length - 1), false));
	}

	override onOpen(): void {
		this.titleEl.remove();
		this.slideEl = this.contentEl.createDiv('slides-content markdown-rendered');
		const nav = this.contentEl.createDiv('slides-nav');
		const button = (icon: string, label: string, by: number) => {
			const el = nav.createDiv({ cls: 'clickable-icon slides-nav-button', attr: { 'aria-label': label } });
			setIcon(el, icon);
			el.addEventListener('click', () => this.show(this.index + by));
		};
		button('chevron-left', 'Previous slide', -1);
		this.counterEl = nav.createSpan('slides-counter');
		button('chevron-right', 'Next slide', 1);
		void document.documentElement.requestFullscreen?.().catch(() => {});
		this.show(this.index);
	}

	override onClose(): void {
		this.rendered.unload();
		if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
	}

	private show(index: number): void {
		this.index = Math.max(0, Math.min(index, this.slides.length - 1));
		this.rendered.unload();
		this.rendered = new Component();
		this.rendered.load();
		this.slideEl.empty();
		void MarkdownRenderer.render(this.app, this.slides[this.index]!, this.slideEl, this.sourcePath, this.rendered);
		this.counterEl.setText(`${this.index + 1} / ${this.slides.length}`);
	}
}

export class Slides extends InternalPluginInstance {
	readonly id = 'slides';
	readonly name = 'Slides';
	readonly description = 'Present a note as slides, separated by --- lines.';

	onEnable(): void {
		this.addCommand({
			id: 'slides:start',
			name: 'Slides: Start presentation',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (file?.extension !== 'md') return false;
				if (!checking) void this.present();
				return true;
			},
		});
	}

	/** Presents the active note, from the slide with the cursor. */
	async present(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		const editor = this.app.workspace.activeEditor?.file === file ? this.app.workspace.activeEditor.editor : undefined;
		const text = editor?.getValue() ?? (await this.app.vault.cachedRead(file));
		const slides = splitSlides(text);
		if (!slides.length) return;
		const cursor = editor ? editor.posToOffset(editor.getCursor()) : 0;
		const start = Math.max(0, slides.findLastIndex((s) => s.start <= cursor));
		new SlidesModal(
			this.app,
			slides.map((s) => s.text),
			file.path,
			start,
		).open();
	}
}
