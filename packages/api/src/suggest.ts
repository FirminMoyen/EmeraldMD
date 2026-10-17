/**
 * Suggesters: the prompt-style `SuggestModal` (command palette, quick
 * switchers) and popovers attached to inputs (`AbstractInputSuggest`) or the
 * editor cursor (`EditorSuggest`).
 */

import type { TFile } from '@emeraldmd/core';
import { Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view';
import type { App } from './app';
import { editorInfoField, type Editor, type EditorPosition } from './editor';
import { Scope } from './keymap';
import { Modal } from './modal';
import { prepareFuzzySearch, renderResults, sortSearchResults, type SearchResult } from './search';

export interface Instruction {
	command: string;
	purpose: string;
}

export interface ISuggestOwner<T> {
	renderSuggestion(value: T, el: HTMLElement): void;
	selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;
}

/** Renders a list of values and tracks the highlighted one. */
class SuggestionList<T> {
	values: T[] = [];
	selected = 0;
	afterSelect: (() => void) | null = null;
	private items: HTMLElement[] = [];

	constructor(
		private readonly containerEl: HTMLElement,
		private readonly owner: ISuggestOwner<T>,
	) {
		containerEl.addEventListener('mousedown', (evt) => evt.preventDefault());
	}

	set(values: T[], emptyText?: string): void {
		this.values = values;
		this.containerEl.empty();
		this.items = values.map((value, i) => {
			const el = this.containerEl.createDiv('suggestion-item');
			try {
				this.owner.renderSuggestion(value, el);
			} catch (err) {
				console.error(err);
			}
			el.addEventListener('mousemove', () => this.select(i));
			el.addEventListener('click', (evt) => {
				this.select(i);
				this.owner.selectSuggestion(value, evt);
				this.afterSelect?.();
			});
			return el;
		});
		if (values.length === 0 && emptyText) this.containerEl.createDiv({ cls: 'suggestion-empty', text: emptyText });
		this.select(0);
	}

	select(index: number): void {
		this.items[this.selected]?.removeClass('is-selected');
		this.selected = this.values.length ? (index + this.values.length) % this.values.length : 0;
		const el = this.items[this.selected];
		el?.addClass('is-selected');
		el?.scrollIntoView?.({ block: 'nearest' });
	}

	move(delta: number): void {
		this.select(this.selected + delta);
	}

	get current(): T | undefined {
		return this.values[this.selected];
	}

	useSelected(evt: MouseEvent | KeyboardEvent): boolean {
		const value = this.current;
		if (value === undefined) return false;
		this.owner.selectSuggestion(value, evt);
		this.afterSelect?.();
		return true;
	}
}

export abstract class SuggestModal<T> extends Modal implements ISuggestOwner<T> {
	limit = 50;
	emptyStateText = 'No results found.';
	inputEl: HTMLInputElement;
	resultContainerEl: HTMLElement;
	private instructionsEl: HTMLElement;
	private readonly list: SuggestionList<T>;
	private queryId = 0;

	constructor(app: App) {
		super(app);
		this.modalEl.empty();
		this.modalEl.addClass('prompt');
		const inputContainer = this.modalEl.createDiv('prompt-input-container');
		this.inputEl = inputContainer.createEl('input', { cls: 'prompt-input', type: 'text', attr: { enterkeyhint: 'done', spellcheck: 'false' } });
		this.resultContainerEl = this.modalEl.createDiv('prompt-results');
		this.instructionsEl = this.modalEl.createDiv('prompt-instructions');
		this.list = new SuggestionList<T>(this.resultContainerEl, this);
		this.inputEl.addEventListener('input', () => void this.updateSuggestions());
		const nav = (delta: number) => (evt: KeyboardEvent) => {
			if (!evt.isComposing) this.list.move(delta);
			return false;
		};
		this.scope.register([], 'ArrowUp', nav(-1));
		this.scope.register([], 'ArrowDown', nav(1));
		this.scope.register(['Ctrl'], 'p', nav(-1));
		this.scope.register(['Ctrl'], 'n', nav(1));
		this.scope.register([], 'Enter', (evt) => {
			if (evt.isComposing) return;
			this.selectActiveSuggestion(evt);
			return false;
		});
	}

	setPlaceholder(placeholder: string): void {
		this.inputEl.placeholder = placeholder;
	}

	setInstructions(instructions: Instruction[]): void {
		this.instructionsEl.empty();
		for (const { command, purpose } of instructions) {
			const el = this.instructionsEl.createDiv('prompt-instruction');
			el.createSpan({ cls: 'prompt-instruction-command', text: command });
			el.createSpan({ text: purpose });
		}
	}

	onNoSuggestion(): void {
		this.list.set([], this.emptyStateText);
	}

	selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
		this.close();
		this.onChooseSuggestion(value, evt);
	}

	selectActiveSuggestion(evt: MouseEvent | KeyboardEvent): void {
		this.list.useSelected(evt);
	}

	override open(): void {
		super.open();
		this.inputEl.focus();
		void this.updateSuggestions();
	}

	/** @internal */
	async updateSuggestions(): Promise<void> {
		const id = ++this.queryId;
		const values = await this.getSuggestions(this.inputEl.value);
		if (id !== this.queryId) return;
		const shown = this.limit > 0 ? values.slice(0, this.limit) : values;
		if (shown.length === 0) this.onNoSuggestion();
		else this.list.set(shown);
	}

	abstract getSuggestions(query: string): T[] | Promise<T[]>;
	abstract renderSuggestion(value: T, el: HTMLElement): void;
	abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;
}

