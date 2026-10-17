/**
 * `app.hotkeyManager`: each command's hotkeys, the defaults it declares and
 * the user's own. The user's are stored in `<configDir>/hotkeys.json` as
 * `{ "command-id": [{ "modifiers": ["Mod", "Shift"], "key": "K" }] }`; an
 * empty list means the command has no hotkey, even if it has a default.
 */

import type { App } from './app';
import { formatHotkey, type Hotkey, type Modifier } from './keymap';

const MODIFIERS = new Set<Modifier>(['Mod', 'Ctrl', 'Meta', 'Shift', 'Alt']);

function parseHotkeys(value: unknown): Hotkey[] | null {
	if (!Array.isArray(value)) return null;
	const hotkeys: Hotkey[] = [];
	for (const item of value) {
		const { modifiers, key } = (item ?? {}) as { modifiers?: unknown; key?: unknown };
		if (typeof key !== 'string' || !key) continue;
		const mods = Array.isArray(modifiers) ? modifiers.filter((m): m is Modifier => MODIFIERS.has(m as Modifier)) : [];
		hotkeys.push({ modifiers: mods, key });
	}
	return hotkeys;
}

/** Whether two hotkeys are the same key with the same modifiers. */
export function sameHotkey(a: Hotkey, b: Hotkey): boolean {
	return a.key.toUpperCase() === b.key.toUpperCase() && [...a.modifiers].sort().join() === [...b.modifiers].sort().join();
}

export class HotkeyManager {
	/** Hotkeys commands declare, by command id. */
	defaultKeys: Record<string, Hotkey[]> = {};
	/** The user's hotkeys, by command id (from hotkeys.json). */
	customKeys: Record<string, Hotkey[]> = {};
	private readonly app: App;
	private readonly listeners = new Set<(id: string) => void>();

	constructor(app: App) {
		this.app = app;
	}

	private get path(): string {
		return `${this.app.vault.configDir}/hotkeys.json`;
	}

	/** @internal Reads hotkeys.json; a missing or invalid file means no custom hotkeys. */
	async load(): Promise<void> {
		const adapter = this.app.vault.adapter;
		this.customKeys = {};
		try {
			if (!(await adapter.exists(this.path))) return;
			const data = JSON.parse(await adapter.read(this.path)) as unknown;
			if (!data || typeof data !== 'object') return;
			for (const [id, value] of Object.entries(data)) {
				const hotkeys = parseHotkeys(value);
				if (hotkeys) this.customKeys[id] = hotkeys;
			}
		} catch (err) {
			console.error(`Could not read ${this.path}`, err);
		} finally {
			for (const id of Object.keys(this.customKeys)) this.changed(id);
		}
	}

	async save(): Promise<void> {
		await this.app.vault.adapter.write(this.path, JSON.stringify(this.customKeys, null, 2));
	}

	getDefaultHotkeys(id: string): Hotkey[] | undefined {
		return this.defaultKeys[id];
	}

	/** The user's hotkeys for the command, or undefined when it uses its defaults. */
	getHotkeys(id: string): Hotkey[] | undefined {
		return this.customKeys[id];
	}

	/** The hotkeys that run the command now. */
	getEffectiveHotkeys(id: string): Hotkey[] {
		return this.customKeys[id] ?? this.defaultKeys[id] ?? [];
	}

	setHotkeys(id: string, hotkeys: Hotkey[]): void {
		this.customKeys[id] = hotkeys;
		this.changed(id);
		void this.save().catch((err: unknown) => console.error(err));
	}

	/** Goes back to the command's default hotkeys. */
	removeHotkeys(id: string): void {
		delete this.customKeys[id];
		this.changed(id);
		void this.save().catch((err: unknown) => console.error(err));
	}

	printHotkeyForCommand(id: string): string {
		const first = this.getEffectiveHotkeys(id)[0];
		return first ? formatHotkey(first) : '';
	}

	/** Other commands that use `hotkey`. */
	findConflicts(hotkey: Hotkey, exceptId?: string): string[] {
		return this.app.commands
			.listCommands()
			.filter((command) => command.id !== exceptId && this.getEffectiveHotkeys(command.id).some((h) => sameHotkey(h, hotkey)))
			.map((command) => command.id);
	}

	/** @internal Called with a command id whenever its hotkeys change. */
	onChange(listener: (id: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(id: string): void {
		for (const listener of this.listeners) listener(id);
	}
}
