/**
 * Canvas graph renderer: pan (drag the background), zoom (wheel or pinch),
 * drag nodes, hover to highlight neighbours, click to open. Colours come from
 * the CSS variables themes set for the graph (`--graph-node`, `--graph-line`,
 * …) on the container, read again whenever the theme may have changed.
 */

import type { Simulation } from 'd3-force';
import { createSimulation, DEFAULT_FORCES, nodeRadius, type GraphForces, type SimLink, type SimNode } from './layout';
import type { GraphData, GraphNode, NodeKind } from './model';

export interface GraphViewOptions {
	/** A node was clicked (also for unresolved links, so the host can create the note). */
	onOpen?: (node: GraphNode, event: MouseEvent) => void;
	forces?: GraphForces;
	/** Zoom level above which every label shows (hovered nodes always show theirs). */
	labelZoom?: number;
}

interface Palette {
	background: string;
	line: string;
	lineHighlight: string;
	text: string;
	font: string;
	nodes: Record<NodeKind, string>;
	focused: string;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
/** Pointer movement (px) below which a press counts as a click. */
const CLICK_SLOP = 4;

export class GraphView {
	readonly canvas: HTMLCanvasElement;
	private readonly ctx: CanvasRenderingContext2D | null;
	private readonly options: GraphViewOptions;
	private simulation: Simulation<SimNode, SimLink> | null = null;
	private nodes: SimNode[] = [];
	private links: SimLink[] = [];
	private neighbours = new Map<string, Set<string>>();
	private transform = { x: 0, y: 0, k: 1 };
	private size = { width: 0, height: 0 };
	private hovered: SimNode | null = null;
	private focused: string | null = null;
	private palette: Palette | null = null;
	private frame = 0;
	private readonly resizeObserver: ResizeObserver | null;
	private readonly themeObserver: MutationObserver | null;
	private press: { x: number; y: number; node: SimNode | null; moved: boolean; pointerId: number } | null = null;

	constructor(
		private readonly container: HTMLElement,
		options: GraphViewOptions = {},
	) {
		this.options = options;
		this.canvas = container.ownerDocument.createElement('canvas');
		this.canvas.className = 'graph-view-canvas';
		this.canvas.style.display = 'block';
		this.canvas.style.width = '100%';
		this.canvas.style.height = '100%';
		this.canvas.style.touchAction = 'none';
		container.classList.add('graph-view');
		container.append(this.canvas);
		this.ctx = this.canvas.getContext('2d');

		this.canvas.addEventListener('pointerdown', this.onPointerDown);
		this.canvas.addEventListener('pointermove', this.onPointerMove);
		this.canvas.addEventListener('pointerup', this.onPointerUp);
		this.canvas.addEventListener('pointerleave', this.onPointerLeave);
		this.canvas.addEventListener('wheel', this.onWheel, { passive: false });

		const win = container.ownerDocument.defaultView;
		this.resizeObserver = win && 'ResizeObserver' in win ? new win.ResizeObserver(() => this.resize()) : null;
		this.resizeObserver?.observe(container);
		// Theme switches change classes on <body>; recolour when they do.
		this.themeObserver = win && 'MutationObserver' in win ? new win.MutationObserver(() => this.recolour()) : null;
		this.themeObserver?.observe(container.ownerDocument.body, { attributes: true, attributeFilter: ['class', 'style'] });
		this.resize();
	}

	setData(data: GraphData): void {
		this.simulation?.stop();
		const { simulation, nodes, links } = createSimulation(data, this.options.forces ?? DEFAULT_FORCES, this.nodes);
		this.simulation = simulation;
		this.nodes = nodes;
		this.links = links;
		this.neighbours = new Map(nodes.map((n) => [n.id, new Set<string>()]));
		for (const l of links) {
			const [s, t] = [l.source as SimNode, l.target as SimNode];
			this.neighbours.get(s.id)?.add(t.id);
			this.neighbours.get(t.id)?.add(s.id);
		}
		if (this.hovered && !this.neighbours.has(this.hovered.id)) this.hovered = null;
		simulation.on('tick', () => this.requestDraw());
		simulation.alpha(0.8).restart();
	}

