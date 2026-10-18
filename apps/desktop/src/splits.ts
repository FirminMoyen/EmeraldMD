/**
 * The main area's layout: panes (tab groups) side by side or one above the
 * other, nested like Obsidian's splits. `.workspace-split.mod-root` is the
 * outer split; inside, `.workspace-split.mod-vertical` holds children side by
 * side and `.mod-horizontal` stacks them, with `.workspace-leaf-resize-handle`
 * between children to drag.
 */

import type { NotePane, SavedTabs } from './pane';

export type SplitDirection = 'vertical' | 'horizontal';

interface SplitNode {
	kind: 'split';
	direction: SplitDirection;
	children: LayoutNode[];
	/** Each child's share of the space (flex-grow). */
	sizes: number[];
	el: HTMLElement;
}

interface PaneNode {
	kind: 'pane';
	pane: NotePane;
}

type LayoutNode = SplitNode | PaneNode;

/** The layout as saved: splits with their direction and sizes, panes with their tabs. */
export type SavedLayout =
	| { type: 'split'; direction: SplitDirection; sizes: number[]; children: SavedLayout[] }
	| { type: 'tabs'; tabs: SavedTabs['tabs']; active: number; current?: boolean };

export class SplitLayout {
	private readonly root: SplitNode;

	constructor(rootEl: HTMLElement, first: NotePane) {
		this.root = { kind: 'split', direction: 'vertical', children: [{ kind: 'pane', pane: first }], sizes: [1], el: rootEl };
		this.render();
	}

	/** Every pane, in layout order (left to right, top to bottom). */
	panes(): NotePane[] {
		const out: NotePane[] = [];
		const walk = (node: LayoutNode) => {
			if (node.kind === 'pane') out.push(node.pane);
			else node.children.forEach(walk);
		};
		walk(this.root);
		return out;
	}

	/** Puts `added` next to `pane`: on its right (`vertical`) or below it (`horizontal`); before it with `before`. */
	split(pane: NotePane, added: NotePane, direction: SplitDirection, before = false): void {
		const found = this.find(pane);
		if (!found) return;
		const { parent, index } = found;
		const node: PaneNode = { kind: 'pane', pane: added };
		if (parent.children.length === 1) parent.direction = direction;
		if (parent.direction === direction) {
			// Share the pane's space with the new one.
			const half = parent.sizes[index]! / 2;
			parent.sizes[index] = half;
			parent.children.splice(before ? index : index + 1, 0, node);
			parent.sizes.splice(before ? index : index + 1, 0, half);
		} else {
			const wrapper: SplitNode = {
				kind: 'split',
				direction,
				children: before ? [node, parent.children[index]!] : [parent.children[index]!, node],
				sizes: [1, 1],
				el: createDiv(),
			};
			parent.children[index] = wrapper;
		}
		this.render();
	}

	/** Takes a pane out; splits left with a single child give their place to it. */
	remove(pane: NotePane): void {
		const found = this.find(pane);
		if (!found) return;
		found.parent.children.splice(found.index, 1);
		found.parent.sizes.splice(found.index, 1);
		this.collapse(this.root);
		this.render();
	}

	/** The pane next to `pane` in a direction, by position on screen. */
	neighbour(pane: NotePane, side: 'left' | 'right' | 'top' | 'bottom'): NotePane | null {
		const from = pane.containerEl.getBoundingClientRect();
		let best: { pane: NotePane; distance: number } | null = null;
		for (const other of this.panes()) {
			if (other === pane) continue;
			const r = other.containerEl.getBoundingClientRect();
			const overlaps = side === 'left' || side === 'right' ? r.top < from.bottom && r.bottom > from.top : r.left < from.right && r.right > from.left;
			const distance = side === 'left' ? from.left - r.right : side === 'right' ? r.left - from.right : side === 'top' ? from.top - r.bottom : r.top - from.bottom;
			if (!overlaps || distance < -1) continue;
			if (!best || distance < best.distance) best = { pane: other, distance };
		}
		return best?.pane ?? null;
	}

	/** The layout, to save; `current` marks the pane that was current. */
	serialize(current: NotePane | null): SavedLayout {
		const save = (node: LayoutNode): SavedLayout =>
			node.kind === 'pane'
				? { type: 'tabs', ...node.pane.serialize(), ...(node.pane === current ? { current: true } : {}) }
				: { type: 'split', direction: node.direction, sizes: node.sizes.map((s) => Math.round(s * 1000) / 1000), children: node.children.map(save) };
		return save(this.root);
	}

