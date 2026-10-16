/**
 * Data shapes produced by the Rust core (crates/emerald-core). Metadata field
 * names follow `CachedMetadata` in the public plugin API typings.
 */

import type { SearchOptions, SearchResults } from './search';

export interface FileEntry {
	path: string;
	kind: 'file' | 'folder';
	/** Milliseconds since the Unix epoch. */
	ctime: number;
	mtime: number;
	size: number;
}

export interface Loc {
	line: number;
	col: number;
	/** UTF-16 offset in the document. */
	offset: number;
}

export interface Pos {
	start: Loc;
	end: Loc;
}

export interface CacheItem {
	position: Pos;
}

export interface HeadingCache extends CacheItem {
	heading: string;
	level: number;
}

export interface ReferenceCache extends CacheItem {
	link: string;
	original: string;
	displayText?: string;
}

export type LinkCache = ReferenceCache;
export type EmbedCache = ReferenceCache;

export interface TagCache extends CacheItem {
	tag: string;
}

export interface BlockCache extends CacheItem {
	id: string;
}

export interface FrontmatterLinkCache {
	key: string;
	link: string;
	original: string;
	displayText?: string;
}

export type FrontMatterCache = Record<string, unknown>;

export interface CachedMetadata {
	links?: LinkCache[];
	embeds?: EmbedCache[];
	tags?: TagCache[];
	headings?: HeadingCache[];
	blocks?: Record<string, BlockCache>;
	frontmatter?: FrontMatterCache;
	frontmatterPosition?: Pos;
	frontmatterLinks?: FrontmatterLinkCache[];
}

export interface LinkSets {
	resolved: Record<string, number>;
	unresolved: Record<string, number>;
}

export interface VaultSnapshot {
	name: string;
	basePath: string;
	files: FileEntry[];
	metadata: Record<string, CachedMetadata>;
	links: Record<string, LinkSets>;
}

export interface VaultUpdate {
	/** `[from, to]`; only the moved item, not its descendants. */
	renamed: [string, string][];
	/** Children before parents. */
	removed: string[];
	/** Parents before children. */
	upserted: FileEntry[];
	metadata: Record<string, CachedMetadata>;
	links: Record<string, LinkSets>;
}

/** Where vault operations are executed: the local Rust core, or later a remote server. */
export interface VaultBackend {
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<VaultUpdate>;
	create(path: string, data: string): Promise<VaultUpdate>;
	createFolder(path: string): Promise<VaultUpdate>;
	rename(from: string, to: string): Promise<VaultUpdate>;
	/** Moves to the vault's `.trash` folder. */
	trash(path: string): Promise<VaultUpdate>;
	/** Full-text search with Obsidian's query syntax (docs/search.md), when the backend supports it. */
	search?(query: string, options?: SearchOptions): Promise<SearchResults>;
}
