/**
 * The `Editor` facade plugins use for text edits, implemented over a
 * CodeMirror 6 `EditorView` (exposed as `editor.cm`, as plugins expect).
 * Positions are `{ line, ch }` with 0-based lines.
 */

import {
	cursorCharLeft,
	cursorCharRight,
	cursorDocEnd,
	cursorDocStart,
	cursorGroupLeft,
	cursorGroupRight,
	cursorLineDown,
	cursorLineUp,
	deleteLine,
	indentLess,
	indentMore,
	insertNewlineAndIndent,
	moveLineDown,
	moveLineUp,
	redo,
	undo,
} from '@codemirror/commands';
import { foldAll, toggleFold, unfoldAll } from '@codemirror/language';
import { EditorSelection as CMSelection, StateField, type ChangeSpec, type Extension, type Text } from '@codemirror/state';
import { EditorView, ViewPlugin, type Command as CMCommand } from '@codemirror/view';
import type { App } from './app';
import type { TFile } from '@emeraldmd/core';

export interface EditorPosition {
	line: number;
	ch: number;
}

export interface EditorRange {
	from: EditorPosition;
	to: EditorPosition;
}

export interface EditorSelection {
	anchor: EditorPosition;
	head: EditorPosition;
}

export interface EditorSelectionOrCaret {
	anchor: EditorPosition;
	head?: EditorPosition;
}

export interface EditorRangeOrCaret {
	from: EditorPosition;
	to?: EditorPosition;
}

export interface EditorChange extends EditorRangeOrCaret {
	text: string;
}

export interface EditorTransaction {
	replaceSelection?: string;
	changes?: EditorChange[];
	selections?: EditorRangeOrCaret[];
	selection?: EditorRangeOrCaret;
}

export type EditorCommandName =
	| 'goUp'
	| 'goDown'
	| 'goLeft'
	| 'goRight'
	| 'goStart'
	| 'goEnd'
	| 'goWordLeft'
	| 'goWordRight'
	| 'indentMore'
	| 'indentLess'
	| 'newlineAndIndent'
	| 'swapLineUp'
	| 'swapLineDown'
	| 'deleteLine'
	| 'toggleFold'
	| 'foldAll'
	| 'unfoldAll';

export abstract class Editor {
	getDoc(): this {
		return this;
	}

	abstract refresh(): void;
	abstract getValue(): string;
	abstract setValue(content: string): void;
	abstract getLine(line: number): string;

	setLine(n: number, text: string): void {
		this.replaceRange(text, { line: n, ch: 0 }, { line: n, ch: this.getLine(n).length });
	}

	abstract lineCount(): number;
	abstract lastLine(): number;
	abstract getSelection(): string;

	somethingSelected(): boolean {
		return this.getSelection().length > 0;
	}

	abstract getRange(from: EditorPosition, to: EditorPosition): string;
	abstract replaceSelection(replacement: string, origin?: string): void;
	abstract replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition, origin?: string): void;
	abstract getCursor(side?: 'from' | 'to' | 'head' | 'anchor'): EditorPosition;
	abstract listSelections(): EditorSelection[];

	setCursor(pos: EditorPosition | number, ch?: number): void {
		const p = typeof pos === 'number' ? { line: pos, ch: ch ?? 0 } : pos;
		this.setSelection(p, p);
	}

	abstract setSelection(anchor: EditorPosition, head?: EditorPosition): void;
	abstract setSelections(ranges: EditorSelectionOrCaret[], main?: number): void;
	abstract focus(): void;
	abstract blur(): void;
	abstract hasFocus(): boolean;
	abstract getScrollInfo(): { top: number; left: number };
	abstract scrollTo(x?: number | null, y?: number | null): void;
	abstract scrollIntoView(range: EditorRange, center?: boolean): void;
	abstract undo(): void;
	abstract redo(): void;
	abstract exec(command: EditorCommandName): void;
	abstract transaction(tx: EditorTransaction, origin?: string): void;
	abstract wordAt(pos: EditorPosition): EditorRange | null;
	abstract posToOffset(pos: EditorPosition): number;
	abstract offsetToPos(offset: number): EditorPosition;

	processLines<T>(
		read: (line: number, lineText: string) => T | null,
		write: (line: number, lineText: string, value: T | null) => EditorChange | void,
		ignoreEmpty = false,
	): void {
		const values: (T | null)[] = [];
		const lines: number[] = [];
		const selections = this.listSelections();
		const seen = new Set<number>();
		for (const sel of selections) {
			const from = Math.min(sel.anchor.line, sel.head.line);
			const to = Math.max(sel.anchor.line, sel.head.line);
			for (let line = from; line <= to; line++) {
				if (seen.has(line)) continue;
				seen.add(line);
				const text = this.getLine(line);
				if (ignoreEmpty && text.trim() === '') continue;
				lines.push(line);
				values.push(read(line, text));
			}
		}
		const changes: EditorChange[] = [];
		lines.forEach((line, i) => {
			const change = write(line, this.getLine(line), values[i] ?? null);
			if (change) changes.push(change);
		});
		if (changes.length) this.transaction({ changes });
	}
}

