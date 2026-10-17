/**
 * Markdown rendering for plugins (`MarkdownRenderer.render`) and the
 * post-processor registry. Rendering uses the Lezer Markdown parser (GFM)
 * that the editor already ships; wikilinks, embeds and tags are recognised
 * in text. Raw HTML is passed through the sanitizer.
 */

import type { SyntaxNode } from '@lezer/common';
import { GFM, parser as baseParser } from '@lezer/markdown';
import type { TFile } from '@emeraldmd/core';
import type { App } from './app';
import { Component } from './component';
import { getFrontMatterInfo, parseYaml, sanitizeHTMLToDom } from './util';

const parser = baseParser.configure(GFM);

export interface MarkdownSectionInformation {
	text: string;
	lineStart: number;
	lineEnd: number;
}

export interface MarkdownPostProcessorContext {
	docId: string;
	sourcePath: string;
	frontmatter: unknown;
	addChild(child: MarkdownRenderChild): void;
	getSectionInfo(el: HTMLElement): MarkdownSectionInformation | null;
}

export interface MarkdownPostProcessor {
	(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<unknown> | void;
	sortOrder?: number;
}

export class MarkdownRenderChild extends Component {
	containerEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		super();
		this.containerEl = containerEl;
	}
}

const postProcessors: MarkdownPostProcessor[] = [];

export class MarkdownPreviewRenderer {
	static registerPostProcessor(postProcessor: MarkdownPostProcessor, sortOrder?: number): void {
		if (sortOrder !== undefined) postProcessor.sortOrder = sortOrder;
		postProcessors.push(postProcessor);
		postProcessors.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
	}

	static unregisterPostProcessor(postProcessor: MarkdownPostProcessor): void {
		const i = postProcessors.indexOf(postProcessor);
		if (i !== -1) postProcessors.splice(i, 1);
	}

	static createCodeBlockPostProcessor(
		language: string,
		handler: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<unknown> | void,
	): (el: HTMLElement, ctx: MarkdownPostProcessorContext) => void {
		return (el, ctx) => {
			for (const code of el.querySelectorAll<HTMLElement>(`pre > code.language-${CSS.escape(language)}`)) {
				const pre = code.parentElement!;
				const container = createDiv(`block-language-${language}`);
				pre.replaceWith(container);
				const source = (code.textContent ?? '').replace(/\n$/, '');
				try {
					const result = handler(source, container, ctx);
					if (result instanceof Promise) result.catch((err: unknown) => console.error(err));
				} catch (err) {
					console.error(err);
				}
			}
		};
	}
}

