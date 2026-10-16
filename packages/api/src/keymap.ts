/**
 * Keyboard scopes. The app keeps a stack of scopes; a keydown goes to the
 * top scope, then to its parents. Modals push their own scope while open.
 */

export type Modifier = 'Mod' | 'Ctrl' | 'Meta' | 'Shift' | 'Alt';

export interface KeymapInfo {
	/** Comma-separated, e.g. "Mod,Shift". `null` matches any modifiers. */
	modifiers: string | null;
	/** `null` matches any key. */
	key: string | null;
}

export interface KeymapContext extends KeymapInfo {
	vkey: string;
}

export type KeymapEventListener = (evt: KeyboardEvent, ctx: KeymapContext) => false | unknown;

export interface KeymapEventHandler extends KeymapInfo {
	scope: Scope;
	/** @internal */
	func: KeymapEventListener;
}

export interface Hotkey {
	modifiers: Modifier[];
	key: string;
}

export const isMacOS = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const MODIFIER_ORDER: Modifier[] = ['Mod', 'Ctrl', 'Meta', 'Shift', 'Alt'];

/** The modifiers held during `evt`, with Cmd (macOS) or Ctrl (elsewhere) reported as "Mod". */
export function eventModifiers(evt: KeyboardEvent | MouseEvent): Modifier[] {
	const mods: Modifier[] = [];
	const mod = isMacOS ? evt.metaKey : evt.ctrlKey;
	if (mod) mods.push('Mod');
	if (evt.ctrlKey && isMacOS) mods.push('Ctrl');
	if (evt.metaKey && !isMacOS) mods.push('Meta');
	if (evt.shiftKey) mods.push('Shift');
	if (evt.altKey) mods.push('Alt');
	return mods;
}

function normalizeModifiers(modifiers: readonly string[]): string {
	const set = new Set(
		modifiers.map((m) => {
			if (m === 'Ctrl' && !isMacOS) return 'Mod';
			if (m === 'Meta' && isMacOS) return 'Mod';
			return m;
		}),
	);
	return MODIFIER_ORDER.filter((m) => set.has(m)).join(',');
}

/** The key as written in hotkeys: letters upper-case, everything else as `KeyboardEvent.key`. */
export function eventKey(evt: KeyboardEvent): string {
	// With Alt or Shift held, `key` is the produced character; `code` tells the physical key.
	const code = evt.code;
	if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	if (/^Digit[0-9]$/.test(code)) return code.slice(5);
	return evt.key.length === 1 ? evt.key.toUpperCase() : evt.key;
}

function keyMatches(handlerKey: string, evt: KeyboardEvent): boolean {
	const key = handlerKey.length === 1 ? handlerKey.toUpperCase() : handlerKey;
	return key === eventKey(evt) || key === evt.key;
}

export class Scope {
	/** @internal */
	keys: KeymapEventHandler[] = [];
	/** @internal */
	parent: Scope | undefined;

	constructor(parent?: Scope) {
		this.parent = parent;
	}

	register(modifiers: Modifier[] | null, key: string | null, func: KeymapEventListener): KeymapEventHandler {
		const handler: KeymapEventHandler = {
			scope: this,
			modifiers: modifiers === null ? null : normalizeModifiers(modifiers),
			key,
			func,
		};
		this.keys.push(handler);
		return handler;
	}

	unregister(handler: KeymapEventHandler): void {
		this.keys = this.keys.filter((h) => h !== handler);
	}

	/** @internal Runs the first matching handler here or in a parent. Returns false if the event was handled and should be prevented. */
	handleKey(evt: KeyboardEvent, info: KeymapContext): false | unknown {
		for (const handler of [...this.keys].reverse()) {
			if (handler.modifiers !== null && handler.modifiers !== info.modifiers) continue;
			if (handler.key !== null && !keyMatches(handler.key, evt)) continue;
			const result = handler.func(evt, info);
			if (result === false) return false;
		}
		return this.parent?.handleKey(evt, info);
	}
}

export class Keymap {
	/** @internal */
	readonly rootScope: Scope;
	private readonly scopes: Scope[] = [];

	constructor(rootScope: Scope) {
		this.rootScope = rootScope;
	}

	pushScope(scope: Scope): void {
		this.popScope(scope);
		this.scopes.push(scope);
	}

	popScope(scope: Scope): void {
		const i = this.scopes.lastIndexOf(scope);
		if (i !== -1) this.scopes.splice(i, 1);
	}

	/** @internal */
	getRootScope(): Scope {
		return this.rootScope;
	}

	/** @internal Dispatches a keydown to the active scope. Returns true if a handler consumed it. */
	onKeyEvent(evt: KeyboardEvent): boolean {
		if (evt.isComposing) return false;
		const scope = this.scopes[this.scopes.length - 1] ?? this.rootScope;
		const info: KeymapContext = {
			modifiers: normalizeModifiers(eventModifiers(evt)),
			key: eventKey(evt),
			vkey: eventKey(evt),
		};
		if (scope.handleKey(evt, info) === false) {
			evt.preventDefault();
			evt.stopPropagation();
			return true;
		}
		return false;
	}

	static isModifier(evt: MouseEvent | TouchEvent | KeyboardEvent, modifier: Modifier): boolean {
		switch (modifier) {
			case 'Mod':
				return isMacOS ? evt.metaKey : evt.ctrlKey;
			case 'Ctrl':
				return evt.ctrlKey;
			case 'Meta':
				return evt.metaKey;
			case 'Shift':
				return evt.shiftKey;
			case 'Alt':
				return evt.altKey;
		}
	}

	/** Whether a click should open in a new pane, and which kind. */
	static isModEvent(evt?: MouseEvent | KeyboardEvent | TouchEvent | null): 'tab' | 'split' | 'window' | boolean {
		if (!evt) return false;
		const mod = Keymap.isModifier(evt, 'Mod');
		if (mod && evt.altKey && evt.shiftKey) return 'window';
		if (mod && evt.altKey) return 'split';
		if (mod || (evt instanceof MouseEvent && evt.button === 1)) return 'tab';
		return false;
	}
}

/** Human-readable hotkey, e.g. "⌘ ⇧ P" on macOS or "Ctrl + Shift + P" elsewhere. */
export function formatHotkey(hotkey: Hotkey): string {
	const names: Record<Modifier, string> = isMacOS
		? { Mod: '⌘', Ctrl: '⌃', Meta: '⌘', Shift: '⇧', Alt: '⌥' }
		: { Mod: 'Ctrl', Ctrl: 'Ctrl', Meta: 'Win', Shift: 'Shift', Alt: 'Alt' };
	const parts = MODIFIER_ORDER.filter((m) => hotkey.modifiers.includes(m)).map((m) => names[m]);
	parts.push(hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key);
	return parts.join(isMacOS ? ' ' : ' + ');
}
