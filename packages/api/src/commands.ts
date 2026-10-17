/**
 * The command registry, exposed to plugins as `app.commands` (not in the
 * public typings, but widely used: `executeCommandById`, `commands`,
 * `listCommands`). Hotkeys are bound in the app's root scope: the user's
 * from hotkeys.json, else the command's defaults (`app.hotkeyManager`).
 */

import type { App } from './app';
import type { Editor } from './editor';
import type { Hotkey, KeymapEventHandler } from './keymap';
import { Notice } from './notice';

export interface Command {
	id: string;
	name: string;
	icon?: string;
	mobileOnly?: boolean;
	repeatable?: boolean;
	callback?: () => unknown;
	checkCallback?: (checking: boolean) => boolean | void;
	editorCallback?: (editor: Editor, ctx: unknown) => unknown;
	editorCheckCallback?: (checking: boolean, editor: Editor, ctx: unknown) => boolean | void;
	hotkeys?: Hotkey[];
}

export class Commands {
	commands: Record<string, Command> = {};
	editorCommands: Record<string, Command> = {};
	private readonly app: App;
	private readonly hotkeyHandlers = new Map<string, KeymapEventHandler[]>();

	constructor(app: App) {
		this.app = app;
		app.hotkeyManager.onChange((id) => this.bindHotkeys(id));
	}

	addCommand(command: Command): void {
		if (this.commands[command.id]) this.removeCommand(command.id);
		this.commands[command.id] = command;
		if (command.editorCallback || command.editorCheckCallback) this.editorCommands[command.id] = command;
		if (command.hotkeys?.length) this.app.hotkeyManager.defaultKeys[command.id] = command.hotkeys;
		this.bindHotkeys(command.id);
	}

	removeCommand(id: string): void {
		delete this.commands[id];
		delete this.editorCommands[id];
		delete this.app.hotkeyManager.defaultKeys[id];
		this.unbindHotkeys(id);
	}

	/** (Re)binds the hotkeys that run the command now. */
	private bindHotkeys(id: string): void {
		this.unbindHotkeys(id);
		const command = this.commands[id];
		if (!command) return;
		const handlers = this.app.hotkeyManager.getEffectiveHotkeys(id).map((hotkey) =>
			this.app.scope.register(hotkey.modifiers, hotkey.key, (evt) => {
				if (evt.repeat && !command.repeatable) return false;
				return this.executeCommand(command) ? false : undefined;
			}),
		);
		if (handlers.length) this.hotkeyHandlers.set(id, handlers);
	}

	private unbindHotkeys(id: string): void {
		for (const handler of this.hotkeyHandlers.get(id) ?? []) this.app.scope.unregister(handler);
		this.hotkeyHandlers.delete(id);
	}

	findCommand(id: string): Command | undefined {
		return this.commands[id];
	}

	listCommands(): Command[] {
		return Object.values(this.commands);
	}

	/** Whether the command can run now (its check callback, or its need for an editor). */
	isAvailable(command: Command): boolean {
		return this.run(command, true);
	}

	executeCommandById(id: string): boolean {
		const command = this.findCommand(id);
		return command ? this.executeCommand(command) : false;
	}

	executeCommand(command: Command): boolean {
		return this.run(command, false);
	}

	private run(command: Command, checking: boolean): boolean {
		const info = this.app.workspace.activeEditor;
		const editor = info?.editor;
		try {
			if (command.editorCheckCallback) {
				if (!editor) return false;
				const check = command.editorCheckCallback;
				return this.done(command, check(true, editor, info), checking, () => check(false, editor, info));
			}
			if (command.editorCallback) {
				if (!editor) return false;
				if (!checking) void Promise.resolve(command.editorCallback(editor, info)).catch((err: unknown) => this.report(command, err));
				return true;
			}
			if (command.checkCallback) {
				const check = command.checkCallback;
				return this.done(command, check(true), checking, () => check(false));
			}
			if (command.callback) {
				if (!checking) void Promise.resolve(command.callback()).catch((err: unknown) => this.report(command, err));
				return true;
			}
		} catch (err) {
			this.report(command, err);
		}
		return false;
	}

	/** Shared tail of check callbacks: `available` is the result of the checking call. */
	private done(command: Command, available: boolean | void, checking: boolean, execute: () => unknown): boolean {
		if (!available) return false;
		if (!checking) void Promise.resolve(execute()).catch((err: unknown) => this.report(command, err));
		return true;
	}

	private report(command: Command, err: unknown): void {
		console.error(`Command "${command.id}" failed:`, err);
		new Notice(`${command.name} failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}