export interface FuzzyMatch<T> {
	item: T;
	match: SearchResult;
}

export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
	getSuggestions(query: string): FuzzyMatch<T>[] {
		const search = prepareFuzzySearch(query);
		const results: FuzzyMatch<T>[] = [];
		for (const item of this.getItems()) {
			const match = search(this.getItemText(item));
			if (match) results.push({ item, match });
		}
		if (query.trim() !== '') sortSearchResults(results);
		return results;
	}

	renderSuggestion(item: FuzzyMatch<T>, el: HTMLElement): void {
		renderResults(el, this.getItemText(item.item), item.match);
	}

	onChooseSuggestion(item: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void {
		this.onChooseItem(item.item, evt);
	}

	abstract getItems(): T[];
	abstract getItemText(item: T): string;
	abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;
}

/** A floating suggestion list (`.suggestion-container`). */
export abstract class PopoverSuggest<T> implements ISuggestOwner<T> {
	app: App;
	scope: Scope;
	/** @internal */
	suggestEl: HTMLElement;
	/** @internal */
	isOpen = false;
	/** @internal */
	readonly suggestions: SuggestionList<T>;
	/** @internal */
	instructionsEl: HTMLElement;

	constructor(app: App, scope?: Scope) {
		this.app = app;
		this.scope = new Scope(scope ?? app.scope);
		this.suggestEl = createDiv('suggestion-container');
		const listEl = this.suggestEl.createDiv('suggestion');
		this.instructionsEl = this.suggestEl.createDiv('prompt-instructions');
		this.suggestions = new SuggestionList<T>(listEl, this);
		const nav = (delta: number) => () => {
			this.suggestions.move(delta);
			return false;
		};
		this.scope.register([], 'ArrowUp', nav(-1));
		this.scope.register([], 'ArrowDown', nav(1));
		this.scope.register([], 'Enter', (evt) => {
			this.suggestions.useSelected(evt);
			return false;
		});
		this.scope.register([], 'Escape', () => {
			this.close();
			return false;
		});
	}

	onHistoryBack(): void {
		this.close();
	}

	open(): void {
		if (this.isOpen) return;
		this.isOpen = true;
		document.body.appendChild(this.suggestEl);
		this.app.keymap.pushScope(this.scope);
	}

	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.app.keymap.popScope(this.scope);
		this.suggestEl.detach();
	}

	/** @internal Positions the popover below `rect`. */
	reposition(rect: { left: number; bottom: number; top: number }): void {
		this.suggestEl.style.left = `${Math.max(0, rect.left)}px`;
		this.suggestEl.style.top = `${rect.bottom + 4}px`;
	}

	abstract renderSuggestion(value: T, el: HTMLElement): void;
	abstract selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;
}

export abstract class AbstractInputSuggest<T> extends PopoverSuggest<T> {
	limit = 100;
	private readonly textInputEl: HTMLInputElement | HTMLDivElement;
	private selectCallback: ((value: T, evt: MouseEvent | KeyboardEvent) => unknown) | null = null;
	private queryId = 0;

	constructor(app: App, textInputEl: HTMLInputElement | HTMLDivElement) {
		super(app);
		this.textInputEl = textInputEl;
		textInputEl.addEventListener('input', () => void this.onInputChange());
		textInputEl.addEventListener('focus', () => void this.onInputChange());
		textInputEl.addEventListener('blur', () => this.close());
	}

	setValue(value: string): void {
		if (this.textInputEl instanceof HTMLInputElement) this.textInputEl.value = value;
		else this.textInputEl.textContent = value;
		this.textInputEl.dispatchEvent(new Event('input'));
	}

	getValue(): string {
		return this.textInputEl instanceof HTMLInputElement ? this.textInputEl.value : (this.textInputEl.textContent ?? '');
	}

	protected abstract getSuggestions(query: string): T[] | Promise<T[]>;

	selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
		this.selectCallback?.(value, evt);
	}

	onSelect(callback: (value: T, evt: MouseEvent | KeyboardEvent) => unknown): this {
		this.selectCallback = callback;
		return this;
	}

	private async onInputChange(): Promise<void> {
		const id = ++this.queryId;
		const values = await this.getSuggestions(this.getValue());
		if (id !== this.queryId) return;
		if (values.length === 0) {
			this.close();
			return;
		}
		this.suggestions.set(this.limit > 0 ? values.slice(0, this.limit) : values);
		this.open();
		this.reposition(this.textInputEl.getBoundingClientRect());
	}
}

