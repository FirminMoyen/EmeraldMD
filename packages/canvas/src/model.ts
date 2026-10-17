/**
 * JSON Canvas 1.0 (https://jsoncanvas.org, MIT): the `.canvas` file format.
 *
 * Parsing is lenient and lossless: unknown properties (which plugins add) are
 * kept on the objects and written back unchanged; only nodes and edges that
 * cannot be shown are skipped, and reported.
 */

export type CanvasColor = string; // "1"–"6" (preset) or "#RRGGBB"
export type Side = 'top' | 'right' | 'bottom' | 'left';
export type EdgeEnd = 'none' | 'arrow';

interface NodeBase {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	color?: CanvasColor;
	[extra: string]: unknown;
}

export interface TextNode extends NodeBase {
	type: 'text';
	text: string;
}

export interface FileNode extends NodeBase {
	type: 'file';
	file: string;
	/** `#Heading` or `#^block`. */
	subpath?: string;
}

export interface LinkNode extends NodeBase {
	type: 'link';
	url: string;
}

export interface GroupNode extends NodeBase {
	type: 'group';
	label?: string;
	background?: string;
	backgroundStyle?: 'cover' | 'ratio' | 'repeat';
}

export type CanvasNode = TextNode | FileNode | LinkNode | GroupNode;

export interface CanvasEdge {
	id: string;
	fromNode: string;
	fromSide?: Side;
	/** Default `none`. */
	fromEnd?: EdgeEnd;
	toNode: string;
	toSide?: Side;
	/** Default `arrow`. */
	toEnd?: EdgeEnd;
	color?: CanvasColor;
	label?: string;
	[extra: string]: unknown;
}

export interface CanvasData {
	/** In z-order: the first node is drawn at the bottom. */
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	[extra: string]: unknown;
}

export interface ParseResult {
	data: CanvasData;
	/** What was skipped and why. */
	warnings: string[];
}

const SIDES = new Set(['top', 'right', 'bottom', 'left']);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validNode(raw: unknown): string | null {
	if (!isObject(raw)) return 'not an object';
	if (typeof raw.id !== 'string' || !raw.id) return 'missing id';
	for (const key of ['x', 'y', 'width', 'height']) {
		if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) return `${key} is not a number`;
	}
	switch (raw.type) {
		case 'text':
			return typeof raw.text === 'string' ? null : 'text node without text';
		case 'file':
			return typeof raw.file === 'string' ? null : 'file node without file';
		case 'link':
			return typeof raw.url === 'string' ? null : 'link node without url';
		case 'group':
			return null;
		default:
			return `unknown node type ${JSON.stringify(raw.type)}`;
	}
}

function validEdge(raw: unknown, nodeIds: Set<string>): string | null {
	if (!isObject(raw)) return 'not an object';
	if (typeof raw.id !== 'string' || !raw.id) return 'missing id';
	if (typeof raw.fromNode !== 'string' || !nodeIds.has(raw.fromNode)) return 'fromNode does not exist';
	if (typeof raw.toNode !== 'string' || !nodeIds.has(raw.toNode)) return 'toNode does not exist';
	for (const key of ['fromSide', 'toSide']) {
		if (raw[key] !== undefined && !SIDES.has(raw[key] as string)) return `invalid ${key}`;
	}
	return null;
}

export function parseCanvas(text: string): ParseResult {
	const warnings: string[] = [];
	if (!text.trim()) return { data: { nodes: [], edges: [] }, warnings };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new Error(`Not a valid canvas file: ${(err as Error).message}`);
	}
	if (!isObject(raw)) throw new Error('Not a valid canvas file: the top level is not an object');
	const { nodes: rawNodes, edges: rawEdges, ...rest } = raw;
	const nodes: CanvasNode[] = [];
	const seen = new Set<string>();
	for (const [i, node] of (Array.isArray(rawNodes) ? rawNodes : []).entries()) {
		const problem = validNode(node) ?? (seen.has((node as CanvasNode).id) ? 'duplicate id' : null);
		if (problem) warnings.push(`node ${i}: ${problem}`);
		else {
			seen.add((node as CanvasNode).id);
			nodes.push(node as CanvasNode);
		}
	}
	const edges: CanvasEdge[] = [];
	for (const [i, edge] of (Array.isArray(rawEdges) ? rawEdges : []).entries()) {
		const problem = validEdge(edge, seen);
		if (problem) warnings.push(`edge ${i}: ${problem}`);
		else edges.push(edge as CanvasEdge);
	}
	return { data: { ...rest, nodes, edges }, warnings };
}

/** Tab-indented JSON, nodes before edges. */
export function serializeCanvas(data: CanvasData): string {
	const { nodes, edges, ...rest } = data;
	return JSON.stringify({ nodes, edges, ...rest }, null, '\t');
}

/** A random 16-hex-digit id, like the ids in existing canvas files. */
export function newId(existing: Iterable<string> = []): string {
	const taken = new Set(existing);
	for (;;) {
		const bytes = new Uint8Array(8);
		crypto.getRandomValues(bytes);
		const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
		if (!taken.has(id)) return id;
	}
}

/** Nodes that a group contains: entirely inside its rectangle and above it in z-order. */
export function groupChildren(data: CanvasData, group: GroupNode): CanvasNode[] {
	const index = data.nodes.indexOf(group);
	return data.nodes.filter(
		(n, i) =>
			i > index &&
			n.x >= group.x &&
			n.y >= group.y &&
			n.x + n.width <= group.x + group.width &&
			n.y + n.height <= group.y + group.height,
	);
}
