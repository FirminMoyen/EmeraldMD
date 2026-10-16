/** Force-directed layout (d3-force), shared by the view and the tests. */

import {
	forceCollide,
	forceLink,
	forceManyBody,
	forceX,
	forceY,
	forceSimulation,
	type Simulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from 'd3-force';
import type { GraphData, GraphNode } from './model';

export interface SimNode extends SimulationNodeDatum, GraphNode {}
export type SimLink = SimulationLinkDatum<SimNode>;

/** Like the sliders in Obsidian's graph settings. */
export interface GraphForces {
	/** Pull towards the middle. */
	center: number;
	/** Push between all nodes (positive; applied as repulsion). */
	repel: number;
	/** How strongly links pull their ends together, 0–1. */
	link: number;
	/** Preferred link length in pixels. */
	linkDistance: number;
}

export const DEFAULT_FORCES: GraphForces = { center: 0.05, repel: 120, link: 0.6, linkDistance: 60 };

export function nodeRadius(node: GraphNode): number {
	return 3 + Math.sqrt(node.degree) * 1.6;
}

/**
 * A stopped simulation for `data`. Nodes keep the positions of nodes with the
 * same id in `previous`, so updates do not scramble the layout.
 */
export function createSimulation(
	data: GraphData,
	forces: GraphForces = DEFAULT_FORCES,
	previous: SimNode[] = [],
): { simulation: Simulation<SimNode, SimLink>; nodes: SimNode[]; links: SimLink[] } {
	const old = new Map(previous.map((n) => [n.id, n]));
	const nodes: SimNode[] = data.nodes.map((n, i) => {
		const prev = old.get(n.id);
		if (prev) return { ...n, x: prev.x, y: prev.y, vx: prev.vx, vy: prev.vy };
		// Deterministic start on a spiral, so layouts are reproducible.
		const angle = i * 2.399963;
		const r = 10 * Math.sqrt(i + 1);
		return { ...n, x: r * Math.cos(angle), y: r * Math.sin(angle) };
	});
	const links: SimLink[] = data.links.map((l) => ({ source: l.source, target: l.target }));
	const simulation = forceSimulation<SimNode, SimLink>(nodes)
		.force(
			'link',
			forceLink<SimNode, SimLink>(links)
				.id((n) => n.id)
				.distance(forces.linkDistance)
				.strength(forces.link),
		)
		.force('charge', forceManyBody<SimNode>().strength(-forces.repel).distanceMax(600))
		.force('x', forceX<SimNode>(0).strength(forces.center))
		.force('y', forceY<SimNode>(0).strength(forces.center))
		.force('collide', forceCollide<SimNode>((n) => nodeRadius(n) + 2))
		.stop();
	return { simulation, nodes, links };
}