	/** Highlights a node, e.g. the active note. */
	setFocused(id: string | null): void {
		this.focused = id;
		this.requestDraw();
	}

	setForces(forces: GraphForces): void {
		this.options.forces = forces;
		this.setData({
			nodes: this.nodes.map(({ id, label, kind, degree }) => ({ id, label, kind, degree })),
			links: this.links.map((l) => ({ source: (l.source as SimNode).id, target: (l.target as SimNode).id })),
		});
	}

	/** Centres the view on the graph and fits it in. */
	zoomToFit(padding = 40): void {
		if (!this.nodes.length || !this.size.width) return;
		let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
		for (const n of this.nodes) {
			minX = Math.min(minX, n.x ?? 0);
			minY = Math.min(minY, n.y ?? 0);
			maxX = Math.max(maxX, n.x ?? 0);
			maxY = Math.max(maxY, n.y ?? 0);
		}
		const k = clamp(
			Math.min((this.size.width - padding * 2) / (maxX - minX || 1), (this.size.height - padding * 2) / (maxY - minY || 1)),
			MIN_ZOOM,
			2,
		);
		this.transform = {
			k,
			x: this.size.width / 2 - ((minX + maxX) / 2) * k,
			y: this.size.height / 2 - ((minY + maxY) / 2) * k,
		};
		this.requestDraw();
	}

	destroy(): void {
		this.simulation?.stop();
		cancelAnimationFrame(this.frame);
		this.resizeObserver?.disconnect();
		this.themeObserver?.disconnect();
		this.canvas.remove();
		this.container.classList.remove('graph-view');
	}

	private resize(): void {
		const rect = this.container.getBoundingClientRect();
		const ratio = this.container.ownerDocument.defaultView?.devicePixelRatio ?? 1;
		const first = this.size.width === 0;
		this.size = { width: rect.width, height: rect.height };
		this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
		this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
		if (first) this.transform = { x: rect.width / 2, y: rect.height / 2, k: 1 };
		this.requestDraw();
	}

	private recolour(): void {
		this.palette = null;
		this.requestDraw();
	}

	private readPalette(): Palette {
		const style = getComputedStyle(this.container);
		const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
		const node = v('--graph-node', '#8f9893');
		return {
			background: v('--graph-background', v('--background-primary', 'transparent')),
			line: v('--graph-line', 'rgba(128, 128, 128, 0.35)'),
			lineHighlight: v('--graph-line-highlight', v('--interactive-accent', '#0f9d6b')),
			text: v('--graph-text', v('--text-normal', '#1f2421')),
			font: `12px ${v('--font-interface', 'sans-serif')}`,
			focused: v('--graph-node-focused', v('--interactive-accent', '#0f9d6b')),
			nodes: {
				note: node,
				attachment: v('--graph-node-attachment', '#c2a33a'),
				unresolved: v('--graph-node-unresolved', 'rgba(143, 152, 147, 0.45)'),
				tag: v('--graph-node-tag', '#4b9fd6'),
			},
		};
	}

