/**
 * Search (and replace) in the note, at the top of the editor as in
 * Obsidian: `.document-search-container > .document-search` (field with the
 * match count, previous/next, match case, regex, replace, close) and
 * `.document-replace` (field, Replace, Replace all). Built on CodeMirror's
 * search state, so its highlighting and commands (F3, ⌘G) keep working.
 */

import {
	closeSearchPanel,
	findNext,
	findPrevious,
	getSearchQuery,
	openSearchPanel,
	replaceAll,
	replaceNext,
	search,
	SearchQuery,
	setSearchQuery,
} from '@codemirror/search';
import type { EditorState } from '@codemirror/state';
import type { EditorView, Panel } from '@codemirror/view';

const ICONS: Record<string, string> = {
	up: '<path d="m18 15-6-6-6 6"/>',
	down: '<path d="m6 9 6 6 6-6"/>',
	replace: '<path d="M14 4a2 2 0 0 1 2-2"/><path d="M16 10a2 2 0 0 1-2-2"/><path d="M20 2a2 2 0 0 1 2 2"/><path d="M22 8a2 2 0 0 1-2 2"/><path d="m3 7 3 3 3-3"/><path d="M6 10V5a3 3 0 0 1 3-3h1"/><rect x="2" y="14" width="8" height="8" rx="2"/>',
	close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

function button(cls: string, label: string, content: string, svg = true): HTMLElement {
	const el = document.createElement('div');
	el.className = `document-search-button clickable-icon ${cls}`;
	el.setAttribute('aria-label', label);
	el.title = label;
	el.innerHTML = svg ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${content}</svg>` : content;
	return el;
}

/** "3 of 12", or "No results", for the query in `state`. */
function countOf(state: EditorState, query: SearchQuery): string {
	if (!query.search || !query.valid) return '';
	const cursor = query.getCursor(state);
	const head = state.selection.main;
	let total = 0;
	let current = 0;
	for (let next = cursor.next(); !next.done && total < 10_000; next = cursor.next()) {
		total++;
		if (next.value.from === head.from && next.value.to === head.to) current = total;
	}
	if (!total) return 'No results';
	return current ? `${current} of ${total}` : `${total} result${total === 1 ? '' : 's'}`;
}

function createPanel(view: EditorView): Panel {
	const dom = document.createElement('div');
	dom.className = 'document-search-container';
	const row = dom.appendChild(document.createElement('div'));
	row.className = 'document-search';
	const field = row.appendChild(document.createElement('div'));
	field.className = 'document-search-field';
	const input = field.appendChild(document.createElement('input'));
	input.className = 'document-search-input';
	input.type = 'text';
	input.placeholder = 'Find…';
	input.setAttribute('main-field', 'true');
	input.spellcheck = false;
	const count = field.appendChild(document.createElement('span'));
	count.className = 'document-search-count';
	const buttons = row.appendChild(document.createElement('div'));
	buttons.className = 'document-search-buttons';
	const prev = buttons.appendChild(button('mod-prev', 'Previous (⇧↩)', ICONS.up!));
	const next = buttons.appendChild(button('mod-next', 'Next (↩)', ICONS.down!));
	const matchCase = buttons.appendChild(button('mod-case', 'Match case', 'Aa', false));
	const regexp = buttons.appendChild(button('mod-regex', 'Regular expression', '.*', false));
	const toggleReplace = buttons.appendChild(button('mod-replace', 'Replace', ICONS.replace!));
	const close = buttons.appendChild(button('document-search-close-button', 'Close (Esc)', ICONS.close!));

	const replaceRow = dom.appendChild(document.createElement('div'));
	replaceRow.className = 'document-replace';
	const replaceInput = replaceRow.appendChild(document.createElement('input'));
	replaceInput.className = 'document-replace-input';
	replaceInput.type = 'text';
	replaceInput.placeholder = 'Replace…';
	replaceInput.spellcheck = false;
	const replaceOne = replaceRow.appendChild(document.createElement('button'));
	replaceOne.className = 'document-replace-button';
	replaceOne.textContent = 'Replace';
	const replaceEvery = replaceRow.appendChild(document.createElement('button'));
	replaceEvery.className = 'document-replace-button mod-all';
	replaceEvery.textContent = 'Replace all';

	let query = getSearchQuery(view.state);
	let replacing = false;
	const showReplace = (on: boolean) => {
		replacing = on;
		dom.toggleAttribute('data-replace', on);
		replaceRow.hidden = !on;
		toggleReplace.classList.toggle('is-active', on);
	};
	const render = () => {
		// Only when it differs, so the caret stays where it is while typing.
		if (input.value !== query.search) input.value = query.search;
		if (replaceInput.value !== query.replace) replaceInput.value = query.replace;
		matchCase.classList.toggle('is-active', query.caseSensitive);
		regexp.classList.toggle('is-active', query.regexp);
		count.textContent = countOf(view.state, query);
		dom.classList.toggle('mod-no-results', count.textContent === 'No results');
	};
	const commit = (changes: Partial<ConstructorParameters<typeof SearchQuery>[0]>) => {
		query = new SearchQuery({ search: query.search, caseSensitive: query.caseSensitive, regexp: query.regexp, wholeWord: query.wholeWord, replace: query.replace, ...changes });
		view.dispatch({ effects: setSearchQuery.of(query) });
	};
	input.addEventListener('input', () => {
		commit({ search: input.value });
		// Like typing in Obsidian's search: the first match from the cursor gets selected.
		if (input.value) findNext(view);
		render();
	});
	replaceInput.addEventListener('input', () => commit({ replace: replaceInput.value }));
	input.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			if (event.shiftKey) findPrevious(view);
			else findNext(view);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			closeSearchPanel(view);
			view.focus();
		}
	});
	replaceInput.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			if (event.metaKey || event.ctrlKey) replaceAll(view);
			else replaceNext(view);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			closeSearchPanel(view);
			view.focus();
		}
	});
	prev.addEventListener('click', () => findPrevious(view));
	next.addEventListener('click', () => findNext(view));
	matchCase.addEventListener('click', () => (commit({ caseSensitive: !query.caseSensitive }), render()));
	regexp.addEventListener('click', () => (commit({ regexp: !query.regexp }), render()));
	toggleReplace.addEventListener('click', () => {
		showReplace(!replacing);
		(replacing ? replaceInput : input).focus();
	});
	close.addEventListener('click', () => {
		closeSearchPanel(view);
		view.focus();
	});
	replaceOne.addEventListener('click', () => replaceNext(view));
	replaceEvery.addEventListener('click', () => replaceAll(view));
	showReplace(wantReplace.has(view));
	wantReplace.delete(view);
	render();

	return {
		dom,
		top: true,
		mount: () => {
			input.focus();
			input.select();
		},
		update: (update) => {
			const latest = getSearchQuery(update.state);
			const changed = !latest.eq(query);
			if (changed) query = latest;
			if (changed || update.docChanged || update.selectionSet) render();
		},
	};
}

/** Editors whose next search panel opens with the replace row. */
const wantReplace = new WeakSet<EditorView>();

/** The search extension with this panel at the top of the editor. */
export function documentSearch() {
	return search({ top: true, createPanel });
}

/** Opens the search panel (with the replace row), or focuses it if it is open. */
export function openDocumentSearch(view: EditorView, replace = false): void {
	if (replace) wantReplace.add(view);
	const open = view.dom.querySelector('.document-search-container');
	if (open) {
		if (replace && !open.hasAttribute('data-replace')) open.querySelector<HTMLElement>('.mod-replace')?.click();
		open.querySelector<HTMLInputElement>(replace ? '.document-replace-input' : '.document-search-input')?.focus();
		wantReplace.delete(view);
		return;
	}
	openSearchPanel(view);
}
