/**
 * The command palette (Ctrl/Cmd+P): every command that can run now, pinned
 * ones first, then the recently used, then by name. Pinned commands are kept
 * in `.obsidian/command-palette.json` (`{ "pinned": [ids] }`) as in
 * Obsidian; recent ones per vault in local storage.
 */

import {
	formatHotkey,
	FuzzySuggestModal,
	renderResults,
	Setting,
	SettingTab,
	setIcon,
	type App,
	type Command,
	type FuzzyMatch,
} from '@emeraldmd/api';

const MAX_RECENT = 10;
const RECENT_KEY = 'emerald-recent-commands';

/** Pinned command ids, as read from command-palette.json (`loadPinnedCommands`). */
let pinned: string[] = [];

const configPath = (app: App) => `${app.vault.configDir}/command-palette.json`;

export async function loadPinnedCommands(app: App): Promise<string[]> {
	try {
		const path = configPath(app);
		if (await app.vault.adapter.exists(path)) {
			const data = JSON.parse(await app.vault.adapter.read(path)) as { pinned?: unknown };
			pinned = Array.isArray(data.pinned) ? data.pinned.filter((id): id is string => typeof id === 'string') : [];
		}
	} catch (err) {
		console.error('Could not read command-palette.json', err);
	}
	return pinned;
}

async function savePinned(app: App, ids: string[]): Promise<void> {
	pinned = ids;
	await app.vault.adapter.write(configPath(app), JSON.stringify({ pinned }, null, 2));
}

function recentOf(app: App): string[] {
	const saved = app.loadLocalStorage(RECENT_KEY);
	return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [];
}

/** The hotkeys a command has now: the user's (hotkeys.json), else its defaults. */
function hotkeysOf(app: App, command: Command) {
	return app.hotkeyManager.getHotkeys(command.id) ?? app.hotkeyManager.getDefaultHotkeys(command.id) ?? command.hotkeys ?? [];
}

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
		const recent = recentOf(this.app);
		const rank = (c: Command) => {
			const pin = pinned.indexOf(c.id);
			if (pin !== -1) return pin - 1000;
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
		const aux = el.createDiv('suggestion-aux');
		if (pinned.includes(item.item.id)) {
			const flair = aux.createSpan({ cls: 'suggestion-flair', attr: { 'aria-label': 'Pinned' } });
			setIcon(flair, 'pin');
		}
		for (const hotkey of hotkeysOf(this.app, item.item)) aux.createEl('kbd', { cls: 'suggestion-hotkey', text: formatHotkey(hotkey) });
	}

	onChooseItem(command: Command): void {
		const recent = recentOf(this.app).filter((id) => id !== command.id);
		recent.unshift(command.id);
		this.app.saveLocalStorage(RECENT_KEY, recent.slice(0, MAX_RECENT));
		this.app.commands.executeCommand(command);
	}
}

/** Picks a command to pin. */
class CommandPicker extends FuzzySuggestModal<Command> {
	constructor(
		app: App,
		private readonly choose: (command: Command) => void,
	) {
		super(app);
		this.setPlaceholder('Pin a command…');
	}

	getItems(): Command[] {
		return this.app.commands
			.listCommands()
			.filter((c) => !pinned.includes(c.id))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	getItemText(command: Command): string {
		return command.name;
	}

	onChooseItem(command: Command): void {
		this.choose(command);
	}
}

/** Settings → Command palette: the pinned commands. */
export class CommandPaletteTab extends SettingTab {
	constructor(app: App) {
		super(app);
		this.id = 'command-palette';
		this.name = 'Command palette';
		this.icon = 'terminal-square';
	}

	override display(): void {
		const { containerEl, app } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName('Pinned commands')
			.setDesc('These come first in the command palette, in this order.')
			.addButton((b) =>
				b
					.setButtonText('Add command')
					.setCta()
					.onClick(() =>
						new CommandPicker(app, (command) => {
							void savePinned(app, [...pinned, command.id]).then(() => this.display());
						}).open(),
					),
			);
		const byId = new Map(app.commands.listCommands().map((c) => [c.id, c]));
		if (!pinned.length) containerEl.createDiv({ cls: 'setting-item-description', text: 'No pinned commands.' });
		pinned.forEach((id, i) => {
			new Setting(containerEl)
				.setName(byId.get(id)?.name ?? id)
				.setClass('mod-pinned-command')
				.addExtraButton((b) =>
					b
						.setIcon('arrow-up')
						.setTooltip('Move up')
						.setDisabled(i === 0)
						.onClick(() => {
							const next = [...pinned];
							[next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
							void savePinned(app, next).then(() => this.display());
						}),
				)
				.addExtraButton((b) =>
					b
						.setIcon('x')
						.setTooltip('Unpin')
						.onClick(() => void savePinned(app, pinned.filter((p) => p !== id)).then(() => this.display())),
				);
		});
	}
}
