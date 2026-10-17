import type { SearchOptions, SearchResults, TFile } from '@emeraldmd/core';

/** What the built-in views need from the app shell. */
export interface CoreViewHost {
	/** Full-text search on the open vault's backend, if it supports it. */
	search?: (query: string, options?: SearchOptions) => Promise<SearchResults>;
	/** Opens a file in the main area; `select` is a UTF-16 range to select in a note. */
	openFile(file: TFile, select?: { from: number; to: number }): Promise<void>;
	/** Shows the search pane with this query. */
	openSearch(query: string): Promise<void>;
}

/** Messages from Tauri commands arrive as strings, others as errors. */
export function errorText(err: unknown): string {
	if (typeof err === 'string') return err;
	if (err instanceof Error) return err.message;
	return String(err);
}
