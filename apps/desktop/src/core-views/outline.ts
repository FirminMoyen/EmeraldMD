/**
 * Headings of the active note (right sidebar), as Obsidian's outline: a
 * tree that folds, a filter, the heading the cursor is under marked as
 * current, a click to jump, and headings dragged onto others to move their
 * whole section (with its subsections) before them.
 */

import { debounce, ItemView, setIcon, type WorkspaceLeaf } from '@emeraldmd/api';
import type { HeadingCache, TFile } from '@emeraldmd/core';
import type { CoreViewHost } from './host';

export const OUTLINE_VIEW = 'outline';

interface Node {
	heading: HeadingCache;
	index: number;
	children: Node[];
}

/** The headings as a tree, by level. */
function treeOf(headings: HeadingCache[]): Node[] {
	const roots: Node[] = [];
	const stack: Node[] = [];
	headings.forEach((heading, index) => {
		const node: Node = { heading, index, children: [] };
		while (stack.length && stack[stack.length - 1]!.heading.level >= heading.level) stack.pop();
		(stack.length ? stack[stack.length - 1]!.children : roots).push(node);
		stack.push(node);
	});
	return roots;
}

/** Where the section of heading `i` ends: at the next heading of the same or a higher level, or the end. */
export function sectionEnd(headings: HeadingCache[], i: number, length: number): number {
	const level = headings[i]!.level;
	const next = headings.slice(i + 1).find((h) => h.level <= level);
	return next ? next.position.start.offset : length;
}

/**
 * `text` with the section of heading `from` moved before heading `to`.
 * Null when that changes nothing or `to` is inside the moved section.
 */
export function moveSection(text: string, headings: HeadingCache[], from: number, to: number): string | null {
	const start = headings[from]!.position.start.offset;
	const end = sectionEnd(headings, from, text.length);
	const target = headings[to]!.position.start.offset;
	if (target >= start && target < end) return null;
	let section = text.slice(start, end);
	if (!section.endsWith('\n')) section += '\n';
	const rest = text.slice(0, start) + text.slice(end);
	const at = target > start ? target - (end - start) : target;
	if (at === start) return null;
	return rest.slice(0, at) + section + rest.slice(at);
}