function offsetIn(doc: Text, pos: EditorPosition): number {
	if (pos.line < 0) return 0;
	if (pos.line >= doc.lines) return doc.length;
	const line = doc.line(pos.line + 1);
	return line.from + Math.max(0, Math.min(pos.ch, line.length));
}

const COMMANDS: Record<EditorCommandName, CMCommand> = {
	goUp: cursorLineUp,
	goDown: cursorLineDown,
	goLeft: cursorCharLeft,
	goRight: cursorCharRight,
	goStart: cursorDocStart,
	goEnd: cursorDocEnd,
	goWordLeft: cursorGroupLeft,
	goWordRight: cursorGroupRight,
	indentMore,
	indentLess,
	newlineAndIndent: insertNewlineAndIndent,
	swapLineUp: moveLineUp,
	swapLineDown: moveLineDown,
	deleteLine,
	toggleFold,
	foldAll,
	unfoldAll,
};

/** `Editor` over a CodeMirror 6 view. */
export class CodeMirrorEditor extends Editor {
	readonly cm: EditorView;

	constructor(cm: EditorView) {
		super();
		this.cm = cm;
	}

	private get doc() {
		return this.cm.state.doc;
	}

	refresh(): void {
		this.cm.requestMeasure();
	}

	getValue(): string {
		return this.doc.toString();
	}

	setValue(content: string): void {
		this.cm.dispatch({ changes: { from: 0, to: this.doc.length, insert: content } });
	}

	getLine(line: number): string {
		if (line < 0 || line >= this.doc.lines) return '';
		return this.doc.line(line + 1).text;
	}

	lineCount(): number {
		return this.doc.lines;
	}

	lastLine(): number {
		return this.doc.lines - 1;
	}

	getSelection(): string {
		const { from, to } = this.cm.state.selection.main;
		return this.cm.state.sliceDoc(from, to);
	}

	getRange(from: EditorPosition, to: EditorPosition): string {
		const a = this.posToOffset(from);
		const b = this.posToOffset(to);
		return this.cm.state.sliceDoc(Math.min(a, b), Math.max(a, b));
	}

	replaceSelection(replacement: string, origin?: string): void {
		this.cm.dispatch(this.cm.state.replaceSelection(replacement), { userEvent: origin ?? 'input' });
	}

	replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition, origin?: string): void {
		const a = this.posToOffset(from);
		const b = to ? this.posToOffset(to) : a;
		this.cm.dispatch({ changes: { from: Math.min(a, b), to: Math.max(a, b), insert: replacement }, userEvent: origin });
	}

	getCursor(side: 'from' | 'to' | 'head' | 'anchor' = 'head'): EditorPosition {
		const sel = this.cm.state.selection.main;
		const offset = side === 'from' ? sel.from : side === 'to' ? sel.to : side === 'anchor' ? sel.anchor : sel.head;
		return this.offsetToPos(offset);
	}

	listSelections(): EditorSelection[] {
		return this.cm.state.selection.ranges.map((r) => ({ anchor: this.offsetToPos(r.anchor), head: this.offsetToPos(r.head) }));
	}

	setSelection(anchor: EditorPosition, head?: EditorPosition): void {
		const a = this.posToOffset(anchor);
		this.cm.dispatch({ selection: { anchor: a, head: head ? this.posToOffset(head) : a }, scrollIntoView: true });
	}

	setSelections(ranges: EditorSelectionOrCaret[], main?: number): void {
		if (ranges.length === 0) return;
		const cmRanges = ranges.map((r) => {
			const anchor = this.posToOffset(r.anchor);
			return CMSelection.range(anchor, r.head ? this.posToOffset(r.head) : anchor);
		});
		this.cm.dispatch({ selection: CMSelection.create(cmRanges, main ?? 0), scrollIntoView: true });
	}

	focus(): void {
		this.cm.focus();
	}

	blur(): void {
		this.cm.contentDOM.blur();
	}

	hasFocus(): boolean {
		return this.cm.hasFocus;
	}

	getScrollInfo(): { top: number; left: number; width: number; height: number; clientWidth: number; clientHeight: number } {
		const s = this.cm.scrollDOM;
		return { top: s.scrollTop, left: s.scrollLeft, width: s.scrollWidth, height: s.scrollHeight, clientWidth: s.clientWidth, clientHeight: s.clientHeight };
	}

	scrollTo(x?: number | null, y?: number | null): void {
		if (typeof x === 'number') this.cm.scrollDOM.scrollLeft = x;
		if (typeof y === 'number') this.cm.scrollDOM.scrollTop = y;
	}

	scrollIntoView(range: EditorRange, center = false): void {
		const from = this.posToOffset(range.from);
		const to = this.posToOffset(range.to);
		this.cm.dispatch({ effects: EditorView.scrollIntoView(CMSelection.range(from, to), { y: center ? 'center' : 'nearest' }) });
	}

	undo(): void {
		undo(this.cm);
	}

	redo(): void {
		redo(this.cm);
	}

	exec(command: EditorCommandName): void {
		COMMANDS[command]?.(this.cm);
	}

	transaction(tx: EditorTransaction, origin?: string): void {
		const changes: ChangeSpec[] = (tx.changes ?? []).map((c) => {
			const from = this.posToOffset(c.from);
			const to = c.to ? this.posToOffset(c.to) : from;
			return { from: Math.min(from, to), to: Math.max(from, to), insert: c.text };
		});
		if (tx.replaceSelection !== undefined) {
			for (const r of this.cm.state.selection.ranges) changes.push({ from: r.from, to: r.to, insert: tx.replaceSelection });
		}
		const selections = tx.selections ?? (tx.selection ? [tx.selection] : null);
		const changeSet = this.cm.state.changes(changes);
		// Selections are given in terms of the document after the changes.
		const after = changeSet.apply(this.doc);
		const selection = selections
			? CMSelection.create(
					selections.map((s) => {
						const from = offsetIn(after, s.from);
						return CMSelection.range(from, s.to ? offsetIn(after, s.to) : from);
					}),
				)
			: undefined;
		this.cm.dispatch({ changes: changeSet, selection, userEvent: origin, scrollIntoView: selection !== undefined });
	}

	wordAt(pos: EditorPosition): EditorRange | null {
		const range = this.cm.state.wordAt(this.posToOffset(pos));
		return range ? { from: this.offsetToPos(range.from), to: this.offsetToPos(range.to) } : null;
	}

	posToOffset(pos: EditorPosition): number {
		return offsetIn(this.doc, pos);
	}

	offsetToPos(offset: number): EditorPosition {
		const clamped = Math.max(0, Math.min(offset, this.doc.length));
		const line = this.doc.lineAt(clamped);
		return { line: line.number - 1, ch: clamped - line.from };
	}
}

/** What an editor shows: the app, the file and the `Editor`. */
export interface MarkdownFileInfo {
	app: App;
	readonly file: TFile | null;
	editor?: Editor;
	hoverPopover: unknown;
}

/** Holds the `MarkdownFileInfo` of the editor a CodeMirror state belongs to. Initialised with `.init()`. */
export const editorInfoField = StateField.define<MarkdownFileInfo>({
	create: () => null as unknown as MarkdownFileInfo,
	update: (value) => value,
});

/** Same as `editorInfoField` (older name). */
export const editorViewField = editorInfoField;

export const editorEditorField = StateField.define<EditorView>({
	create: () => null as unknown as EditorView,
	update: (value) => value,
});

/** EmeraldMD edits in source mode only, for now. */
export const editorLivePreviewField = StateField.define<boolean>({
	create: () => false,
	update: (value) => value,
});

export interface LivePreviewStateType {
	mousedown: boolean;
}

export const livePreviewState = ViewPlugin.define<LivePreviewStateType & { destroy?: () => void }>(() => ({ mousedown: false }));

/** The CodeMirror extensions that make the fields above available in an editor. */
export function editorInfoExtensions(info: MarkdownFileInfo, view: () => EditorView): Extension {
	return [
		editorInfoField.init(() => info),
		editorEditorField.init(() => view()),
		editorLivePreviewField.init(() => false),
		livePreviewState,
	];
}