	/**
	 * Rebuilds a saved layout: `makePane` creates a pane for each saved tab
	 * group (the first one reuses `first`). Returns the pane that was current.
	 */
	restore(saved: SavedLayout, first: NotePane, makePane: (saved: Extract<SavedLayout, { type: 'tabs' }>, isFirst: boolean) => NotePane | null): NotePane {
		let current: NotePane = first;
		let isFirst = true;
		const build = (node: SavedLayout): LayoutNode | null => {
			if (node.type === 'tabs') {
				const pane = makePane(node, isFirst);
				isFirst = false;
				if (!pane) return null;
				if (node.current) current = pane;
				return { kind: 'pane', pane };
			}
			const children: LayoutNode[] = [];
			const sizes: number[] = [];
			node.children.forEach((child, i) => {
				const built = build(child);
				if (!built) return;
				children.push(built);
				const size = Number(node.sizes?.[i]);
				sizes.push(Number.isFinite(size) && size > 0 ? size : 1);
			});
			if (!children.length) return null;
			return { kind: 'split', direction: node.direction === 'horizontal' ? 'horizontal' : 'vertical', children, sizes, el: createDiv() };
		};
		const built = build(saved);
		if (built?.kind === 'split') {
			this.root.direction = built.direction;
			this.root.children = built.children;
			this.root.sizes = built.sizes;
		} else if (built) {
			this.root.children = [built];
			this.root.sizes = [1];
		}
		if (!this.panes().includes(first)) {
			this.root.children.unshift({ kind: 'pane', pane: first });
			this.root.sizes.unshift(1);
		}
		this.collapse(this.root);
		this.render();
		return current;
	}

	private find(pane: NotePane, node: SplitNode = this.root): { parent: SplitNode; index: number } | null {
		for (const [index, child] of node.children.entries()) {
			if (child.kind === 'pane' && child.pane === pane) return { parent: node, index };
			if (child.kind === 'split') {
				const found = this.find(pane, child);
				if (found) return found;
			}
		}
		return null;
	}

	/** Removes empty splits and lifts the only child of a split into its place. */
	private collapse(node: SplitNode): void {
		for (const [i, child] of [...node.children.entries()].reverse()) {
			if (child.kind !== 'split') continue;
			this.collapse(child);
			if (child.children.length === 0) {
				node.children.splice(i, 1);
				node.sizes.splice(i, 1);
			} else if (child.children.length === 1) {
				node.children[i] = child.children[0]!;
			}
		}
		// The outer split takes the shape of a lone child split.
		const only = node.children[0];
		if (node === this.root && node.children.length === 1 && only?.kind === 'split') {
			node.direction = only.direction;
			node.children = only.children;
			node.sizes = only.sizes;
		}
	}

	/** Puts the layout into the page. Pane elements are moved, not rebuilt, so editors keep their state. */
	private render(): void {
		const draw = (node: SplitNode) => {
			node.el.className = `workspace-split mod-${node.direction}${node === this.root ? ' mod-root' : ''}`;
			const items: HTMLElement[] = [];
			node.children.forEach((child, i) => {
				const el = child.kind === 'pane' ? child.pane.containerEl : child.el;
				if (child.kind === 'split') draw(child);
				el.style.flexGrow = String(node.sizes[i] ?? 1);
				if (i > 0) items.push(this.handle(node, i - 1));
				items.push(el);
			});
			node.el.replaceChildren(...items);
		};
		draw(this.root);
	}

	/** The handle between children `i` and `i + 1`; dragging it moves space between them. */
	private handle(node: SplitNode, i: number): HTMLElement {
		const handle = createDiv({ cls: `workspace-leaf-resize-handle mod-${node.direction}` });
		handle.addEventListener('mousedown', (down) => {
			down.preventDefault();
			const els = [...node.el.children].filter((el) => !el.hasClass('workspace-leaf-resize-handle')) as HTMLElement[];
			const [a, b] = [els[i]!, els[i + 1]!];
			const horizontal = node.direction === 'vertical';
			const sizeOf = (el: HTMLElement) => (horizontal ? el.getBoundingClientRect().width : el.getBoundingClientRect().height);
			const [startA, startB] = [sizeOf(a), sizeOf(b)];
			const share = node.sizes[i]! + node.sizes[i + 1]!;
			const start = horizontal ? down.clientX : down.clientY;
			document.body.addClass('is-resizing');
			const move = (event: MouseEvent) => {
				const delta = (horizontal ? event.clientX : event.clientY) - start;
				const total = startA + startB;
				const pxA = Math.min(total - 120, Math.max(120, startA + delta));
				node.sizes[i] = (share * pxA) / total;
				node.sizes[i + 1] = share - node.sizes[i]!;
				a.style.flexGrow = String(node.sizes[i]);
				b.style.flexGrow = String(node.sizes[i + 1]);
			};
			const up = () => {
				document.removeEventListener('mousemove', move);
				document.removeEventListener('mouseup', up);
				document.body.removeClass('is-resizing');
				this.onResize?.();
			};
			document.addEventListener('mousemove', move);
			document.addEventListener('mouseup', up);
		});
		return handle;
	}

	/** Called after the user resized panes (to save the layout). */
	onResize: (() => void) | null = null;
}