export class OutlineView extends ItemView {
	private readonly refresh = debounce(() => this.render(), 200, true);
	private readonly collapsed = new Set<string>();
	private filter = '';
	private filterEl: HTMLInputElement | null = null;
	private treeEl!: HTMLElement;
	/** The file and cursor offset the current heading is for. */
	private cursor: { file: TFile; offset: number } | null = null;
	private dragged: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: CoreViewHost,
	) {
		super(leaf);
		this.icon = 'list';
	}

	getViewType(): string {
		return OUTLINE_VIEW;
	}

	getDisplayText(): string {
		return 'Outline';
	}

	protected override async onOpen(): Promise<void> {
		this.contentEl.addClass('outline-view');
		const header = this.contentEl.createDiv('nav-header');
		const buttons = header.createDiv('nav-buttons-container');
		const button = (icon: string, label: string, onClick: () => void) => {
			const el = buttons.createDiv({ cls: 'clickable-icon nav-action-button', attr: { 'aria-label': label } });
			setIcon(el, icon);
			el.addEventListener('click', onClick);
			return el;
		};
		const search = button('search', 'Show search filter', () => {
			if (this.filterEl) {
				this.filterEl.parentElement!.remove();
				this.filterEl = null;
				this.filter = '';
				search.removeClass('is-active');
				this.render();
				return;
			}
			search.addClass('is-active');
			const row = header.createDiv('search-input-container');
			this.filterEl = row.createEl('input', { type: 'search', placeholder: 'Filter…', attr: { spellcheck: 'false' } });
			this.filterEl.addEventListener('input', () => {
				this.filter = this.filterEl!.value.trim().toLowerCase();
				this.render();
			});
			this.filterEl.focus();
		});
		button('chevrons-down-up', 'Collapse all', () => {
			const file = this.app.workspace.getActiveFile();
			const headings = file ? (this.app.metadataCache.getFileCache(file)?.headings ?? []) : [];
			const walk = (nodes: Node[]) => nodes.forEach((n) => (n.children.length && this.collapsed.add(this.key(n)), walk(n.children)));
			walk(treeOf(headings));
			this.render();
		});
		button('chevrons-up-down', 'Expand all', () => {
			this.collapsed.clear();
			this.render();
		});
		this.treeEl = this.contentEl.createDiv('outline-tree');
		this.registerEvent(this.app.workspace.on('file-open', () => this.render()));
		this.registerEvent(
			this.app.metadataCache.on('changed', (file: TFile) => {
				if (file === this.app.workspace.getActiveFile()) this.refresh();
			}),
		);
		this.registerEvent(
			this.app.workspace.on('emerald:cursor', (file: TFile, offset: number) => {
				this.cursor = { file, offset };
				this.markCurrent();
			}),
		);
		this.render();
	}

	/** A heading's key for folding: its text and its place among the same headings. */
	private key(node: Node): string {
		return `${node.heading.level}:${node.heading.heading}:${node.index}`;
	}

	private render(): void {
		const root = this.treeEl;
		root.empty();
		const file = this.app.workspace.getActiveFile();
		const headings = file ? (this.app.metadataCache.getFileCache(file)?.headings ?? []) : [];
		if (!file || !headings.length) {
			root.createDiv({ cls: 'pane-empty', text: file ? 'No headings in this note.' : 'No note is open.' });
			return;
		}
		const matches = (node: Node): boolean => !this.filter || node.heading.heading.toLowerCase().includes(this.filter) || node.children.some(matches);
		const draw = (parent: HTMLElement, nodes: Node[]) => {
			for (const node of nodes) {
				if (!matches(node)) continue;
				const item = parent.createDiv('tree-item');
				const self = item.createDiv({ cls: 'tree-item-self is-clickable outline-item', attr: { 'data-index': String(node.index), draggable: 'true' } });
				const collapsed = this.collapsed.has(this.key(node)) && !this.filter;
				if (node.children.length) {
					self.addClass('mod-collapsible');
					const toggle = self.createDiv('tree-item-icon collapse-icon');
					setIcon(toggle, 'right-triangle');
					item.toggleClass('is-collapsed', collapsed);
					toggle.addEventListener('click', (event) => {
						event.stopPropagation();
						if (collapsed) this.collapsed.delete(this.key(node));
						else this.collapsed.add(this.key(node));
						this.render();
					});
				}
				self.createDiv({ cls: 'tree-item-inner', text: node.heading.heading });
				self.addEventListener('click', () => {
					const at = node.heading.position.start.offset;
					void this.host.openFile(file, { from: at, to: at });
				});
				this.draggable(self, file, headings, node.index);
				if (node.children.length && !collapsed) draw(item.createDiv('tree-item-children'), node.children);
			}
		};
		draw(root, treeOf(headings));
		this.markCurrent();
	}

	/** Marks the heading whose section holds the cursor. */
	private markCurrent(): void {
		const file = this.app.workspace.getActiveFile();
		for (const el of this.treeEl.querySelectorAll('.outline-item.is-active')) el.removeClass('is-active');
		if (!file || this.cursor?.file !== file) return;
		const headings = this.app.metadataCache.getFileCache(file)?.headings ?? [];
		const offset = this.cursor.offset;
		let current = -1;
		headings.forEach((h, i) => {
			if (h.position.start.offset <= offset) current = i;
		});
		const el = this.treeEl.querySelector<HTMLElement>(`.outline-item[data-index="${current}"]`);
		el?.addClass('is-active');
		el?.scrollIntoView?.({ block: 'nearest' });
	}

	/** Dropping a heading on another moves its section before that one. */
	private draggable(el: HTMLElement, file: TFile, headings: HeadingCache[], index: number): void {
		el.addEventListener('dragstart', (event) => {
			this.dragged = index;
			event.dataTransfer?.setData('text/plain', headings[index]!.heading);
			el.addClass('is-being-dragged');
		});
		el.addEventListener('dragend', () => {
			this.dragged = null;
			el.removeClass('is-being-dragged');
			for (const over of this.treeEl.querySelectorAll('.is-drop-before')) over.removeClass('is-drop-before');
		});
		el.addEventListener('dragover', (event) => {
			if (this.dragged === null || this.dragged === index) return;
			event.preventDefault();
			el.addClass('is-drop-before');
		});
		el.addEventListener('dragleave', () => el.removeClass('is-drop-before'));
		el.addEventListener('drop', (event) => {
			event.preventDefault();
			el.removeClass('is-drop-before');
			const from = this.dragged;
			this.dragged = null;
			if (from === null || from === index) return;
			void this.move(file, headings, from, index);
		});
	}

	/** Moves a section: in the open editor (so it can be undone), or in the file. */
	private async move(file: TFile, headings: HeadingCache[], from: number, to: number): Promise<void> {
		const editor = this.app.workspace.activeEditor;
		if (editor?.file === file && editor.editor) {
			const text = editor.editor.getValue();
			const moved = moveSection(text, headings, from, to);
			if (moved === null) return;
			// One change from the first difference to the last, so undo restores it in one step.
			let start = 0;
			while (start < text.length && text[start] === moved[start]) start++;
			let end = 0;
			while (end < text.length - start && text[text.length - 1 - end] === moved[moved.length - 1 - end]) end++;
			editor.editor.replaceRange(moved.slice(start, moved.length - end), editor.editor.offsetToPos(start), editor.editor.offsetToPos(text.length - end));
			return;
		}
		await this.app.vault.process(file, (text) => moveSection(text, headings, from, to) ?? text);
	}
}