export interface EditorSuggestTriggerInfo {
	start: EditorPosition;
	end: EditorPosition;
	query: string;
}

export interface EditorSuggestContext extends EditorSuggestTriggerInfo {
	editor: Editor;
	file: TFile;
}

export abstract class EditorSuggest<T> extends PopoverSuggest<T> {
	context: EditorSuggestContext | null = null;
	limit = 100;
	private queryId = 0;

	constructor(app: App) {
		super(app);
		// Keys go to the editor rather than the scope stack; `editorSuggestExtension` routes them here.
		this.suggestions.afterSelect = () => this.close();
	}

	setInstructions(instructions: Instruction[]): void {
		this.instructionsEl.empty();
		for (const { command, purpose } of instructions) {
			const el = this.instructionsEl.createDiv('prompt-instruction');
			el.createSpan({ cls: 'prompt-instruction-command', text: command });
			el.createSpan({ text: purpose });
		}
	}

	override open(): void {
		if (this.isOpen) return;
		this.isOpen = true;
		document.body.appendChild(this.suggestEl);
	}

	override close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.context = null;
		this.suggestEl.detach();
	}

	/** @internal Called after edits; returns true if this suggester is now showing. */
	async trigger(editor: Editor, file: TFile | null, view: EditorView): Promise<boolean> {
		const info = this.onTrigger(editor.getCursor(), editor, file);
		if (!info) {
			this.close();
			return false;
		}
		const context: EditorSuggestContext = { ...info, editor, file: file as TFile };
		this.context = context;
		const id = ++this.queryId;
		const values = await this.getSuggestions(context);
		if (id !== this.queryId || this.context !== context) return this.isOpen;
		if (!values || values.length === 0) {
			this.close();
			return false;
		}
		this.suggestions.set(this.limit > 0 ? values.slice(0, this.limit) : values);
		this.open();
		this.context = context;
		const coords = view.coordsAtPos(editor.posToOffset(info.start));
		if (coords) this.reposition(coords);
		return true;
	}

	abstract onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null;
	abstract getSuggestions(context: EditorSuggestContext): T[] | Promise<T[]>;
}

/** Registered editor suggesters (`app.workspace.editorSuggest`). */
export class EditorSuggests {
	suggests: EditorSuggest<unknown>[] = [];
	/** @internal The one currently showing, if any. */
	current: EditorSuggest<unknown> | null = null;

	addSuggest(suggest: EditorSuggest<unknown>): void {
		this.suggests.unshift(suggest);
	}

	removeSuggest(suggest: EditorSuggest<unknown>): void {
		this.suggests = this.suggests.filter((s) => s !== suggest);
		if (this.current === suggest) this.close();
	}

	close(): void {
		this.current?.close();
		this.current = null;
	}

	/** @internal */
	async trigger(view: EditorView): Promise<void> {
		const info = view.state.field(editorInfoField, false);
		const editor = info?.editor;
		if (!editor) return;
		for (const suggest of this.suggests) {
			if (await suggest.trigger(editor, info.file, view)) {
				if (this.current && this.current !== suggest) this.current.close();
				this.current = suggest;
				return;
			}
		}
		this.close();
	}
}

/** Runs editor suggesters after typing and routes navigation keys to the open one. */
export function editorSuggestExtension(suggests: EditorSuggests): Extension {
	const withOpen = (fn: (s: EditorSuggest<unknown>) => void) => () => {
		const current = suggests.current;
		if (!current?.isOpen) return false;
		fn(current);
		return true;
	};
	return [
		ViewPlugin.define((view) => ({
			update(update: ViewUpdate) {
				const typed = update.transactions.some((tr) => tr.isUserEvent('input') || tr.isUserEvent('delete'));
				if (typed) void suggests.trigger(view);
				else if (update.selectionSet || update.docChanged) suggests.close();
			},
			destroy() {
				suggests.close();
			},
		})),
		Prec.highest(
			keymap.of([
				{ key: 'ArrowUp', run: withOpen((s) => s.suggestions.move(-1)) },
				{ key: 'ArrowDown', run: withOpen((s) => s.suggestions.move(1)) },
				{ key: 'Enter', run: withOpen((s) => s.suggestions.useSelected(new KeyboardEvent('keydown', { key: 'Enter' }))) },
				{ key: 'Tab', run: withOpen((s) => s.suggestions.useSelected(new KeyboardEvent('keydown', { key: 'Tab' }))) },
				{ key: 'Escape', run: withOpen((s) => s.close()) },
			]),
		),
		EditorView.domEventHandlers({ blur: () => void setTimeout(() => suggests.close(), 150) }),
	];
}
