/** The command palette (Ctrl/Cmd+P): every command that can run now, recently used first. */

import { formatHotkey, FuzzySuggestModal, renderResults, type App, type Command, type FuzzyMatch } from '@emeraldmd/api';

const recent: string[] = [];
const MAX_RECENT = 10;

export class CommandPalette extends FuzzySuggestModal<Command> {
	constructor(app: App) {
		super(app);
		this.setPlaceholder('Type a command…');
		this.setInstructions([
			{ command: '↑↓', purpose: 'to navigate' },
			{ command: '↵', purpose: 'to use' },
			{ command: 'esc', purpose: 'to dismiss' },
		]);
		this.emptyStateText = 'No commands found.';
	}

	getItems(): Command[] {
		const commands = this.app.commands.listCommands().filter((c) => this.app.commands.isAvailable(c));
		const rank = (c: Command) => {
			const i = recent.indexOf(c.id);
			return i === -1 ? MAX_RECENT : i;
		};
		return commands.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
	}

	getItemText(command: Command): string {
		return command.name;
	}

	override renderSuggestion(item: FuzzyMatch<Command>, el: HTMLElement): void {
		el.addClass('mod-complex');
		renderResults(el.createDiv('suggestion-content').createDiv('suggestion-title'), item.item.name, item.match);
		const hotkeys = item.item.hotkeys ?? [];
		if (hotkeys.length) {
			const aux = el.createDiv('suggestion-aux');
			for (const hotkey of hotkeys) aux.createEl('kbd', { cls: 'suggestion-hotkey', text: formatHotkey(hotkey) });
		}
	}

	onChooseItem(command: Command): void {
		const i = recent.indexOf(command.id);
		if (i !== -1) recent.splice(i, 1);
		recent.unshift(command.id);
		recent.length = Math.min(recent.length, MAX_RECENT);
		this.app.commands.executeCommand(command);
	}
}