const INLINE_LINK = /(!?)\[\[([^[\]\n]+?)\]\]|(^|[\s(])(#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

/** Appends `text`, turning `[[wikilinks]]`, `![[embeds]]` and `#tags` into elements. */
function appendText(el: HTMLElement, text: string): void {
	let pos = 0;
	for (const match of text.matchAll(INLINE_LINK)) {
		const index = match.index;
		if (match[2] !== undefined) {
			if (index > pos) el.appendText(text.slice(pos, index));
			const [target = '', alias] = match[2].split('|');
			if (match[1]) {
				el.createSpan({ cls: 'internal-embed', attr: { src: target.trim(), alt: alias ?? target.trim() }, text: alias ?? target.trim() });
			} else {
				el.createEl('a', {
					cls: 'internal-link',
					text: (alias ?? target).trim(),
					attr: { 'data-href': target.trim(), href: target.trim(), target: '_blank', rel: 'noopener' },
				});
			}
			pos = index + match[0].length;
		} else if (match[4] !== undefined) {
			const tagStart = index + (match[3]?.length ?? 0);
			if (tagStart > pos) el.appendText(text.slice(pos, tagStart));
			el.createEl('a', { cls: 'tag', text: match[4], attr: { href: match[4], target: '_blank', rel: 'noopener' } });
			pos = tagStart + match[4].length;
		}
	}
	if (pos < text.length) el.appendText(text.slice(pos));
}

/** Removes whitespace at the start and end of `el`'s text (around heading marks, task markers). */
function trimEdges(el: HTMLElement): void {
	const first = el.firstChild;
	if (first?.nodeType === Node.TEXT_NODE) first.textContent = (first.textContent ?? '').replace(/^\s+/, '');
	const last = el.lastChild;
	if (last?.nodeType === Node.TEXT_NODE) last.textContent = (last.textContent ?? '').replace(/\s+$/, '');
}

const MARKS = new Set([
	'EmphasisMark',
	'CodeMark',
	'LinkMark',
	'HeaderMark',
	'QuoteMark',
	'ListMark',
	'URL',
	'LinkTitle',
	'LinkLabel',
	'CodeInfo',
	'StrikethroughMark',
	'TaskMarker',
	'TableDelimiter',
]);

class Renderer {
	constructor(private readonly src: string) {}

	block(node: SyntaxNode, parent: HTMLElement): void {
		const name = node.name;
		const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
		if (heading) {
			const h = parent.createEl(`h${heading[1]}` as 'h1');
			this.inline(node, h);
			trimEdges(h);
			return;
		}
		switch (name) {
			case 'Paragraph':
				this.inline(node, parent.createEl('p'));
				return;
			case 'Blockquote':
				this.children(node, parent.createEl('blockquote'));
				return;
			case 'BulletList':
			case 'OrderedList': {
				const list = parent.createEl(name === 'BulletList' ? 'ul' : 'ol');
				const start = node.firstChild?.getChild('ListMark');
				if (name === 'OrderedList' && start) {
					const n = parseInt(this.src.slice(start.from, start.to), 10);
					if (n !== 1 && !Number.isNaN(n)) list.setAttr('start', n);
				}
				this.children(node, list);
				return;
			}
			case 'ListItem': {
				const li = parent.createEl('li');
				const task = node.getChild('Task') ?? node.getChild('Paragraph')?.getChild('Task');
				if (task) {
					const marker = task.getChild('TaskMarker');
					const checked = marker ? /x/i.test(this.src.slice(marker.from, marker.to)) : false;
					li.addClass('task-list-item');
					if (checked) li.addClass('is-checked');
					li.dataset.task = checked ? 'x' : ' ';
					li.createEl('input', { type: 'checkbox', cls: 'task-list-item-checkbox', attr: { checked: checked || null, disabled: true } });
				}
				// Tight lists render their paragraph's content directly in the item.
				for (let child = node.firstChild; child; child = child.nextSibling) {
					if (child.name === 'ListMark') continue;
					if (child.name === 'Paragraph' || child.name === 'Task') this.inline(child, li);
					else this.block(child, li);
				}
				const afterCheckbox = task ? li.querySelector('input')?.nextSibling : null;
				if (afterCheckbox?.nodeType === Node.TEXT_NODE) afterCheckbox.textContent = (afterCheckbox.textContent ?? '').replace(/^\s+/, '');
				return;
			}
			case 'Task':
				this.inline(node, parent);
				return;
			case 'FencedCode':
			case 'CodeBlock': {
				const pre = parent.createEl('pre');
				const info = node.getChild('CodeInfo');
				const code = pre.createEl('code');
				if (info) code.addClass(`language-${this.src.slice(info.from, info.to).trim().split(/\s/)[0]}`);
				const texts = node.getChildren('CodeText');
				code.setText(texts.map((t) => this.src.slice(t.from, t.to)).join('\n') + (texts.length ? '\n' : ''));
				return;
			}
			case 'HorizontalRule':
				parent.createEl('hr');
				return;
			case 'HTMLBlock':
				parent.appendChild(sanitizeHTMLToDom(this.src.slice(node.from, node.to)));
				return;
			case 'Table': {
				const table = parent.createEl('table');
				const header = node.getChild('TableHeader');
				if (header) {
					const tr = table.createEl('thead').createEl('tr');
					for (const cell of header.getChildren('TableCell')) this.inline(cell, tr.createEl('th'));
				}
				const body = table.createEl('tbody');
				for (const row of node.getChildren('TableRow')) {
					const tr = body.createEl('tr');
					for (const cell of row.getChildren('TableCell')) this.inline(cell, tr.createEl('td'));
				}
				return;
			}
			case 'LinkReference':
			case 'CommentBlock':
				return;
			default:
				if (node.firstChild) this.children(node, parent);
				else this.inline(node, parent.createEl('p'));
		}
	}

	children(node: SyntaxNode, parent: HTMLElement): void {
		for (let child = node.firstChild; child; child = child.nextSibling) {
			if (MARKS.has(child.name)) continue;
			this.block(child, parent);
		}
	}

	/** Renders the inline content of `node` (its text and inline children) into `el`. */
	inline(node: SyntaxNode, el: HTMLElement): void {
		let pos = node.from;
		const text = (from: number, to: number) => {
			const t = this.src.slice(from, to).replace(/\n[ \t]*/g, '\n');
			if (t) appendText(el, t);
		};
		// Lezer reads `[[a|b]]` as a bracketed link; keep wikilinks as text so appendText handles them.
		const wikilinks = [...this.src.slice(node.from, node.to).matchAll(/!?\[\[[^[\]\n]+?\]\]/g)].map((m) => [
			node.from + m.index,
			node.from + m.index + m[0].length,
		]);
		for (let child = node.firstChild; child; child = child.nextSibling) {
			if (wikilinks.some(([from, to]) => child.from < to! && child.to > from!)) continue;
			if (child.from > pos) text(pos, child.from);
			this.inlineNode(child, el);
			pos = child.to;
		}
		if (pos < node.to) text(pos, node.to);
	}

	private inlineNode(node: SyntaxNode, el: HTMLElement): void {
		switch (node.name) {
			case 'Emphasis':
				this.inline(node, el.createEl('em'));
				return;
			case 'StrongEmphasis':
				this.inline(node, el.createEl('strong'));
				return;
			case 'Strikethrough':
				this.inline(node, el.createEl('del'));
				return;
			case 'InlineCode': {
				const marks = node.getChildren('CodeMark');
				const from = marks[0]?.to ?? node.from;
				const to = marks[1]?.from ?? node.to;
				el.createEl('code', { text: this.src.slice(from, to) });
				return;
			}
			case 'Link':
			case 'Image': {
				const url = node.getChild('URL');
				const href = url ? this.src.slice(url.from, url.to) : '';
				const marks = node.getChildren('LinkMark');
				const label = this.src.slice(marks[0]?.to ?? node.from, marks[1]?.from ?? node.to);
				if (node.name === 'Image') {
					el.createEl('img', { attr: { src: href, alt: label } });
				} else {
					const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
					const a = el.createEl('a', {
						cls: external ? 'external-link' : 'internal-link',
						attr: { href, target: '_blank', rel: 'noopener', 'data-href': external ? null : decodeURI(href) },
					});
					appendText(a, label);
				}
				return;
			}
			case 'Autolink': {
				const url = node.getChild('URL');
				const href = url ? this.src.slice(url.from, url.to) : '';
				el.createEl('a', { cls: 'external-link', text: href, attr: { href, target: '_blank', rel: 'noopener' } });
				return;
			}
			case 'URL': {
				const href = this.src.slice(node.from, node.to);
				el.createEl('a', { cls: 'external-link', text: href, attr: { href, target: '_blank', rel: 'noopener' } });
				return;
			}
			case 'HardBreak':
				el.createEl('br');
				return;
			case 'Escape':
				el.appendText(this.src.slice(node.from + 1, node.to));
				return;
			case 'Entity': {
				const span = document.createElement('span');
				span.innerHTML = this.src.slice(node.from, node.to);
				el.appendText(span.textContent ?? '');
				return;
			}
			case 'HTMLTag':
			case 'Comment':
				return;
			case 'TaskMarker':
				return;
			default:
				if (MARKS.has(node.name)) return;
				this.inline(node, el);
		}
	}
}

/** Renders Markdown into DOM elements appended to `el`, without post-processing. */
export function renderMarkdownToDom(markdown: string, el: HTMLElement): void {
	const tree = parser.parse(markdown);
	new Renderer(markdown).children(tree.topNode, el);
}

export abstract class MarkdownRenderer extends MarkdownRenderChild {
	app: App;
	hoverPopover: unknown = null;

	constructor(app: App, containerEl: HTMLElement) {
		super(containerEl);
		this.app = app;
	}

	abstract get file(): TFile;

	/** @deprecated Use `MarkdownRenderer.render`. */
	static renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> {
		return MarkdownRenderer.renderWith(null, markdown, el, sourcePath, component);
	}

	static render(app: App, markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> {
		return MarkdownRenderer.renderWith(app, markdown, el, sourcePath, component);
	}

	private static async renderWith(app: App | null, markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> {
		const fm = getFrontMatterInfo(markdown);
		let frontmatter: unknown = null;
		if (fm.exists) {
			try {
				frontmatter = parseYaml(fm.frontmatter);
			} catch {
				frontmatter = null;
			}
		}
		const body = fm.exists ? markdown.slice(fm.contentStart) : markdown;
		const wrapper = createDiv();
		renderMarkdownToDom(body, wrapper);
		const ctx: MarkdownPostProcessorContext = {
			docId: Math.random().toString(36).slice(2),
			sourcePath,
			frontmatter,
			addChild: (child) => component.addChild(child),
			getSectionInfo: () => null,
		};
		for (const pp of [...postProcessors]) {
			try {
				await pp(wrapper, ctx);
			} catch (err) {
				console.error(err);
			}
		}
		if (app) linkInternalLinks(app, wrapper, sourcePath);
		el.append(...wrapper.childNodes);
	}
}

/** Makes `.internal-link` elements open their note, and marks unresolved ones. */
function linkInternalLinks(app: App, el: HTMLElement, sourcePath: string): void {
	for (const a of el.querySelectorAll<HTMLElement>('a.internal-link')) {
		const href = a.dataset.href ?? a.getAttribute('href') ?? '';
		const linkpath = href.split('#')[0] ?? '';
		if (linkpath && !app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)) a.addClass('is-unresolved');
		a.addEventListener('click', (evt) => {
			evt.preventDefault();
			void app.workspace.openLinkText(href, sourcePath);
		});
	}
}
