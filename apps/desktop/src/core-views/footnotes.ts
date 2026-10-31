/**
 * Footnotes of the active note (Obsidian's "Footnotes view"): each footnote
 * in the order it is first referenced, with its text rendered; footnotes
 * that are defined but never referenced, or referenced but never defined,
 * are marked. A click shows the footnote's definition in the note; the
 * arrows next to it show each reference.
 */

import { Component, debounce, ItemView, MarkdownRenderer, setIcon, type WorkspaceLeaf } from '@emeraldmd/api';
import type { TFile } from '@emeraldmd/core';
import type { CoreViewHost } from './host';

export const FOOTNOTES_VIEW = 'footnotes';

export interface Footnote {
	/** The label (`1`, `note`), or `^` and its position for inline footnotes (`^[text]`). */
	id: string;
	inline: boolean;
	/** The footnote's text; null when it is referenced but not defined. */
	text: string | null;
	/** Where its definition (or the inline footnote) starts. */
	at: number | null;
	/** Where each reference is. */
	refs: { from: number; to: number }[];
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** Offsets of text in fenced code blocks and inline code, where `[^x]` is not a footnote. */
function codeRanges(text: string): [number, number][] {
	const ranges: [number, number][] = [];
	let offset = 0;
	let fence: { marker: string; start: number } | null = null;
	for (const line of text.split('\n')) {
		const m = FENCE.exec(line);
		if (fence) {
			if (m && m[1]![0] === fence.marker[0] && m[1]!.length >= fence.marker.length) {
				ranges.push([fence.start, offset + line.length]);
				fence = null;
			}
		} else if (m) {
			fence = { marker: m[1]!, start: offset };
		}
		offset += line.length + 1;
	}
	if (fence) ranges.push([fence.start, text.length]);
	for (const m of text.matchAll(/(`+)[^`\n]+?\1/g)) ranges.push([m.index, m.index + m[0].length]);
	return ranges;
}

/** The note's footnotes: by first reference, then those only defined. */
export function footnotesOf(text: string): Footnote[] {
	const code = codeRanges(text);
	const inCode = (at: number) => code.some(([from, to]) => at >= from && at < to);
	const byId = new Map<string, Footnote>();
	const order: Footnote[] = [];
	const get = (id: string) => {
		let note = byId.get(id.toLowerCase());
		if (!note) {
			note = { id, inline: false, text: null, at: null, refs: [] };
			byId.set(id.toLowerCase(), note);
		}
		return note;
	};
	// Definitions: `[^id]: text`, continued by indented lines.
	const lines = text.split('\n');
	let offset = 0;
	const definitionStarts = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		const m = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/.exec(lines[i]!);
		if (m && !inCode(offset)) {
			const parts = [m[2]!];
			let end = offset + lines[i]!.length + 1;
			while (i + 1 < lines.length && /^( {2,}|\t)\S/.test(lines[i + 1]!)) {
				i++;
				parts.push(lines[i]!.trim());
				end += lines[i]!.length + 1;
			}
			const note = get(m[1]!);
			if (note.text === null) {
				note.text = parts.join('\n');
				note.at = offset;
			}
			definitionStarts.add(offset);
			offset = end;
			continue;
		}
		offset += lines[i]!.length + 1;
	}
	// References `[^id]` (not the label of a definition) and inline footnotes `^[text]`, in order.
	for (const m of text.matchAll(/\[\^([^\]\s]+)\](?!:)|\^\[((?:[^[\]]|\[[^\]]*\])+)\]/g)) {
		if (inCode(m.index)) continue;
		if (m[1] !== undefined) {
			const note = get(m[1]);
			note.refs.push({ from: m.index, to: m.index + m[0].length });
			if (!order.includes(note)) order.push(note);
		} else {
			const note: Footnote = { id: `^${m.index}`, inline: true, text: m[2]!, at: m.index, refs: [{ from: m.index, to: m.index + m[0].length }] };
			order.push(note);
		}
	}
	for (const note of byId.values()) if (!order.includes(note)) order.push(note);
	return order;
}

export class FootnotesView extends ItemView {
	private readonly refresh = debounce(() => void this.render(), 300, true);
	private rendered = new Component();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: CoreViewHost,
	) {
		super(leaf);
		this.icon = 'superscript';
	}

	getViewType(): string {
		return FOOTNOTES_VIEW;
	}

	getDisplayText(): string {
		return 'Footnotes';
	}

	protected override async onOpen(): Promise<void> {
		this.contentEl.addClass('footnotes-view');
		this.registerEvent(this.app.workspace.on('file-open', () => void this.render()));
		this.registerEvent(
			this.app.vault.on('modify', (file: TFile) => {
				if (file === this.app.workspace.getActiveFile()) this.refresh();
			}),
		);
		await this.render();
	}

	protected override async onClose(): Promise<void> {
		this.rendered.unload();
	}

	private async render(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		const text = file?.extension === 'md' ? await this.app.vault.cachedRead(file).catch(() => null) : null;
		this.rendered.unload();
		this.rendered = new Component();
		this.rendered.load();
		const root = this.contentEl;
		root.empty();
		const notes = text === null ? [] : footnotesOf(text);
		if (!file || !notes.length) {
			root.createDiv({ cls: 'pane-empty', text: file ? 'No footnotes in this note.' : 'No note is open.' });
			return;
		}
		const list = root.createEl('ol', { cls: 'footnotes-list' });
		let number = 0;
		for (const note of notes) {
			const item = list.createEl('li', { cls: 'footnotes-item tree-item-self is-clickable' });
			const referenced = note.refs.length > 0;
			item.createSpan({ cls: 'footnotes-number', text: referenced ? String(++number) : '–' });
			const body = item.createDiv('footnotes-text markdown-rendered');
			if (note.text === null) {
				item.addClass('is-undefined');
				body.setText(`[^${note.id}] is not defined.`);
			} else {
				void MarkdownRenderer.render(this.app, note.text, body, file.path, this.rendered);
			}
			if (!referenced) {
				item.addClass('is-unreferenced');
				item.setAttr('title', 'Not referenced in the note');
			}
			const refs = item.createDiv('footnotes-refs');
			note.refs.forEach((ref, i) => {
				if (note.inline) return;
				const back = refs.createSpan({ cls: 'footnotes-ref clickable-icon', attr: { 'aria-label': `Reference ${i + 1}` } });
				setIcon(back, 'corner-down-right');
				back.addEventListener('click', (evt) => {
					evt.stopPropagation();
					void this.host.openFile(file, ref);
				});
			});
			item.addEventListener('click', (evt) => {
				if ((evt.target as Element).closest('a')) return;
				const at = note.at ?? note.refs[0]?.from;
				if (at !== undefined && at !== null) void this.host.openFile(file, { from: at, to: at });
			});
		}
	}
}