	private requestDraw(): void {
		if (this.frame) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			this.draw();
		});
	}

	private draw(): void {
		const ctx = this.ctx;
		if (!ctx) return;
		const palette = (this.palette ??= this.readPalette());
		const ratio = this.canvas.width / Math.max(1, this.size.width);
		const { x, y, k } = this.transform;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		if (palette.background !== 'transparent') {
			ctx.fillStyle = palette.background;
			ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
		}
		ctx.setTransform(ratio * k, 0, 0, ratio * k, ratio * x, ratio * y);

		const active = this.hovered?.id ?? null;
		const near = active ? this.neighbours.get(active) : undefined;
		const dimmed = (id: string) => active !== null && id !== active && !near?.has(id);

		ctx.lineWidth = 1 / k;
		for (const l of this.links) {
			const [s, t] = [l.source as SimNode, l.target as SimNode];
			const lit = active !== null && (s.id === active || t.id === active);
			ctx.globalAlpha = active !== null && !lit ? 0.25 : 1;
			ctx.strokeStyle = lit ? palette.lineHighlight : palette.line;
			ctx.beginPath();
			ctx.moveTo(s.x ?? 0, s.y ?? 0);
			ctx.lineTo(t.x ?? 0, t.y ?? 0);
			ctx.stroke();
		}

		for (const n of this.nodes) {
			ctx.globalAlpha = dimmed(n.id) ? 0.3 : 1;
			ctx.fillStyle = n.id === this.focused || n.id === active ? palette.focused : palette.nodes[n.kind];
			ctx.beginPath();
			ctx.arc(n.x ?? 0, n.y ?? 0, nodeRadius(n), 0, Math.PI * 2);
			ctx.fill();
		}

		const showAll = k >= (this.options.labelZoom ?? 1.1);
		ctx.font = palette.font;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		ctx.fillStyle = palette.text;
		for (const n of this.nodes) {
			const highlighted = n.id === active || near?.has(n.id) || n.id === this.focused;
			if (!showAll && !highlighted) continue;
			ctx.globalAlpha = dimmed(n.id) ? 0.3 : 1;
			const scale = 1 / Math.max(k, 0.6);
			ctx.save();
			ctx.translate(n.x ?? 0, (n.y ?? 0) + nodeRadius(n) + 3);
			ctx.scale(scale, scale);
			ctx.fillText(n.label, 0, 0);
			ctx.restore();
		}
		ctx.globalAlpha = 1;
	}

	/** Graph coordinates under a client position. */
	private toGraph(event: { clientX: number; clientY: number }): [number, number] {
		const rect = this.canvas.getBoundingClientRect();
		const { x, y, k } = this.transform;
		return [(event.clientX - rect.left - x) / k, (event.clientY - rect.top - y) / k];
	}

	private nodeAt(event: { clientX: number; clientY: number }): SimNode | null {
		const [gx, gy] = this.toGraph(event);
		let best: SimNode | null = null;
		let bestDistance = Infinity;
		for (const n of this.nodes) {
			const d = Math.hypot((n.x ?? 0) - gx, (n.y ?? 0) - gy);
			const hit = nodeRadius(n) + 4 / this.transform.k;
			if (d <= hit && d < bestDistance) {
				best = n;
				bestDistance = d;
			}
		}
		return best;
	}

	private readonly onPointerDown = (event: PointerEvent) => {
		const node = this.nodeAt(event);
		this.press = { x: event.clientX, y: event.clientY, node, moved: false, pointerId: event.pointerId };
		this.canvas.setPointerCapture?.(event.pointerId);
		if (node) {
			node.fx = node.x;
			node.fy = node.y;
			this.simulation?.alphaTarget(0.3).restart();
		}
	};

	private readonly onPointerMove = (event: PointerEvent) => {
		const press = this.press;
		if (!press) {
			const node = this.nodeAt(event);
			if (node !== this.hovered) {
				this.hovered = node;
				this.canvas.style.cursor = node ? 'pointer' : '';
				this.requestDraw();
			}
			return;
		}
		if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP) press.moved = true;
		if (press.node) {
			const [gx, gy] = this.toGraph(event);
			press.node.fx = gx;
			press.node.fy = gy;
		} else {
			this.transform.x += event.movementX;
			this.transform.y += event.movementY;
		}
		this.requestDraw();
	};

	private readonly onPointerUp = (event: PointerEvent) => {
		const press = this.press;
		this.press = null;
		this.canvas.releasePointerCapture?.(press?.pointerId ?? event.pointerId);
		if (press?.node) {
			press.node.fx = null;
			press.node.fy = null;
			this.simulation?.alphaTarget(0);
			if (!press.moved) this.options.onOpen?.(press.node, event);
		}
	};

	private readonly onPointerLeave = () => {
		if (!this.press && this.hovered) {
			this.hovered = null;
			this.requestDraw();
		}
	};

	private readonly onWheel = (event: WheelEvent) => {
		event.preventDefault();
		const rect = this.canvas.getBoundingClientRect();
		const [px, py] = [event.clientX - rect.left, event.clientY - rect.top];
		const { x, y, k } = this.transform;
		// Trackpad pinch arrives as ctrl+wheel with small deltas.
		const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002));
		const nk = clamp(k * factor, MIN_ZOOM, MAX_ZOOM);
		this.transform = { k: nk, x: px - ((px - x) / k) * nk, y: py - ((py - y) / k) * nk };
		this.requestDraw();
	};
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
