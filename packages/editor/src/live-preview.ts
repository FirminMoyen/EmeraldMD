/**
 * Live Preview: Markdown shown formatted while it is edited.
 *
 * - Formatting marks (`#`, `**`, `` ` ``, `==`, `[[`/`]]`, `[`/`](url)`, `>`)
 *   are hidden, except where the selection touches the element they belong
 *   to, so the source comes back where the cursor is.
 * - Bullets, task checkboxes and horizontal rules are drawn as widgets;
 *   checkboxes toggle on click.
 * - Images, embeds (`![[…]]`), callouts and tables are rendered like the
 *   reading view (through `renderMarkdown`); clicking one puts the cursor in
 *   its source.
 *
 * Class names are the ones themes style: `.cm-hmd-internal-link`,
 * `.list-bullet`, `.task-list-item-checkbox`, `.cm-highlight`, `.cm-callout`,
 * `.cm-embed-block`. Line classes (`HyperMD-header-1`, `HyperMD-quote`,
 * `HyperMD-codeblock`, `HyperMD-list-line`, `HyperMD-task-line`) come from
 * `lineClasses()`, used in both modes.
 */

import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, type Range, StateEffect, StateField, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';

export interface LivePreviewOptions {
	/**
	 * Renders Markdown (an image, an embed, a callout, a table) into `el` the
	 * way the reading view does. May return a cleanup function, called when
	 * the widget is removed.
	 */
	renderMarkdown?: (markdown: string, el: HTMLElement) => void | (() => void);
	/** Whether a wikilink target exists; unresolved links get `is-unresolved`. */
	isResolved?: (linktext: string) => boolean;
	/**
	 * Draws the frontmatter (its YAML) as a properties editor in `el`.
	 * `update` shows changed YAML in the same element (false: draw it anew).
	 * Without it, the frontmatter is text.
	 */
	renderProperties?: (yaml: string, el: HTMLElement) => PropertiesHandle | null;
	/** Whether `yaml` can be drawn as properties; invalid YAML stays as text, to be fixed. */
	validProperties?: (yaml: string) => boolean;
	/** Obsidian's "Properties in document": `visible` (the default), `hidden` or `source` (YAML as text). */
	propertiesInDocument?: () => 'visible' | 'hidden' | 'source';
}

export interface PropertiesHandle {
	update(yaml: string): boolean;
	destroy?(): void;
}

/** Recomputes Live Preview's blocks after a setting they depend on changed. */
export const refreshLivePreview = StateEffect.define<null>();

/** The frontmatter at the top of `doc`: its YAML, where its closing `---` line ends, and where the note's body starts. */
export function frontmatterAt(doc: Text): { yaml: string; to: number; body: number } | null {
	if (doc.lines < 2 || !/^---\s*$/.test(doc.line(1).text)) return null;
	for (let n = 2; n <= Math.min(doc.lines, 2000); n++) {
		const line = doc.line(n);
		if (!/^---\s*$/.test(line.text)) continue;
		const yaml = n === 2 ? '' : doc.sliceString(doc.line(2).from, doc.line(n - 1).to);
		return { yaml, to: line.to, body: n < doc.lines ? doc.line(n + 1).from : line.to };
	}
	return null;
}

const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const HIGHLIGHT = /==(?=\S)([^=\n]*?\S)==/g;
const CALLOUT_LINE = /^\s*>\s*\[![^\]\s]+\][+-]?/;

const hidden = Decoration.replace({});

/** Whether any selection range touches `[from, to]`. */
function touches(state: EditorState, from: number, to: number): boolean {
	return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function lineTouched(state: EditorState, pos: number): boolean {
	const line = state.doc.lineAt(pos);
	return touches(state, line.from, line.to);
}

/** True inside code, where Markdown is plain text. */
function inCode(state: EditorState, pos: number): boolean {
	for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
		if (node.name.includes('Code') || node.name === 'CodeText') return true;
	}
	return false;
}

class BulletWidget extends WidgetType {
	override eq(): boolean {
		return true;
	}

	toDOM(): HTMLElement {
		const outer = document.createElement('span');
		outer.className = 'cm-formatting cm-formatting-list cm-formatting-list-ul';
		const bullet = outer.appendChild(document.createElement('span'));
		bullet.className = 'list-bullet';
		return outer;
	}
}

