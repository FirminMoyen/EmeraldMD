import { describe, expect, it } from 'vitest';
import { edgePath, facingSides, groupChildren, newId, nodeAt, parseCanvas, serializeCanvas, snap, type CanvasData } from '../src';

const sample = {
	nodes: [
		{ id: 'g1', type: 'group', x: 0, y: 0, width: 600, height: 400, label: 'Ideas', color: '4' },
		{ id: 't1', type: 'text', x: 40, y: 40, width: 200, height: 80, text: '# Hello\n\nA **card**' },
		{ id: 'f1', type: 'file', x: 300, y: 40, width: 200, height: 200, file: 'Notes/Plan.md', subpath: '#Goals' },
		{ id: 'l1', type: 'link', x: 700, y: 0, width: 300, height: 200, url: 'https://jsoncanvas.org', color: '#ff00aa' },
		{ id: 'p1', type: 'text', x: 40, y: 500, width: 100, height: 50, text: 'plugin data', advancedCanvasStyle: 'pill' },
	],
	edges: [
		{ id: 'e1', fromNode: 't1', fromSide: 'right', toNode: 'f1', toSide: 'left', label: 'details' },
		{ id: 'e2', fromNode: 'f1', toNode: 'l1', toEnd: 'none', fromEnd: 'arrow' },
	],
	metadata: { version: '1.0-1.0' },
};

describe('parseCanvas / serializeCanvas', () => {
	it('round-trips every field, including ones plugins add', () => {
		const { data, warnings } = parseCanvas(JSON.stringify(sample));
		expect(warnings).toEqual([]);
		expect(JSON.parse(serializeCanvas(data))).toEqual(sample);
		expect(serializeCanvas(data)).toContain('\n\t"nodes"');
	});

	it('treats an empty file as an empty canvas', () => {
		expect(parseCanvas('').data).toEqual({ nodes: [], edges: [] });
		expect(parseCanvas('{}').data).toEqual({ nodes: [], edges: [] });
	});

	it('skips what it cannot show, with reasons', () => {
		const { data, warnings } = parseCanvas(
			JSON.stringify({
				nodes: [
					{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'ok' },
					{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'dup' },
					{ id: 'b', type: 'video', x: 0, y: 0, width: 10, height: 10 },
					{ id: 'c', type: 'text', x: '1', y: 0, width: 10, height: 10, text: '' },
				],
				edges: [
					{ id: 'e', fromNode: 'a', toNode: 'missing' },
					{ id: 'f', fromNode: 'a', toNode: 'a', toSide: 'middle' },
				],
			}),
		);
		expect(data.nodes.map((n) => n.id)).toEqual(['a']);
		expect(data.edges).toEqual([]);
		expect(warnings).toEqual([
			'node 1: duplicate id',
			'node 2: unknown node type "video"',
			'node 3: x is not a number',
			'edge 0: toNode does not exist',
			'edge 1: invalid toSide',
		]);
	});

	it('rejects files that are not canvas JSON', () => {
		expect(() => parseCanvas('{nope')).toThrow(/Not a valid canvas file/);
		expect(() => parseCanvas('[]')).toThrow(/top level/);
	});
});

describe('geometry', () => {
	const data = parseCanvas(JSON.stringify(sample)).data as CanvasData;
	const byId = (id: string) => data.nodes.find((n) => n.id === id)!;

	it('routes edges between the named or facing sides', () => {
		const named = edgePath(data.edges[0]!, byId('t1'), byId('f1'));
		expect(named.from).toEqual({ x: 240, y: 80 });
		expect(named.to).toEqual({ x: 300, y: 140 });
		expect(named.d.startsWith('M240,80 C')).toBe(true);
		expect(facingSides(byId('f1'), byId('l1'))).toEqual(['right', 'left']);
		expect(facingSides(byId('t1'), byId('p1'))).toEqual(['bottom', 'top']);
	});

	it('finds the topmost node and group contents', () => {
		expect(nodeAt(data, { x: 50, y: 50 })?.id).toBe('t1');
		expect(nodeAt(data, { x: 550, y: 350 })?.id).toBe('g1');
		expect(nodeAt(data, { x: -10, y: -10 })).toBeNull();
		expect(groupChildren(data, byId('g1') as never).map((n) => n.id)).toEqual(['t1', 'f1']);
	});

	it('snaps and makes unique ids', () => {
		expect(snap(29, 20)).toBe(20);
		expect(snap(31, 20)).toBe(40);
		expect(snap(31, 0)).toBe(31);
		const id = newId(['a']);
		expect(id).toMatch(/^[0-9a-f]{16}$/);
	});
});
