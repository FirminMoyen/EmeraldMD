import { describe, expect, it } from 'vitest';
import { buildGraph, createSimulation, type GraphInput, type SimNode } from '../src';

const input: GraphInput = {
	files: [
		{ path: 'Home.md', extension: 'md' },
		{ path: 'Projects/Plan.md', extension: 'md' },
		{ path: 'Projects/Ideas.md', extension: 'md' },
		{ path: 'Lonely.md', extension: 'md' },
		{ path: 'Far.md', extension: 'md' },
		{ path: 'img.png', extension: 'png' },
	],
	resolvedLinks: {
		'Home.md': { 'Projects/Plan.md': 2, 'img.png': 1 },
		'Projects/Plan.md': { 'Home.md': 1, 'Projects/Ideas.md': 1 },
		'Projects/Ideas.md': { 'Far.md': 1 },
		'Lonely.md': {},
		'Far.md': {},
	},
	unresolvedLinks: { 'Home.md': { Someday: 1 } },
	tags: { 'Home.md': ['#start'], 'Projects/Plan.md': ['#project', '#start'] },
};

const ids = (data: ReturnType<typeof buildGraph>) => data.nodes.map((n) => n.id).sort();
const pairs = (data: ReturnType<typeof buildGraph>) => data.links.map((l) => `${l.source} -> ${l.target}`).sort();

describe('buildGraph', () => {
	it('shows notes and their links by default, one line per pair', () => {
		const data = buildGraph(input);
		expect(ids(data)).toEqual(['Far.md', 'Home.md', 'Lonely.md', 'Projects/Ideas.md', 'Projects/Plan.md']);
		expect(pairs(data)).toEqual([
			'Home.md -> Projects/Plan.md',
			'Projects/Ideas.md -> Far.md',
			'Projects/Plan.md -> Projects/Ideas.md',
		]);
		const home = data.nodes.find((n) => n.id === 'Home.md')!;
		expect(home).toMatchObject({ label: 'Home', kind: 'note', degree: 1 });
	});

	it('adds attachments, unresolved links and tags on request', () => {
		const data = buildGraph(input, { showAttachments: true, showUnresolved: true, showTags: true });
		const kinds = Object.fromEntries(data.nodes.map((n) => [n.id, n.kind]));
		expect(kinds).toMatchObject({ 'img.png': 'attachment', Someday: 'unresolved', '#start': 'tag', '#project': 'tag' });
		expect(data.nodes.find((n) => n.id === '#start')!.degree).toBe(2);
	});

	it('hides orphans', () => {
		expect(ids(buildGraph(input, { showOrphans: false }))).not.toContain('Lonely.md');
	});

	it('builds a local graph around a note', () => {
		expect(ids(buildGraph(input, { local: { center: 'Home.md', depth: 1 } }))).toEqual(['Home.md', 'Projects/Plan.md']);
		expect(ids(buildGraph(input, { local: { center: 'Home.md', depth: 2 } }))).toEqual([
			'Home.md',
			'Projects/Ideas.md',
			'Projects/Plan.md',
		]);
		// The centre stays even without links, also with orphans hidden.
		expect(ids(buildGraph(input, { local: { center: 'Lonely.md', depth: 3 }, showOrphans: false }))).toEqual(['Lonely.md']);
	});

	it('follows incoming or outgoing links only, and leaves out links between neighbours', () => {
		const tri: GraphInput = {
			files: ['C.md', 'A.md', 'B.md', 'D.md'].map((path) => ({ path, extension: 'md' })),
			resolvedLinks: { 'C.md': { 'A.md': 1, 'B.md': 1 }, 'A.md': { 'B.md': 1 }, 'D.md': { 'C.md': 1 } },
			unresolvedLinks: {},
			tags: {},
		};
		const local = (extra: object) => buildGraph(tri, { local: { center: 'C.md', depth: 1, ...extra } });
		expect(ids(local({}))).toEqual(['A.md', 'B.md', 'C.md', 'D.md']);
		expect(ids(local({ incoming: false }))).toEqual(['A.md', 'B.md', 'C.md']);
		expect(ids(local({ outgoing: false }))).toEqual(['C.md', 'D.md']);
		// A and B are both one link away: their link goes without neighbour links.
		expect(pairs(local({}))).toContain('A.md -> B.md');
		expect(pairs(local({ neighbors: false }))).not.toContain('A.md -> B.md');
	});

	it('filters by search text', () => {
		expect(ids(buildGraph(input, { search: 'projects/' }))).toEqual(['Projects/Ideas.md', 'Projects/Plan.md']);
	});
});

describe('layout', () => {
	it('pulls linked notes closer than unlinked ones and keeps known positions', () => {
		const data = buildGraph(input);
		const { simulation, nodes } = createSimulation(data);
		simulation.tick(300);
		const at = (id: string) => nodes.find((n) => n.id === id)!;
		const distance = (a: SimNode, b: SimNode) => Math.hypot(a.x! - b.x!, a.y! - b.y!);
		expect(distance(at('Home.md'), at('Projects/Plan.md'))).toBeLessThan(distance(at('Home.md'), at('Lonely.md')));

		const again = createSimulation(data, undefined, nodes);
		expect(again.nodes.find((n) => n.id === 'Home.md')!.x).toBe(at('Home.md').x);
	});
});