class CheckboxWidget extends WidgetType {
	constructor(readonly checked: boolean) {
		super();
	}

	override eq(other: CheckboxWidget): boolean {
		return other.checked === this.checked;
	}

	toDOM(view: EditorView): HTMLElement {
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.className = 'task-list-item-checkbox';
		box.checked = this.checked;
		box.addEventListener('mousedown', (event) => {
			event.preventDefault();
			// The marker is `[ ]`: the character after the bracket is the task's state.
			const pos = view.posAtDOM(box) + 1;
			view.dispatch({ changes: { from: pos, to: pos + 1, insert: this.checked ? ' ' : 'x' } });
		});
		return box;
	}

	override ignoreEvent(): boolean {
		return true;
	}
}

class RuleWidget extends WidgetType {
	override eq(): boolean {
		return true;
	}

	toDOM(): HTMLElement {
		const el = document.createElement('span');
		el.className = 'cm-hr-widget';
		el.appendChild(document.createElement('hr'));
		return el;
	}
}

/** Rendered Markdown: images, embeds, callouts and tables. */
class MarkdownWidget extends WidgetType {
	private static cleanups = new WeakMap<HTMLElement, () => void>();

	constructor(
		readonly markdown: string,
		readonly className: string,
		readonly block: boolean,
		readonly render: NonNullable<LivePreviewOptions['renderMarkdown']>,
	) {
		super();
	}

	override eq(other: MarkdownWidget): boolean {
		return other.markdown === this.markdown && other.className === this.className;
	}

	toDOM(): HTMLElement {
		const el = document.createElement(this.block ? 'div' : 'span');
		el.className = `${this.className} markdown-rendered`;
		try {
			const cleanup = this.render(this.markdown, el);
			if (cleanup) MarkdownWidget.cleanups.set(el, cleanup);
		} catch (err) {
			console.error(err);
			el.textContent = this.markdown;
		}
		return el;
	}

	override destroy(dom: HTMLElement): void {
		MarkdownWidget.cleanups.get(dom)?.();
		MarkdownWidget.cleanups.delete(dom);
	}

	/** Links inside work; any other click goes to the editor, which moves the cursor into the source. */
	override ignoreEvent(event: Event): boolean {
		return event.target instanceof Element && Boolean(event.target.closest('a, input, button'));
	}

	override get estimatedHeight(): number {
		return this.block ? 60 : -1;
	}
}

/** The frontmatter as a properties editor. */
class PropertiesWidget extends WidgetType {
	private static handles = new WeakMap<HTMLElement, PropertiesHandle>();

	constructor(
		readonly yaml: string,
		readonly render: NonNullable<LivePreviewOptions['renderProperties']>,
	) {
		super();
	}

	override eq(other: PropertiesWidget): boolean {
		return other.yaml === this.yaml;
	}

	toDOM(): HTMLElement {
		const el = document.createElement('div');
		el.className = 'cm-properties-widget';
		const handle = this.render(this.yaml, el);
		if (handle) PropertiesWidget.handles.set(el, handle);
		return el;
	}

	/** The same editor shows the new YAML, so a field being edited keeps the focus. */
	override updateDOM(dom: HTMLElement): boolean {
		return PropertiesWidget.handles.get(dom)?.update(this.yaml) ?? false;
	}

	override destroy(dom: HTMLElement): void {
		PropertiesWidget.handles.get(dom)?.destroy?.();
		PropertiesWidget.handles.delete(dom);
	}

	/** The properties editor handles its own clicks and keys. */
	override ignoreEvent(): boolean {
		return true;
	}

	override get estimatedHeight(): number {
		return 120;
	}
}

/** Whether the frontmatter is drawn as properties (or hidden) rather than shown as YAML. */
function propertiesShown(options: LivePreviewOptions, yaml: string): 'visible' | 'hidden' | null {
	const mode = options.propertiesInDocument?.() ?? 'visible';
	if (mode === 'source' || !options.renderProperties) return null;
	if (mode === 'hidden') return 'hidden';
	return options.validProperties?.(yaml) === false ? null : 'visible';
}

