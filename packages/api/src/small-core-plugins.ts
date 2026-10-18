/**
 * Small core plugins, off by default as in Obsidian:
 *
 * - Slash commands (`slash-command`): "/" at the start of a line or after a
 *   space lists the commands; Enter runs one in place of what was typed.
 * - Random note (`random-note`): opens a random note (command and ribbon).
 * - Unique note creator (`zk-prefixer`): a new note named by the time
 *   (`YYYYMMDDHHmm` by default), in a folder, from an optional template.
 *   Options in `.obsidian/zk-prefixer.json`: `folder`, `format`, `template`.
 */

import { normalizePath, type TFile } from '@emeraldmd/core';
import type { App } from './app';
import type { Command } from './commands';
import { applyTemplateVariables, InternalPluginInstance } from './core-plugins';
import type { Editor, EditorPosition } from './editor';
import { formatHotkey } from './keymap';
import { moment } from './moment';
import { Notice } from './notice';
import { prepareFuzzySearch, renderResults, sortSearchResults, type SearchResult } from './search';
import { EditorSuggest, type EditorSuggestContext, type EditorSuggestTriggerInfo } from './suggest';

interface CommandMatch {
	command: Command;
	match: SearchResult;
}

class CommandSuggest extends EditorSuggest<CommandMatch> {
	constructor(app: App) {
		super(app);
		this.setInstructions([
			{ command: '↑↓', purpose: 'to navigate' },
			{ command: '↵', purpose: 'to run' },
			{ command: 'esc', purpose: 'to dismiss' },
		]);
	}

	onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
		const before = editor.getLine(cursor.line).slice(0, cursor.ch);
		const typed = /(?:^|\s)\/([^\s/]*)$/.exec(before);
		if (!typed) return null;
		return { start: { line: cursor.line, ch: cursor.ch - typed[1]!.length - 1 }, end: cursor, query: typed[1]! };
	}

	getSuggestions(context: EditorSuggestContext): CommandMatch[] {
		const search = prepareFuzzySearch(context.query);
		const found: CommandMatch[] = [];
		for (const command of this.app.commands.listCommands()) {
			const match = search(command.name);
			if (match) found.push({ command, match });
		}
		if (context.query) sortSearchResults(found);
		else found.sort((a, b) => a.command.name.localeCompare(b.command.name));
		return found;
	}

	renderSuggestion(value: CommandMatch, el: HTMLElement): void {
		renderResults(el.createDiv('suggestion-content'), value.command.name, value.match);
		const hotkey = this.app.hotkeyManager.getHotkeys(value.command.id)?.[0] ?? this.app.hotkeyManager.getDefaultHotkeys(value.command.id)?.[0];
		if (hotkey) el.createDiv({ cls: 'suggestion-aux' }).createEl('kbd', { cls: 'suggestion-hotkey', text: formatHotkey(hotkey) });
	}

	selectSuggestion(value: CommandMatch): void {
		const context = this.context;
		if (!context) return;
		// What was typed ("/bold") goes; the command then acts where it was.
		context.editor.replaceRange('', context.start, context.end);
		this.close();
		this.app.commands.executeCommandById(value.command.id);
	}
}

export class SlashCommands extends InternalPluginInstance {
	readonly id = 'slash-command';
	readonly name = 'Slash commands';
	readonly description = 'Type "/" in a note to run a command.';
	private suggest: CommandSuggest | null = null;

	onEnable(): void {
		this.suggest = new CommandSuggest(this.app);
		this.app.workspace.editorSuggest.addSuggest(this.suggest);
	}

	override disable(): void {
		super.disable();
		if (this.suggest) this.app.workspace.editorSuggest.removeSuggest(this.suggest);
		this.suggest = null;
	}
}

export class RandomNote extends InternalPluginInstance {
	readonly id = 'random-note';
	readonly name = 'Random note';
	readonly description = 'Open a random note from your vault.';

	onEnable(): void {
		this.addCommand({ id: 'random-note', name: 'Random note: Open random note', callback: () => this.open() });
		this.addRibbonIcon('dices', 'Open random note', () => this.open());
	}

	/** A note other than the one open, at random. */
	pick(): TFile | null {
		const current = this.app.workspace.getActiveFile();
		const notes = this.app.vault.getMarkdownFiles().filter((file) => file !== current);
		return notes[Math.floor(Math.random() * notes.length)] ?? null;
	}

	open(): void {
		const note = this.pick();
		if (note) void this.app.workspace.getLeaf(false).openFile(note);
		else new Notice('There is no other note to open.');
	}
}

export class UniqueNoteCreator extends InternalPluginInstance {
	readonly id = 'zk-prefixer';
	readonly name = 'Unique note creator';
	readonly description = 'Create notes named by the time they were made, for a Zettelkasten.';

	onEnable(): void {
		this.addCommand({ id: 'zk-prefixer', name: 'Unique note creator: Create new unique note', callback: () => void this.create() });
		this.addRibbonIcon('file-clock', 'Create new unique note', () => void this.create());
	}

	async create(now = moment()): Promise<TFile | null> {
		const app = this.app;
		const folder = this.option('folder', '');
		const name = now.format(this.option('format', 'YYYYMMDDHHmm'));
		const path = app.vault.getAvailablePath(normalizePath(folder ? `${folder}/${name}` : name), 'md');
		let text = '';
		const templatePath = this.option('template', '');
		if (templatePath) {
			const template = app.vault.getFileByPath(templatePath.endsWith('.md') ? templatePath : `${templatePath}.md`);
			if (template) text = applyTemplateVariables(await app.vault.read(template), { title: name, date: now, dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' });
		}
		try {
			if (folder && !app.vault.getFolderByPath(normalizePath(folder))) await app.vault.createFolder(normalizePath(folder));
			const file = await app.vault.create(path, text);
			await app.workspace.getLeaf(false).openFile(file);
			return file;
		} catch (err) {
			new Notice(`Could not create a unique note: ${err}`);
			return null;
		}
	}
}
