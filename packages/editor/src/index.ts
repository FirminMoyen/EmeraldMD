/**
 * Markdown source editor on CodeMirror 6. Token classes (`cm-header-1`,
 * `cm-strong`, `cm-hashtag`, …) use the names community themes style, so
 * existing themes apply. Live Preview comes later as an extra extension.
 */

import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, indentOnInput, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
	Decoration,
	type DecorationSet,
	drawSelection,
	EditorView,
	keymap,
	MatchDecorator,
	placeholder,
	ViewPlugin,
	type ViewUpdate,
} from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { tags as t } from '@lezer/highlight';

const markdownHighlight = HighlightStyle.define([
	{ tag: t.heading1, class: 'cm-header cm-header-1' },
	{ tag: t.heading2, class: 'cm-header cm-header-2' },
	{ tag: t.heading3, class: 'cm-header cm-header-3' },
	{ tag: t.heading4, class: 'cm-header cm-header-4' },
	{ tag: t.heading5, class: 'cm-header cm-header-5' },
	{ tag: t.heading6, class: 'cm-header cm-header-6' },
	{ tag: t.strong, class: 'cm-strong' },
	{ tag: t.emphasis, class: 'cm-em' },
	{ tag: t.strikethrough, class: 'cm-strikethrough' },
	{ tag: t.link, class: 'cm-link' },
	{ tag: t.url, class: 'cm-url' },
	{ tag: t.monospace, class: 'cm-inline-code' },
	{ tag: t.quote, class: 'cm-quote' },
	{ tag: t.list, class: 'cm-list' },
	{ tag: t.contentSeparator, class: 'cm-hr' },
	{ tag: [t.processingInstruction, t.meta], class: 'cm-formatting' },
]);

/** True inside fenced, indented or inline code, where links and tags are plain text. */
function inCode(view: EditorView, pos: number): boolean {
	for (let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1); node; node = node.parent) {
		if (node.name.includes('Code')) return true;
	}
	return false;
}

/** Marks every match of `regexp` outside code, minus the text captured by its optional `lead` group. */
function decorate(regexp: RegExp, className: string): Extension {
	const mark = Decoration.mark({ class: className });
	const matcher = new MatchDecorator({
		regexp,
		decorate: (add, from, to, match, view) => {
			const start = from + (match.groups?.lead?.length ?? 0);
			if (!inCode(view, start)) add(start, to, mark);
		},
	});
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = matcher.createDeco(view);
			}
			update(update: ViewUpdate) {
				this.decorations = matcher.updateDeco(update, this.decorations);
			}
		},
		{ decorations: (plugin) => plugin.decorations },
	);
}

const WIKILINK = /!?\[\[[^[\]\n]+?\]\]/g;
// Same tag rule as crates/emerald-core/src/metadata.rs: at least one non-digit.
// No lookbehind, so it runs on older WebKit (macOS/iOS webviews).
const TAG = /(?<lead>^|\s)#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*/gu;

/** The link text (without alias) of the wikilink under `col`, if any. */
export function wikilinkAt(lineText: string, col: number): string | null {
	for (const match of lineText.matchAll(WIKILINK)) {
		const start = match.index;
		if (col >= start && col <= start + match[0].length) {
			const inner = match[0].replace(/^!?\[\[|\]\]$/g, '');
			return inner.split('|')[0]!.trim();
		}
	}
	return null;
}

export interface MarkdownEditorOptions {
	parent: HTMLElement;
	onChange?: (text: string) => void;
	/** Cmd/Ctrl-click on a wikilink. */
	onOpenLink?: (linktext: string) => void;
}

export class MarkdownEditor {
	readonly view: EditorView;
	private readonly extensions: Extension[];

	constructor(options: MarkdownEditorOptions) {
		this.extensions = [
			history(),
			drawSelection(),
			indentOnInput(),
			closeBrackets(),
			highlightSelectionMatches(),
			EditorView.lineWrapping,
			markdown({ base: markdownLanguage }),
			syntaxHighlighting(markdownHighlight),
			decorate(WIKILINK, 'cm-hmd-internal-link'),
			decorate(TAG, 'cm-hashtag'),
			placeholder('Start writing…'),
			keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
			EditorView.updateListener.of((update) => {
				if (update.docChanged) options.onChange?.(update.state.doc.toString());
			}),
			EditorView.domEventHandlers({
				mousedown: (event, view) => {
					if (!(event.metaKey || event.ctrlKey) || !options.onOpenLink) return false;
					const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
					if (pos === null) return false;
					const line = view.state.doc.lineAt(pos);
					const link = wikilinkAt(line.text, pos - line.from);
					if (link === null) return false;
					event.preventDefault();
					options.onOpenLink(link);
					return true;
				},
			}),
		];
		this.view = new EditorView({ parent: options.parent, state: this.createState('') });
	}

	getValue(): string {
		return this.view.state.doc.toString();
	}

	/** Replaces the document and resets undo history (used when switching files). */
	setValue(text: string): void {
		this.view.setState(this.createState(text));
	}

	/** Replaces the document but keeps undo history and the cursor where possible (external edits). */
	replaceValue(text: string): void {
		const head = Math.min(this.view.state.selection.main.head, text.length);
		this.view.dispatch({
			changes: { from: 0, to: this.view.state.doc.length, insert: text },
			selection: { anchor: head },
		});
	}

	focus(): void {
		this.view.focus();
	}

	destroy(): void {
		this.view.destroy();
	}

	private createState(doc: string): EditorState {
		return EditorState.create({ doc, extensions: this.extensions });
	}
}
