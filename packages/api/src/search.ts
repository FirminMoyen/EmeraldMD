/** Fuzzy and simple search with match ranges, used by suggesters and the command palette. */

export type SearchMatchPart = [number, number];
export type SearchMatches = SearchMatchPart[];

export interface SearchResult {
	/** Higher is better. Scores are 0 or negative. */
	score: number;
	matches: SearchMatches;
}

export interface SearchResultContainer {
	match: SearchResult;
}

function mergeRanges(ranges: SearchMatches): SearchMatches {
	const out: SearchMatches = [];
	for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
		const last = out[out.length - 1];
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else out.push([start, end]);
	}
	return out;
}

const WORD_BOUNDARY = /[\s\-_./\\:()[\]]/;

/**
 * Matches the query's characters in order (case-insensitive). Matches that
 * start words and run contiguously score higher; gaps and late starts cost.
 */
export function prepareFuzzySearch(query: string): (text: string) => SearchResult | null {
	const needle = query.toLowerCase().replace(/\s+/g, ' ').trim();
	return (text: string) => {
		if (needle === '') return { score: 0, matches: [] };
		const hay = text.toLowerCase();
		const chars = [...needle].filter((c) => c !== ' ');
		const matches: SearchMatches = [];
		let score = 0;
		let pos = 0;
		let prev = -2;
		for (const ch of chars) {
			let found = hay.indexOf(ch, pos);
			// Prefer a match at a word start if one exists further on.
			if (found !== -1 && found !== prev + 1) {
				for (let i = found; i !== -1; i = hay.indexOf(ch, i + 1)) {
					if (i === 0 || WORD_BOUNDARY.test(hay[i - 1]!)) {
						found = i;
						break;
					}
				}
			}
			if (found === -1) return null;
			const wordStart = found === 0 || WORD_BOUNDARY.test(hay[found - 1]!);
			if (found === prev + 1) score += 0;
			else score -= wordStart ? 1 : 3 + Math.min(found - pos, 10) * 0.1;
			matches.push([found, found + 1]);
			prev = found;
			pos = found + 1;
		}
		score -= matches[0]![0] * 0.01 + text.length * 0.001;
		return { score, matches: mergeRanges(matches) };
	};
}

/** Every space-separated word of the query must occur in the text. */
export function prepareSimpleSearch(query: string): (text: string) => SearchResult | null {
	const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '');
	return (text: string) => {
		if (words.length === 0) return { score: 0, matches: [] };
		const hay = text.toLowerCase();
		const matches: SearchMatches = [];
		let score = 0;
		for (const word of words) {
			const i = hay.indexOf(word);
			if (i === -1) return null;
			matches.push([i, i + word.length]);
			score -= i * 0.01;
		}
		return { score, matches: mergeRanges(matches) };
	};
}

export function fuzzySearch(q: { query: string; tokens?: string[]; fuzzy?: string[] } | string, text: string): SearchResult | null {
	return prepareFuzzySearch(typeof q === 'string' ? q : q.query)(text);
}

export function sortSearchResults(results: SearchResultContainer[]): void {
	results.sort((a, b) => b.match.score - a.match.score);
}

/** Appends `text` to `el`, wrapping matched ranges in `.suggestion-highlight` spans. */
export function renderMatches(el: HTMLElement | DocumentFragment, text: string, matches: SearchMatches | null, offset = 0): void {
	let pos = 0;
	for (const [rawStart, rawEnd] of matches ?? []) {
		const start = Math.max(0, rawStart - offset);
		const end = Math.min(text.length, rawEnd - offset);
		if (end <= start || start < pos) continue;
		if (start > pos) el.appendChild(document.createTextNode(text.slice(pos, start)));
		const span = document.createElement('span');
		span.className = 'suggestion-highlight';
		span.textContent = text.slice(start, end);
		el.appendChild(span);
		pos = end;
	}
	if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
}

export function renderResults(el: HTMLElement, text: string, result: SearchResult, offset = 0): void {
	renderMatches(el, text, result.matches, offset);
}
