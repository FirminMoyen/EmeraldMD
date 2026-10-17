/** Edge routing and hit testing for canvas nodes. */

import type { CanvasData, CanvasEdge, CanvasNode, Side } from './model';

export interface Point {
	x: number;
	y: number;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Midpoint of a node's side. */
export function anchor(node: Rect, side: Side): Point {
	switch (side) {
		case 'top':
			return { x: node.x + node.width / 2, y: node.y };
		case 'bottom':
			return { x: node.x + node.width / 2, y: node.y + node.height };
		case 'left':
			return { x: node.x, y: node.y + node.height / 2 };
		case 'right':
			return { x: node.x + node.width, y: node.y + node.height / 2 };
	}
}

const DIRECTION: Record<Side, Point> = {
	top: { x: 0, y: -1 },
	bottom: { x: 0, y: 1 },
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 },
};

/** The sides facing each other, for edges that do not name them. */
export function facingSides(from: Rect, to: Rect): [Side, Side] {
	const dx = to.x + to.width / 2 - (from.x + from.width / 2);
	const dy = to.y + to.height / 2 - (from.y + from.height / 2);
	if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
	return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

export interface EdgePath {
	from: Point;
	to: Point;
	/** Cubic Bézier control points. */
	c1: Point;
	c2: Point;
	/** SVG path data. */
	d: string;
	/** Middle of the curve, for the label. */
	mid: Point;
}

export function edgePath(edge: CanvasEdge, from: CanvasNode, to: CanvasNode): EdgePath {
	const [autoFrom, autoTo] = facingSides(from, to);
	const fromSide = edge.fromSide ?? autoFrom;
	const toSide = edge.toSide ?? autoTo;
	const a = anchor(from, fromSide);
	const b = anchor(to, toSide);
	// Control points leave each side perpendicularly, further apart for longer edges.
	const pull = Math.max(40, Math.min(250, Math.hypot(b.x - a.x, b.y - a.y) / 2));
	const c1 = { x: a.x + DIRECTION[fromSide].x * pull, y: a.y + DIRECTION[fromSide].y * pull };
	const c2 = { x: b.x + DIRECTION[toSide].x * pull, y: b.y + DIRECTION[toSide].y * pull };
	const mid = {
		x: 0.125 * a.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * b.x,
		y: 0.125 * a.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * b.y,
	};
	const d = `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`;
	return { from: a, to: b, c1, c2, d, mid };
}

/** Topmost node under a point (last in z-order wins). */
export function nodeAt(data: CanvasData, p: Point): CanvasNode | null {
	for (let i = data.nodes.length - 1; i >= 0; i--) {
		const n = data.nodes[i]!;
		if (p.x >= n.x && p.x <= n.x + n.width && p.y >= n.y && p.y <= n.y + n.height) return n;
	}
	return null;
}

export function bounds(nodes: Rect[]): Rect | null {
	if (!nodes.length) return null;
	const minX = Math.min(...nodes.map((n) => n.x));
	const minY = Math.min(...nodes.map((n) => n.y));
	const maxX = Math.max(...nodes.map((n) => n.x + n.width));
	const maxY = Math.max(...nodes.map((n) => n.y + n.height));
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function snap(value: number, grid: number): number {
	return grid > 0 ? Math.round(value / grid) * grid : value;
}