/** Inline decorations for the visible part of the document. */
function inlineDecorations(view: EditorView, options: LivePreviewOptions): DecorationSet {
	const { state } = view;
	const { doc } = state;
	const ranges: Range<Decoration>[] = [];
	// A view plugin may not replace line breaks; elements that span lines stay as source.
	const oneLine = (from: number, to: number) => doc.lineAt(from).number === doc.lineAt(to).number;
	const hide = (from: number, to: number) => {
		if (to > from && oneLine(from, to)) ranges.push(hidden.range(from, to));
	};
	const replace = (from: number, to: number, widget: WidgetType) => {
		if (oneLine(from, to)) ranges.push(Decoration.replace({ widget }).range(from, to));
	};
	/** Hides a block mark (`#`, `>`) and the space after it. */
	const hideWithSpace = (from: number, to: number) => hide(from, doc.sliceString(to, to + 1) === ' ' ? to + 1 : to);

	for (const { from, to } of view.visibleRanges) {
		syntaxTree(state).iterate({
			from,
			to,
			enter: (node: SyntaxNodeRef) => {
				switch (node.name) {
					case 'FencedCode':
					case 'CodeBlock':
					case 'HTMLBlock':
					case 'CommentBlock':
						return false;
					case 'HeaderMark':
						if (node.node.parent?.name.startsWith('ATXHeading') && !lineTouched(state, node.from)) hideWithSpace(node.from, node.to);
						break;
					case 'QuoteMark':
						if (!lineTouched(state, node.from)) hideWithSpace(node.from, node.to);
						break;
					case 'EmphasisMark':
					case 'StrikethroughMark': {
						const parent = node.node.parent;
						if (parent && !touches(state, parent.from, parent.to)) hide(node.from, node.to);
						break;
					}
					case 'CodeMark': {
						const parent = node.node.parent;
						if (parent?.name === 'InlineCode' && !touches(state, parent.from, parent.to)) hide(node.from, node.to);
						break;
					}
					case 'ListMark': {
						const item = node.node.parent;
						if (item?.parent?.name !== 'BulletList' || touches(state, node.from, node.to)) break;
						// Tasks show their checkbox instead of a bullet.
						if (item.getChild('Task')) hideWithSpace(node.from, node.to);
						else replace(node.from, node.to, new BulletWidget());
						break;
					}
					case 'TaskMarker':
						if (!touches(state, node.from, node.to)) {
							const checked = doc.sliceString(node.from + 1, node.from + 2) !== ' ';
							replace(node.from, node.to, new CheckboxWidget(checked));
						}
						break;
					case 'HorizontalRule':
						if (!lineTouched(state, node.from)) replace(node.from, node.to, new RuleWidget());
						return false;
					case 'Link': {
						if (touches(state, node.from, node.to)) return false;
						const marks = node.node.getChildren('LinkMark');
						const url = node.node.getChild('URL');
						if (marks.length < 2 || !url || !oneLine(node.from, node.to)) return false;
						const [open, close] = [marks[0]!, marks[1]!];
						hide(node.from, open.to);
						ranges.push(
							Decoration.mark({ class: 'cm-link cm-underline', attributes: { 'data-lp-href': doc.sliceString(url.from, url.to) } }).range(open.to, close.from),
						);
						hide(close.from, node.to);
						return false;
					}
					case 'InlineMath':
						if (options.renderMarkdown && !touches(state, node.from, node.to)) {
							replace(node.from, node.to, new MarkdownWidget(doc.sliceString(node.from, node.to), 'cm-math', false, options.renderMarkdown));
						}
						return false;
					case 'FootnoteRef':
					case 'InlineFootnote':
						ranges.push(Decoration.mark({ class: 'cm-footref' }).range(node.from, node.to));
						return false;
					case 'Image':
						if (options.renderMarkdown && !touches(state, node.from, node.to)) {
							replace(node.from, node.to, new MarkdownWidget(doc.sliceString(node.from, node.to), 'cm-embed-image', false, options.renderMarkdown));
						}
						return false;
				}
				return undefined;
			},
		});

		// Wikilinks, embeds and highlights are not in the Markdown syntax tree.
		for (let pos = from; pos <= to; ) {
			const line = doc.lineAt(pos);
			for (const match of line.text.matchAll(WIKILINK)) {
				const start = line.from + match.index;
				const end = start + match[0].length;
				if (touches(state, start, end) || inCode(state, start)) continue;
				const [, bang, inner] = match as unknown as [string, string, string];
				if (bang) {
					if (!options.renderMarkdown) continue;
					replace(start, end, new MarkdownWidget(match[0], 'cm-embed-block', false, options.renderMarkdown));
					continue;
				}
				const pipe = inner.indexOf('|');
				const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
				const textFrom = pipe === -1 ? start + 2 : start + 2 + pipe + 1;
				hide(start, textFrom);
				const resolved = options.isResolved?.(target) ?? true;
				ranges.push(
					Decoration.mark({ class: resolved ? 'cm-hmd-internal-link' : 'cm-hmd-internal-link is-unresolved', attributes: { 'data-lp-link': target } }).range(textFrom, end - 2),
				);
				hide(end - 2, end);
			}
			for (const match of line.text.matchAll(HIGHLIGHT)) {
				const start = line.from + match.index;
				const end = start + match[0].length;
				if (inCode(state, start)) continue;
				const shown = touches(state, start, end);
				if (!shown) hide(start, start + 2);
				ranges.push(Decoration.mark({ class: 'cm-highlight' }).range(start + 2, end - 2));
				if (!shown) hide(end - 2, end);
			}
			pos = line.to + 1;
		}
	}
	return Decoration.set(ranges, true);
}

