/**
 * Interactive canvas: nodes are DOM elements, edges an SVG layer, both inside
 * one transformed "world" element.
 *
 * - Scroll pans, Ctrl/Cmd+scroll or pinch zooms, dragging the background pans.
 * - Click selects (Shift adds), drag moves (a group moves its contents),
 *   the corner handle resizes, Delete/Backspace removes the selection.
 * - Double-click the background for a new text card; double-click a text
 *   card to edit it, a file card to open the file.
 * - Drag from a dot on a card's edge to another card to connect them.
 */

import { anchor, bounds, edgePath, snap, type Point } from './geometry';
import { groupChildren, newId, type CanvasData, type CanvasEdge, type CanvasNode, type FileNode, type Side, type TextNode } from './model';

export interface CanvasViewOptions {
	/** Renders a text card's Markdown. Default: plain text. */
	renderMarkdown?: (el: HTMLElement, markdown: string) => void;
	/** Renders a file card's content. Default: the file name. */
	renderFile?: (el: HTMLElement, node: FileNode) => void;
	onOpenFile?: (node: FileNode) => void;
	onOpenLink?: (url: string) => void;
	/** Called after every user edit, with the whole canvas. */
	onChange?: (data: CanvasData) => void;
	readOnly?: boolean;
	/** Snap moves and resizes to this grid (0 = off). Default 20. */
	grid?: number;
}

const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];
const MIN_SIZE = 40;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';

type Drag =
	| { kind: 'pan'; last: Point }
	| { kind: 'move'; start: Point; origin: Map<CanvasNode, Point>; moved: boolean }
	| { kind: 'resize'; node: CanvasNode; start: Point; size: { width: number; height: number } }
	| { kind: 'connect'; from: CanvasNode; side: Side; line: SVGPathElement };

export class CanvasView {
	readonly el: HTMLElement;
	private readonly world: HTMLElement;
	private readonly svg: SVGSVGElement;
	private readonly doc: Document;
	private data: CanvasData = { nodes: [], edges: [] };
	private readonly nodeEls = new Map<string, HTMLElement>();
	private selected = new Set<string>();
	private selectedEdge: string | null = null;
	private editing: string | null = null;
	private transform = { x: 0, y: 0, k: 1 };
	private drag: Drag | null = null;

	constructor(
		container: HTMLElement,
		private readonly options: CanvasViewOptions = {},
	) {
		this.doc = container.ownerDocument;
		this.el = this.doc.createElement('div');
		this.el.className = 'canvas-wrapper';
		this.el.tabIndex = 0;
		this.world = this.doc.createElement('div');
		this.world.className = 'canvas';
		this.svg = this.doc.createElementNS(SVG_NS, 'svg');
		this.svg.classList.add('canvas-edges');
		this.world.append(this.svg);
		this.el.append(this.world);
		container.append(this.el);

		this.el.addEventListener('pointerdown', this.onPointerDown);
		this.el.addEventListener('pointermove', this.onPointerMove);
		this.el.addEventListener('pointerup', this.onPointerUp);
		this.el.addEventListener('dblclick', this.onDoubleClick);
		this.el.addEventListener('wheel', this.onWheel, { passive: false });
		this.el.addEventListener('keydown', this.onKeyDown);
	}

	setData(data: CanvasData): void {
		this.data = data;
		const ids = new Set(data.nodes.map((n) => n.id));
		this.selected = new Set([...this.selected].filter((id) => ids.has(id)));
		this.render();
	}

	getData(): CanvasData {
		return this.data;
	}

