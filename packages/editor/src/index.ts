/**
 * Markdown editor on CodeMirror 6, in source mode or Live Preview
 * (./live-preview.ts). Token classes (`cm-header-1`, `cm-strong`,
 * `cm-hashtag`, …) and line classes (`HyperMD-header-1`…) use the names
 * community themes style, so existing themes apply.
 */

import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension, type StateEffect } from '@codemirror/state';
import {
	Decoration,
	type DecorationSet,
	drawSelection,
	EditorView,
	keymap,
	lineNumbers,
	MatchDecorator,
	placeholder,
	ViewPlugin,
	type ViewUpdate,
} from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { tags as t } from '@lezer/highlight';
import { obsidianMarkdown } from '@emeraldmd/core';
import { lineClasses, livePreview, type LivePreviewOptions } from './live-preview';

export { lineClasses, livePreview, type LivePreviewOptions } from './live-preview';

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
	// YAML frontmatter (properties).
	{ tag: [t.propertyName, t.definition(t.propertyName)], class: 'cm-hmd-frontmatter cm-property' },
	{ tag: [t.string, t.number, t.bool, t.null, t.atom], class: 'cm-hmd-frontmatter cm-value' },
	{ tag: [t.separator, t.punctuation, t.squareBracket, t.brace], class: 'cm-hmd-frontmatter cm-punctuation' },
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

/** The vault's editor settings (app.json), as the editor applies them. */
export interface EditorSettings {
	/** `showLineNumber` */
	lineNumbers: boolean;
	/** `spellcheck` */
	spellcheck: boolean;
	/** `tabSize` */
	tabSize: number;
	/** `useTab`: indent with tabs rather than spaces. */
	useTab: boolean;
	/** `autoPairBrackets` */
	autoPairBrackets: boolean;
	/** `readableLineLength`: the `is-readable-line-width` class on the container. */
	readableLineLength: boolean;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
	lineNumbers: false,
	spellcheck: false,
	tabSize: 4,
	useTab: true,
	autoPairBrackets: true,
	readableLineLength: true,
};

function settingsExtensions(settings: EditorSettings): Extension {
	return [
		settings.lineNumbers ? lineNumbers() : [],
		settings.autoPairBrackets ? closeBrackets() : [],
		EditorState.tabSize.of(settings.tabSize),
		indentUnit.of(settings.useTab ? '\t' : ' '.repeat(settings.tabSize)),
		EditorView.contentAttributes.of({ spellcheck: String(settings.spellcheck), autocorrect: settings.spellcheck ? 'on' : 'off' }),
	];
}

export interface MarkdownEditorOptions {
	parent: HTMLElement;
	onChange?: (text: string) => void;
	/** Cmd/Ctrl-click on a wikilink. */
	onOpenLink?: (linktext: string) => void;
	/** Files pasted or dropped into the editor, with the document position to insert at. */
	onFiles?: (files: File[], pos: number) => void;
	/** A click on a rendered external link in Live Preview. */
	onOpenUrl?: (url: string) => void;
	/** Rendering of embeds, callouts and tables in Live Preview. */
	livePreview?: LivePreviewOptions;
}

export class MarkdownEditor {
	readonly view: EditorView;
	private readonly extensions: Extension[];
	/** Extensions added from outside (plugins), kept across documents. */
	private readonly extra = new Compartment();
	private extraExtensions: Extension = [];
	private readonly mode = new Compartment();
	private readonly settingsCompartment = new Compartment();
	private settings: EditorSettings = DEFAULT_EDITOR_SETTINGS;
	private readonly livePreviewExtension: Extension;
	private livePreviewOn = false;
	private readonly parent: HTMLElement;

	constructor(options: MarkdownEditorOptions) {
		this.parent = options.parent;
		this.livePreviewExtension = livePreview(options.livePreview);
		this.extensions = [
			history(),
			drawSelection(),
			indentOnInput(),
			highlightSelectionMatches(),
			EditorView.lineWrapping,
			// Frontmatter is YAML, not Markdown (otherwise `key: value` above `---` reads as a heading).
			// Math and footnotes are part of the grammar, as in the renderer, so `$a_1 * b$` is not read as emphasis.
			yamlFrontmatter({ content: markdown({ base: markdownLanguage, extensions: obsidianMarkdown }) }),
			syntaxHighlighting(markdownHighlight),
			decorate(WIKILINK, 'cm-hmd-internal-link'),
			decorate(TAG, 'cm-hashtag'),
			lineClasses(),
			placeholder('Start writing…'),
			keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
			EditorView.updateListener.of((update) => {
				if (update.docChanged) options.onChange?.(update.state.doc.toString());
			}),
			EditorView.domEventHandlers({
				paste: (event, view) => {
					const files = [...(event.clipboardData?.files ?? [])];
					if (!files.length || !options.onFiles) return false;
					event.preventDefault();
					options.onFiles(files, view.state.selection.main.head);
					return true;
				},
				drop: (event, view) => {
					const files = [...(event.dataTransfer?.files ?? [])];
					if (!files.length || !options.onFiles) return false;
					event.preventDefault();
					options.onFiles(files, view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head);
					return true;
				},
				mousedown: (event, view) => {
					// Live Preview: a click on a rendered link follows it.
					const target = event.target instanceof Element ? event.target : null;
					const rendered = this.livePreviewOn && event.button === 0 ? target?.closest<HTMLElement>('[data-lp-link], [data-lp-href]') : null;
					if (rendered && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
						const { lpLink: link, lpHref: href } = rendered.dataset;
						if (link !== undefined && options.onOpenLink) options.onOpenLink(link);
						else if (href !== undefined && options.onOpenUrl) options.onOpenUrl(href);
						else return false;
						event.preventDefault();
						return true;
					}
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
		this.parent.classList.toggle('is-readable-line-width', this.settings.readableLineLength);
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

	/** Applies the vault's editor settings. */
	configure(settings: EditorSettings): void {
		this.settings = settings;
		this.parent.classList.toggle('is-readable-line-width', settings.readableLineLength);
		this.view.dispatch({ effects: this.settingsCompartment.reconfigure(settingsExtensions(settings)) });
	}

	isLivePreview(): boolean {
		return this.livePreviewOn;
	}

	/** Switches between Live Preview and source mode. `effects` go out in the same transaction. */
	setLivePreview(on: boolean, effects: StateEffect<unknown>[] = []): void {
		this.livePreviewOn = on;
		this.parent.classList.toggle('is-live-preview', on);
		this.view.dispatch({ effects: [this.mode.reconfigure(on ? this.livePreviewExtension : []), ...effects] });
	}

	/** Replaces the extensions added from outside (plugin editor extensions). */
	setExtensions(extensions: Extension): void {
		this.extraExtensions = extensions;
		this.view.dispatch({ effects: this.extra.reconfigure(extensions) });
	}

	focus(): void {
		this.view.focus();
	}

	destroy(): void {
		this.view.destroy();
	}

	private createState(doc: string): EditorState {
		return EditorState.create({
			doc,
			extensions: [
				this.extensions,
				this.settingsCompartment.of(settingsExtensions(this.settings)),
				this.mode.of(this.livePreviewOn ? this.livePreviewExtension : []),
				this.extra.of(this.extraExtensions),
			],
		});
	}
}