/** The widget class for blocks drawn rendered: callouts, tables, `$$` math and Mermaid diagrams. */
function blockWidgetClass(state: EditorState, node: SyntaxNode): string | null {
	switch (node.name) {
		case 'Table':
			return 'cm-table-widget';
		case 'BlockMath':
			return 'cm-math-block';
		case 'Blockquote':
			return CALLOUT_LINE.test(state.doc.lineAt(node.from).text) ? 'cm-callout' : null;
		case 'FencedCode': {
			const info = node.getChild('CodeInfo');
			return info && state.doc.sliceString(info.from, info.to).trim().split(/\s/)[0] === 'mermaid' ? 'cm-mermaid' : null;
		}
		default:
			return null;
	}
}

/** Callouts, tables, `$$` math and Mermaid diagrams, drawn as rendered blocks while the selection is outside them. */
function blockDecorations(state: EditorState, options: LivePreviewOptions): DecorationSet {
	const render = options.renderMarkdown;
	const ranges: Range<Decoration>[] = [];
	const frontmatter = frontmatterAt(state.doc);
	const shown = frontmatter && propertiesShown(options, frontmatter.yaml);
	if (frontmatter && shown === 'visible') {
		ranges.push(Decoration.replace({ widget: new PropertiesWidget(frontmatter.yaml, options.renderProperties!), block: true }).range(0, frontmatter.to));
	} else if (frontmatter && shown === 'hidden') {
		ranges.push(Decoration.replace({ block: true }).range(0, frontmatter.to));
	}
	if (!render) return Decoration.set(ranges);
	// The Markdown `Document` is mounted under the frontmatter grammar's; only its top-level blocks are visited.
	syntaxTree(state).iterate({
		enter: (node) => {
			if (node.name === 'Document') return undefined;
			if (node.node.parent?.name !== 'Document') return false;
			const className = blockWidgetClass(state, node.node);
			if (!className) return false;
			const from = state.doc.lineAt(node.from).from;
			const to = state.doc.lineAt(node.to).to;
			if (!touches(state, from, to)) {
				const widget = new MarkdownWidget(state.doc.sliceString(from, to), className, true, render);
				ranges.push(Decoration.replace({ widget, block: true }).range(from, to));
			}
			return false;
		},
	});
	return Decoration.set(ranges, true);
}