	zoomToFit(padding = 60): void {
		const box = bounds(this.data.nodes);
		const { width, height } = this.el.getBoundingClientRect();
		if (!box || !width || !height) return;
		const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((width - padding * 2) / box.width, (height - padding * 2) / box.height, 1)));
		this.transform = { k, x: width / 2 - (box.x + box.width / 2) * k, y: height / 2 - (box.y + box.height / 2) * k };
		this.applyTransform();
	}

	destroy(): void {
		this.el.remove();
	}

	// Rendering

	private render(): void {
		for (const el of this.nodeEls.values()) el.remove();
		this.nodeEls.clear();
		for (const node of this.data.nodes) {
			const el = this.renderNode(node);
			this.nodeEls.set(node.id, el);
			this.world.append(el);
		}
		this.renderEdges();
		this.applyTransform();
	}

	private renderNode(node: CanvasNode): HTMLElement {
		const el = this.doc.createElement('div');
		el.className = `canvas-node is-${node.type}`;
		el.dataset.id = node.id;
		this.applyColor(el, node.color);
		const content = this.doc.createElement('div');
		content.className = 'canvas-node-content';
		switch (node.type) {
			case 'text':
				if (this.options.renderMarkdown) this.options.renderMarkdown(content, node.text);
				else content.textContent = node.text;
				break;
			case 'file': {
				if (this.options.renderFile) this.options.renderFile(content, node);
				else content.textContent = node.file.slice(node.file.lastIndexOf('/') + 1) + (node.subpath ?? '');
				break;
			}
			case 'link': {
				const a = this.doc.createElement('a');
				a.href = node.url;
				a.textContent = node.url;
				a.addEventListener('click', (e) => {
					e.preventDefault();
					this.options.onOpenLink?.(node.url);
				});
				content.append(a);
				break;
			}
			case 'group': {
				const label = this.doc.createElement('div');
				label.className = 'canvas-group-label';
				label.textContent = node.label ?? '';
				el.append(label);
				break;
			}
		}
		el.append(content);
		if (!this.options.readOnly) {
			const resizer = this.doc.createElement('div');
			resizer.className = 'canvas-node-resizer';
			el.append(resizer);
			for (const side of SIDES) {
				const dot = this.doc.createElement('div');
				dot.className = 'canvas-node-connection-point';
				dot.dataset.side = side;
				el.append(dot);
			}
		}
		this.positionNode(node, el);
		return el;
	}

	private positionNode(node: CanvasNode, el = this.nodeEls.get(node.id)): void {
		if (!el) return;
		el.style.left = `${node.x}px`;
		el.style.top = `${node.y}px`;
		el.style.width = `${node.width}px`;
		el.style.height = `${node.height}px`;
		el.classList.toggle('is-selected', this.selected.has(node.id));
	}

	private applyColor(el: Element, color: string | undefined): void {
		const style = (el as HTMLElement).style;
		for (let i = 1; i <= 6; i++) el.classList.remove(`mod-canvas-color-${i}`);
		style?.removeProperty('--canvas-color');
		if (!color) return;
		if (/^[1-6]$/.test(color)) el.classList.add(`mod-canvas-color-${color}`);
		else style?.setProperty('--canvas-color', color);
	}

	private renderEdges(): void {
		this.svg.replaceChildren();
		const byId = new Map(this.data.nodes.map((n) => [n.id, n]));
		for (const edge of this.data.edges) {
			const from = byId.get(edge.fromNode);
			const to = byId.get(edge.toNode);
			if (!from || !to) continue;
			const path = edgePath(edge, from, to);
			const g = this.doc.createElementNS(SVG_NS, 'g');
			g.classList.add('canvas-edge');
			if (edge.id === this.selectedEdge) g.classList.add('is-selected');
			g.dataset.id = edge.id;
			this.applyColor(g, edge.color);
			const hit = this.doc.createElementNS(SVG_NS, 'path');
			hit.classList.add('canvas-edge-hit');
			hit.setAttribute('d', path.d);
			const line = this.doc.createElementNS(SVG_NS, 'path');
			line.classList.add('canvas-edge-line');
			line.setAttribute('d', path.d);
			g.append(hit, line);
			// Arrowheads are drawn as shapes so they take the edge's colour.
			const ends: [Point, Point][] = [];
			if ((edge.toEnd ?? 'arrow') === 'arrow') ends.push([path.to, path.c2]);
			if ((edge.fromEnd ?? 'none') === 'arrow') ends.push([path.from, path.c1]);
			for (const [tip, control] of ends) {
				const head = this.doc.createElementNS(SVG_NS, 'path');
				head.classList.add('canvas-edge-arrow');
				head.setAttribute('d', arrowHead(tip, control));
				g.append(head);
			}
			if (edge.label) {
				const label = this.doc.createElementNS(SVG_NS, 'text');
				label.classList.add('canvas-edge-label');
				label.setAttribute('x', String(path.mid.x));
				label.setAttribute('y', String(path.mid.y));
				label.setAttribute('text-anchor', 'middle');
				label.setAttribute('dominant-baseline', 'middle');
				label.textContent = edge.label;
				g.append(label);
			}
			this.svg.append(g);
		}
	}

	private applyTransform(): void {
		const { x, y, k } = this.transform;
		this.world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
		this.el.style.setProperty('--canvas-zoom', String(k));
	}

	// Coordinates and hit testing

	private toWorld(event: { clientX: number; clientY: number }): Point {
		const rect = this.el.getBoundingClientRect();
		const { x, y, k } = this.transform;
		return { x: (event.clientX - rect.left - x) / k, y: (event.clientY - rect.top - y) / k };
	}

	private nodeOf(target: EventTarget | null): CanvasNode | null {
		const el = (target as Element | null)?.closest?.('.canvas-node') as HTMLElement | null;
		return el ? (this.data.nodes.find((n) => n.id === el.dataset.id) ?? null) : null;
	}

	private changed(): void {
		this.options.onChange?.(this.data);
	}

	// Pointer interaction

	private readonly onPointerDown = (event: PointerEvent) => {
		if (event.button !== 0 || this.editing) return;
		const target = event.target as Element;
		this.el.focus();
		const node = this.nodeOf(target);
		const edgeEl = target.closest?.('.canvas-edge') as SVGGElement | null;
		this.el.setPointerCapture?.(event.pointerId);

		if (!this.options.readOnly && node && target.classList.contains('canvas-node-resizer')) {
			this.drag = { kind: 'resize', node, start: this.toWorld(event), size: { width: node.width, height: node.height } };
			return;
		}
		if (!this.options.readOnly && node && target.classList.contains('canvas-node-connection-point')) {
			const line = this.doc.createElementNS(SVG_NS, 'path');
			line.classList.add('canvas-edge-line', 'is-pending');
			this.svg.append(line);
			this.drag = { kind: 'connect', from: node, side: (target as HTMLElement).dataset.side as Side, line };
			return;
		}
		if (edgeEl) {
			this.selected.clear();
			this.selectedEdge = edgeEl.dataset.id ?? null;
			this.refreshSelection();
			this.drag = null;
			return;
		}
		if (node) {
			if (event.shiftKey) {
				if (this.selected.has(node.id)) this.selected.delete(node.id);
				else this.selected.add(node.id);
			} else if (!this.selected.has(node.id)) {
				this.selected = new Set([node.id]);
			}
			this.selectedEdge = null;
			this.refreshSelection();
			if (this.options.readOnly) return;
			const moving = new Set<CanvasNode>();
			for (const n of this.data.nodes) {
				if (!this.selected.has(n.id)) continue;
				moving.add(n);
				if (n.type === 'group') for (const child of groupChildren(this.data, n)) moving.add(child);
			}
			this.drag = {
				kind: 'move',
				start: this.toWorld(event),
				origin: new Map([...moving].map((n) => [n, { x: n.x, y: n.y }])),
				moved: false,
			};
			return;
		}
		if (this.selected.size || this.selectedEdge) {
			this.selected.clear();
			this.selectedEdge = null;
			this.refreshSelection();
		}
		this.drag = { kind: 'pan', last: { x: event.clientX, y: event.clientY } };
	};

	private readonly onPointerMove = (event: PointerEvent) => {
		const drag = this.drag;
		if (!drag) return;
		const grid = this.options.grid ?? 20;
		switch (drag.kind) {
			case 'pan':
				this.transform.x += event.clientX - drag.last.x;
				this.transform.y += event.clientY - drag.last.y;
				drag.last = { x: event.clientX, y: event.clientY };
				this.applyTransform();
				break;
			case 'move': {
				const p = this.toWorld(event);
				const [dx, dy] = [p.x - drag.start.x, p.y - drag.start.y];
				for (const [node, origin] of drag.origin) {
					node.x = snap(origin.x + dx, grid);
					node.y = snap(origin.y + dy, grid);
					this.positionNode(node);
				}
				drag.moved = true;
				this.renderEdges();
				break;
			}
			case 'resize': {
				const p = this.toWorld(event);
				drag.node.width = Math.max(MIN_SIZE, snap(drag.size.width + p.x - drag.start.x, grid));
				drag.node.height = Math.max(MIN_SIZE, snap(drag.size.height + p.y - drag.start.y, grid));
				this.positionNode(drag.node);
				this.renderEdges();
				break;
			}
			case 'connect': {
				const a = anchor(drag.from, drag.side);
				const b = this.toWorld(event);
				drag.line.setAttribute('d', `M${a.x},${a.y} L${b.x},${b.y}`);
				break;
			}
		}
	};

	private readonly onPointerUp = (event: PointerEvent) => {
		const drag = this.drag;
		this.drag = null;
		this.el.releasePointerCapture?.(event.pointerId);
		if (!drag) return;
		if (drag.kind === 'move' && drag.moved) this.changed();
		if (drag.kind === 'resize') this.changed();
		if (drag.kind === 'connect') {
			drag.line.remove();
			const target = this.nodeAt(event);
			if (target && target !== drag.from) {
				const p = this.toWorld(event);
				const toSide = nearestSide(target, p);
				const edge: CanvasEdge = {
					id: newId(this.data.edges.map((e) => e.id)),
					fromNode: drag.from.id,
					fromSide: drag.side,
					toNode: target.id,
					toSide,
				};
				this.data.edges.push(edge);
				this.renderEdges();
				this.changed();
			}
		}
	};

	/** Node under a pointer, ignoring the element being dragged over (hit by world coordinates). */
	private nodeAt(event: PointerEvent): CanvasNode | null {
		const p = this.toWorld(event);
		for (let i = this.data.nodes.length - 1; i >= 0; i--) {
			const n = this.data.nodes[i]!;
			if (p.x >= n.x && p.x <= n.x + n.width && p.y >= n.y && p.y <= n.y + n.height) return n;
		}
		return null;
	}

	private readonly onDoubleClick = (event: MouseEvent) => {
		const node = this.nodeOf(event.target);
		if (node?.type === 'file') {
			this.options.onOpenFile?.(node);
			return;
		}
		if (this.options.readOnly) return;
		if (node?.type === 'text') {
			this.startEditing(node);
			return;
		}
		if (node?.type === 'group') {
			this.startEditingLabel(node);
			return;
		}
		if (!node) {
			const p = this.toWorld(event);
			const grid = this.options.grid ?? 20;
			const text: TextNode = {
				id: newId(this.data.nodes.map((n) => n.id)),
				type: 'text',
				text: '',
				x: snap(p.x - 125, grid),
				y: snap(p.y - 30, grid),
				width: 260,
				height: 60,
			};
			this.data.nodes.push(text);
			this.selected = new Set([text.id]);
			this.render();
			this.changed();
			this.startEditing(text);
		}
	};

	private startEditing(node: TextNode): void {
		const el = this.nodeEls.get(node.id);
		const content = el?.querySelector('.canvas-node-content');
		if (!el || !content) return;
		this.editing = node.id;
		el.classList.add('is-editing');
		const textarea = this.doc.createElement('textarea');
		textarea.className = 'canvas-node-editor';
		textarea.value = node.text;
		content.replaceChildren(textarea);
		textarea.focus();
		const finish = (save: boolean) => {
			if (this.editing !== node.id) return;
			this.editing = null;
			const before = node.text;
			if (save) node.text = textarea.value;
			this.render();
			this.el.focus();
			if (node.text !== before) this.changed();
		};
		textarea.addEventListener('blur', () => finish(true));
		textarea.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Escape') finish(true);
		});
	}

	private startEditingLabel(node: Extract<CanvasNode, { type: 'group' }>): void {
		const label = this.nodeEls.get(node.id)?.querySelector('.canvas-group-label');
		if (!label) return;
		this.editing = node.id;
		const input = this.doc.createElement('input');
		input.className = 'canvas-group-label-editor';
		input.value = node.label ?? '';
		label.replaceChildren(input);
		input.focus();
		input.select();
		const finish = () => {
			if (this.editing !== node.id) return;
			this.editing = null;
			const before = node.label ?? '';
			node.label = input.value;
			this.render();
			this.el.focus();
			if (node.label !== before) this.changed();
		};
		input.addEventListener('blur', finish);
		input.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Enter' || e.key === 'Escape') finish();
		});
	}

	private readonly onWheel = (event: WheelEvent) => {
		event.preventDefault();
		if (event.ctrlKey || event.metaKey) {
			const rect = this.el.getBoundingClientRect();
			const [px, py] = [event.clientX - rect.left, event.clientY - rect.top];
			const { x, y, k } = this.transform;
			const nk = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k * Math.exp(-event.deltaY * 0.01)));
			this.transform = { k: nk, x: px - ((px - x) / k) * nk, y: py - ((py - y) / k) * nk };
		} else {
			this.transform.x -= event.deltaX;
			this.transform.y -= event.deltaY;
		}
		this.applyTransform();
	};

	private readonly onKeyDown = (event: KeyboardEvent) => {
		if (this.editing || this.options.readOnly) return;
		if (event.key !== 'Delete' && event.key !== 'Backspace') return;
		if (this.selected.size) {
			const gone = this.selected;
			this.data.nodes = this.data.nodes.filter((n) => !gone.has(n.id));
			this.data.edges = this.data.edges.filter((e) => !gone.has(e.fromNode) && !gone.has(e.toNode));
		} else if (this.selectedEdge) {
			this.data.edges = this.data.edges.filter((e) => e.id !== this.selectedEdge);
		} else {
			return;
		}
		event.preventDefault();
		this.selected = new Set();
		this.selectedEdge = null;
		this.render();
		this.changed();
	};

	private refreshSelection(): void {
		for (const node of this.data.nodes) this.nodeEls.get(node.id)?.classList.toggle('is-selected', this.selected.has(node.id));
		for (const g of this.svg.querySelectorAll('.canvas-edge')) {
			g.classList.toggle('is-selected', (g as SVGGElement).dataset.id === this.selectedEdge);
		}
	}
}

/** A filled triangle pointing at `tip`, coming from the direction of `control`. */
function arrowHead(tip: Point, control: Point, length = 12, width = 7): string {
	const [dx, dy] = [tip.x - control.x, tip.y - control.y];
	const n = Math.hypot(dx, dy) || 1;
	const [ux, uy] = [dx / n, dy / n];
	const [bx, by] = [tip.x - ux * length, tip.y - uy * length];
	return `M${tip.x},${tip.y} L${bx - uy * width},${by + ux * width} L${bx + uy * width},${by - ux * width} Z`;
}

function nearestSide(node: CanvasNode, p: Point): Side {
	let best: Side = 'top';
	let distance = Infinity;
	for (const side of SIDES) {
		const a = anchor(node, side);
		const d = Math.hypot(a.x - p.x, a.y - p.y);
		if (d < distance) {
			best = side;
			distance = d;
		}
	}
	return best;
}
