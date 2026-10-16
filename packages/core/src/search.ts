/**
 * Search request and result shapes produced by the Rust core
 * (crates/emerald-core/src/search). Query syntax: docs/search.md.
 */

export type SearchSort =
	| 'path-asc'
	| 'path-desc'
	| 'modified-newest'
	| 'modified-oldest'
	| 'created-newest'
	| 'created-oldest';

export interface SearchOptions {
	/** Like prefixing the whole query with `match-case:`. */
	caseSensitive?: boolean;
	sort?: SearchSort;
	/** Maximum number of files returned. */
	limit?: number;
}

export interface SearchMatch {
	/** Zero-based line of the match start. */
	line: number;
	/** UTF-16 offsets in the document (usable as CodeMirror positions). */
	from: number;
	to: number;
	/** The line's text, shortened around the match when very long. */
	lineText: string;
	/** Offsets of the match inside `lineText`. */
	textFrom: number;
	textTo: number;
}

export interface SearchFileResult {
	path: string;
	/** The file name or path matched, besides or instead of the content. */
	nameMatched: boolean;
	/** At most 100 per file; see `matchCount`. */
	matches: SearchMatch[];
	matchCount: number;
}

export interface SearchResults {
	files: SearchFileResult[];
	/** Matching files before `limit` was applied. */
	totalFiles: number;
}

/** A query the core could not understand. */
export interface SearchError {
	message: string;
	/** Character index in the query. */
	position?: number;
}