/** The Live Preview extension. Add it to an editor to switch from source mode to Live Preview. */
export function livePreview(options: LivePreviewOptions = {}) {
	const inline = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = inlineDecorations(view, options);
			}
			update(update: ViewUpdate) {
				const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
				if (update.docChanged || update.selectionSet || update.viewportChanged || treeChanged || update.focusChanged) {
					this.decorations = inlineDecorations(update.view, options);
				}
			}
		},
		{ decorations: (plugin) => plugin.decorations },
	);
	// Block widgets must come from state, not from a view plugin.
	const blocks = StateField.define<DecorationSet>({
		create: (state) => blockDecorations(state, options),
		update(decorations, tr) {
			const refresh = tr.effects.some((e) => e.is(refreshLivePreview));
			if (refresh || tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return blockDecorations(tr.state, options);
			return decorations;
		},
		provide: (field) => EditorView.decorations.from(field),
	});
	// The cursor stays out of frontmatter drawn as properties (typing there would break it).
	const outOfProperties = EditorState.transactionFilter.of((tr) => {
		if (!tr.selection && !tr.docChanged) return tr;
		const frontmatter = frontmatterAt(tr.newDoc);
		if (!frontmatter || !propertiesShown(options, frontmatter.yaml)) return tr;
		const selection = tr.newSelection;
		if (selection.ranges.every((r) => r.from >= frontmatter.body)) return tr;
		const clamp = (pos: number) => Math.max(pos, frontmatter.body);
		const moved = EditorSelection.create(
			selection.ranges.map((r) => EditorSelection.range(clamp(r.anchor), clamp(r.head))),
			selection.mainIndex,
		);
		return [tr, { selection: moved, sequential: true }];
	});
	return [inline, blocks, outOfProperties, EditorView.editorAttributes.of({ class: 'is-live-preview' })];
}

/**
 * Line classes for headings, quotes, code blocks, list items and tasks, which
 * themes style (`HyperMD-header-1`, `HyperMD-codeblock-begin`…). Used in source
 * mode and Live Preview.
 */
export function lineClasses() {
	const build = (view: EditorView): DecorationSet => {
		const { state } = view;
		const lines = new Map<number, string[]>();
		const attrs = new Map<number, Record<string, string>>();
		const add = (pos: number, ...classes: string[]) => {
			const line = state.doc.lineAt(pos).from;
			lines.set(line, [...(lines.get(line) ?? []), ...classes]);
		};
		const eachLine = (from: number, to: number, cb: (pos: number, first: boolean, last: boolean) => void) => {
			const first = state.doc.lineAt(from).number;
			const last = state.doc.lineAt(to).number;
			for (let n = first; n <= last; n++) cb(state.doc.line(n).from, n === first, n === last);
		};
		for (const { from, to } of view.visibleRanges) {
			syntaxTree(state).iterate({
				from,
				to,
				enter: (node) => {
					const heading = /^ATXHeading(\d)$/.exec(node.name);
					if (heading) add(node.from, 'HyperMD-header', `HyperMD-header-${heading[1]}`);
					else if (node.name === 'Blockquote') eachLine(node.from, node.to, (pos) => add(pos, 'HyperMD-quote'));
					else if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
						eachLine(node.from, node.to, (pos, first, last) =>
							add(pos, 'HyperMD-codeblock', 'HyperMD-codeblock-bg', ...(first ? ['HyperMD-codeblock-begin'] : []), ...(last ? ['HyperMD-codeblock-end'] : [])),
						);
						return false;
					} else if (node.name === 'ListItem') {
						let depth = 0;
						for (let p = node.node.parent; p; p = p.parent) if (p.name === 'BulletList' || p.name === 'OrderedList') depth++;
						add(node.from, 'HyperMD-list-line', `HyperMD-list-line-${depth}`);
					} else if (node.name === 'Task') {
						add(node.from, 'HyperMD-task-line');
						const marker = state.doc.sliceString(node.from + 1, node.from + 2);
						attrs.set(state.doc.lineAt(node.from).from, { 'data-task': marker });
					}
					return undefined;
				},
			});
		}
		const ranges = [...lines].map(([pos, classes]) =>
			Decoration.line({ class: [...new Set(classes)].join(' '), attributes: attrs.get(pos) }).range(pos),
		);
		return Decoration.set(ranges, true);
	};
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = build(view);
			}
			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
					this.decorations = build(update.view);
				}
			}
		},
		{ decorations: (plugin) => plugin.decorations },
	);
}
