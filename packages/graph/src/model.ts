/**
 * Builds the node/link data for the graph view from the vault and its link
 * index. Pure functions, no DOM, so they are easy to test.
 */

import type { MetadataCache, TFile, Vault } from '@emeraldmd/core';

export type NodeKind = 'note' | 'attachment' | 'unresolved' | 'tag';

export interface GraphNode {
	/** File path, the link text for unresolved links, or `#tag` for tags. */
	id: string;
	label: string;
	kind: NodeKind;
	/** Number of links touching the node; drives its size. */
	degree: number;
}

export interface GraphLink {
	source: string;
	target: string;
}

export interface GraphData {
	nodes: GraphNode[];
	links: GraphLink[];
}

export interface GraphFilters {
	/** Only keep nodes whose id contains this text (case-insensitive). Empty keeps all. */
	search?: string;
	showTags?: boolean;
	showAttachments?: boolean;
	/** Links to notes that do not exist yet. */
	showUnresolved?: boolean;
	/** Nodes with no links at all. */
	showOrphans?: boolean;
	/** Local graph: only nodes within `depth` links of `center`. */
	local?: { center: string; depth: number };
}

/** What the graph needs from a vault, decoupled from the live objects. */
export interface GraphInput {
	files: { path: string; extension: string }[];
	resolvedLinks: Record<string, Record<string, number>>;
	unresolvedLinks: Record<string, Record<string, number>>;
	/** Tags per note path, with `#`. */
	tags: Record<string, string[]>;
}

const DEFAULTS: Required<Omit<GraphFilters, 'local' | 'search'>> = {
	showTags: false,
	showAttachments: false,
	showUnresolved: false,
	showOrphans: true,
};

function basename(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

/** Inline tags plus `tags`/`tag` frontmatter, de-duplicated, with `#`. */
export function tagsOf(metadataCache: MetadataCache, file: TFile): string[] {
	const cache = metadataCache.getFileCache(file);
	const tags = new Set<string>();
	for (const t of cache?.tags ?? []) tags.add(t.tag);
	const fm = cache?.frontmatter ?? {};
	for (const key of Object.keys(fm)) {
		if (!['tags', 'tag'].includes(key.toLowerCase())) continue;
		const value = fm[key];
		const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : [];
		for (const v of values) {
			if (typeof v === 'string' && v.trim()) tags.add(v.trim().startsWith('#') ? v.trim() : `#${v.trim()}`);
		}
	}
	return [...tags];
}

export function graphInputFromVault(vault: Vault, metadataCache: MetadataCache): GraphInput {
	const files = vault.getFiles();
	const tags: Record<string, string[]> = {};
	for (const file of files) {
		if (file.extension === 'md') tags[file.path] = tagsOf(metadataCache, file);
	}
	return {
		files: files.map((f) => ({ path: f.path, extension: f.extension })),
		resolvedLinks: metadataCache.resolvedLinks,
		unresolvedLinks: metadataCache.unresolvedLinks,
		tags,
	};
}

export function buildGraph(input: GraphInput, filters: GraphFilters = {}): GraphData {
	const f = { ...DEFAULTS, ...filters };
	const nodes = new Map<string, GraphNode>();
	const links: GraphLink[] = [];
	const add = (id: string, label: string, kind: NodeKind) => {
		if (!nodes.has(id)) nodes.set(id, { id, label, kind, degree: 0 });
	};

	for (const file of input.files) {
		if (file.extension === 'md') add(file.path, basename(file.path), 'note');
		else if (f.showAttachments) add(file.path, basename(file.path), 'attachment');
	}
	for (const [source, targets] of Object.entries(input.resolvedLinks)) {
		if (!nodes.has(source)) continue;
		for (const target of Object.keys(targets)) {
			if (target !== source && nodes.has(target)) links.push({ source, target });
		}
	}
	if (f.showUnresolved) {
		for (const [source, targets] of Object.entries(input.unresolvedLinks)) {
			if (!nodes.has(source)) continue;
			for (const target of Object.keys(targets)) {
				add(target, target, 'unresolved');
				links.push({ source, target });
			}
		}
	}
	if (f.showTags) {
		for (const [source, tags] of Object.entries(input.tags)) {
			if (!nodes.has(source)) continue;
			for (const tag of tags) {
				add(tag, tag, 'tag');
				links.push({ source, target: tag });
			}
		}
	}

	let keep = new Set(nodes.keys());
	if (filters.local) keep = neighbourhood(filters.local.center, filters.local.depth, links, keep);
	const search = filters.search?.trim().toLowerCase();
	if (search) keep = new Set([...keep].filter((id) => id.toLowerCase().includes(search)));

	const kept = dedupe(links.filter((l) => keep.has(l.source) && keep.has(l.target)));
	for (const l of kept) {
		nodes.get(l.source)!.degree++;
		nodes.get(l.target)!.degree++;
	}
	const result = [...nodes.values()].filter(
		(n) => keep.has(n.id) && (f.showOrphans || n.degree > 0 || n.id === filters.local?.center),
	);
	return { nodes: result, links: kept };
}

/** Nodes within `depth` links of `center`, following links both ways. */
function neighbourhood(center: string, depth: number, links: GraphLink[], within: Set<string>): Set<string> {
	if (!within.has(center)) return new Set();
	const adjacent = new Map<string, string[]>();
	for (const { source, target } of links) {
		(adjacent.get(source) ?? adjacent.set(source, []).get(source)!).push(target);
		(adjacent.get(target) ?? adjacent.set(target, []).get(target)!).push(source);
	}
	const seen = new Set([center]);
	let frontier = [center];
	for (let d = 0; d < depth && frontier.length; d++) {
		const next: string[] = [];
		for (const id of frontier) {
			for (const n of adjacent.get(id) ?? []) {
				if (!seen.has(n) && within.has(n)) {
					seen.add(n);
					next.push(n);
				}
			}
		}
		frontier = next;
	}
	return seen;
}

/** One link per unordered pair, so A→B and B→A draw one line. */
function dedupe(links: GraphLink[]): GraphLink[] {
	const seen = new Set<string>();
	return links.filter(({ source, target }) => {
		const key = source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
