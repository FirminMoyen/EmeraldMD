/**
 * Settings → Editor, Files and links, and Hotkeys. The settings are the keys
 * Obsidian keeps in `.obsidian/app.json` and `hotkeys.json`, so a vault's
 * existing choices apply and stay compatible.
 */

import {
	eventKey,
	eventModifiers,
	formatHotkey,
	Scope,
	SearchComponent,
	Setting,
	SettingTab,
	type App,
	type Command,
	type Hotkey,
} from '@emeraldmd/api';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Shared helpers for tabs whose controls write `vault.setConfig`. */
abstract class ConfigTab extends SettingTab {
	protected get config(): (key: string) => unknown {
		return (key) => this.app.vault.getConfig(key);
	}

	protected heading(name: string): void {
		new Setting(this.containerEl).setName(name).setHeading();
	}

	protected toggle(name: string, desc: string, key: string, invert = false): Setting {
		return new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addToggle((t) => t.setValue((this.config(key) === true) !== invert).onChange((on) => this.app.vault.setConfig(key, on !== invert)));
	}

	protected dropdown(name: string, desc: string, key: string, options: Record<string, string>, onChange?: (value: string) => void): Setting {
		return new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addDropdown((d) =>
				d
					.addOptions(options)
					.setValue(String(this.config(key)))
					.onChange((value) => {
						this.app.vault.setConfig(key, value);
						onChange?.(value);
					}),
			);
	}
}

export class EditorTab extends ConfigTab {
	constructor(app: App) {
		super(app);
		this.id = 'editor';
		this.name = 'Editor';
		this.icon = 'square-pen';
	}

	override display(): void {
		this.containerEl.empty();
		this.heading('General');
		this.dropdown('Default view for notes', 'How notes open: editing or the reading view.', 'defaultViewMode', { source: 'Editing view', preview: 'Reading view' });
		new Setting(this.containerEl)
			.setName('Default editing mode')
			.setDesc('Live Preview shows Markdown formatted while you edit; source mode shows the plain text.')
			.addDropdown((d) =>
				d
					.addOptions({ live: 'Live Preview', source: 'Source mode' })
					.setValue(this.config('livePreview') === false ? 'source' : 'live')
					.onChange((value) => this.app.vault.setConfig('livePreview', value === 'live')),
			);

		this.heading('Display');
		this.toggle('Readable line length', 'Limit the width of the text so long lines stay easy to read.', 'readableLineLength');
		this.toggle('Strict line breaks', 'Follow the Markdown rule that a single line break does not start a new line in the reading view.', 'strictLineBreaks');
		this.toggle('Show line numbers', 'Show line numbers next to the text while editing.', 'showLineNumber');

		this.heading('Behavior');
		this.toggle('Spellcheck', 'Underline misspelled words while editing.', 'spellcheck');
		this.toggle('Auto pair brackets', 'Type the closing bracket or quote along with the opening one.', 'autoPairBrackets');
		this.toggle('Indent using tabs', 'Indent with tab characters; turn off to indent with spaces.', 'useTab');
		this.toggle('Vim key bindings', 'Edit with Vim keys: normal, insert and visual modes, and :commands.', 'vimMode');
		new Setting(this.containerEl)
			.setName('Tab size')
			.setDesc('How wide a tab is, and how many spaces an indent uses without tabs.')
			.addSlider((s) =>
				s
					.setLimits(2, 8, 1)
					.setValue(Number(this.config('tabSize')) || 4)
					.setDynamicTooltip()
					.onChange((size) => this.app.vault.setConfig('tabSize', size)),
			);
	}
}

/** `attachmentFolderPath`: "/" (vault folder), "./" (the note's folder), "./name" (a subfolder of it) or a vault path. */
type AttachmentMode = 'root' | 'current' | 'subfolder' | 'folder';

function attachmentMode(path: string): AttachmentMode {
	if (path === '/' || path === '') return 'root';
	if (path === './') return 'current';
	if (path.startsWith('./')) return 'subfolder';
	return 'folder';
}

export class FilesTab extends ConfigTab {
	constructor(app: App) {
		super(app);
		this.id = 'file';
		this.name = 'Files and links';
		this.icon = 'folder-closed';
	}

	override display(): void {
		this.containerEl.empty();
		this.heading('Files');
		this.toggle('Confirm file deletion', 'Ask before moving a note or folder to the trash.', 'promptDelete');
		new Setting(this.containerEl).setName('Deleted files').setDesc("Deleted files go to the vault's .trash folder, where you can get them back.");

		this.heading('New notes');
		this.dropdown(
			'Default location for new notes',
			'Where new notes are created.',
			'newFileLocation',
			{ root: 'Vault folder', current: 'Same folder as current file', folder: 'In the folder specified below' },
			() => this.display(),
		);
		if (this.config('newFileLocation') === 'folder') {
			new Setting(this.containerEl)
				.setName('Folder to create new notes in')
				.addText((t) =>
					t
						.setPlaceholder('Example: folder 1/folder 2')
						.setValue(String(this.config('newFileFolderPath') ?? ''))
						.onChange((value) => this.app.vault.setConfig('newFileFolderPath', value.trim())),
				);
		}

		this.heading('Links');
		this.toggle('Automatically update internal links', 'Update links when you rename or move a note, without asking first.', 'alwaysUpdateLinks');
		this.dropdown('New link format', 'What link text to use for new links.', 'newLinkFormat', {
			shortest: 'Shortest path when possible',
			relative: 'Relative path to file',
			absolute: 'Absolute path in vault',
		});
		this.toggle('Use [[Wikilinks]]', 'Create [[Wikilinks]] instead of Markdown links.', 'useMarkdownLinks', true);

		this.heading('Attachments');
		const path = String(this.config('attachmentFolderPath') ?? '/');
		const mode = attachmentMode(path);
		new Setting(this.containerEl)
			.setName('Default location for new attachments')
			.setDesc('Where pasted and dropped files are saved.')
			.addDropdown((d) =>
				d
					.addOptions({ root: 'Vault folder', current: 'Same folder as current file', subfolder: 'In subfolder under current folder', folder: 'In the folder specified below' })
					.setValue(mode)
					.onChange((value) => {
						const next: Record<string, string> = { root: '/', current: './', subfolder: './attachments', folder: 'Attachments' };
						this.app.vault.setConfig('attachmentFolderPath', next[value]);
						this.display();
					}),
			);
		if (mode === 'subfolder' || mode === 'folder') {
			new Setting(this.containerEl)
				.setName(mode === 'subfolder' ? 'Subfolder name' : 'Attachment folder path')
				.addText((t) =>
					t.setValue(mode === 'subfolder' ? path.slice(2) : path).onChange((value) => {
						const name = value.trim().replace(/^\.?\/+/, '');
						if (name) this.app.vault.setConfig('attachmentFolderPath', mode === 'subfolder' ? `./${name}` : name);
					}),
				);
		}
	}
}

export class HotkeysTab extends SettingTab {
	private filter = '';
	private recording: string | null = null;
	private recordScope: Scope | null = null;
	private listEl: HTMLElement | null = null;

	constructor(app: App) {
		super(app);
		this.id = 'hotkeys';
		this.name = 'Hotkeys';
		this.icon = 'keyboard';
	}

	override display(): void {
		this.containerEl.empty();
		new Setting(this.containerEl)
			.setName('Search hotkeys')
			.setClass('hotkey-search-container')
			.then((setting) => {
				const search = new SearchComponent(setting.controlEl).setPlaceholder('Filter…').setValue(this.filter);
				search.onChange((value) => {
					this.filter = value;
					this.renderList();
				});
			});
		this.listEl = this.containerEl.createDiv('hotkey-list');
		this.renderList();
	}

	override hide(): void {
		this.stopRecording();
		super.hide();
	}

	private renderList(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();
		const manager = this.app.hotkeyManager;
		const query = this.filter.trim().toLowerCase();
		const commands = this.app.commands
			.listCommands()
			.filter((c) => !query || c.name.toLowerCase().includes(query) || manager.getEffectiveHotkeys(c.id).some((h) => formatHotkey(h).toLowerCase().includes(query)))
			.sort((a, b) => collator.compare(a.name, b.name));
		for (const command of commands) this.renderCommand(list, command);
		if (!commands.length) list.createDiv({ cls: 'setting-item-description', text: 'No commands match.' });
	}

	private renderCommand(list: HTMLElement, command: Command): void {
		const manager = this.app.hotkeyManager;
		const hotkeys = manager.getEffectiveHotkeys(command.id);
		const setting = new Setting(list).setName(command.name).setClass('hotkey-setting');
		const conflicts = hotkeys.flatMap((h) => manager.findConflicts(h, command.id));
		if (conflicts.length) {
			const names = [...new Set(conflicts)].map((id) => this.app.commands.findCommand(id)?.name ?? id);
			setting.setDesc(`Also used by ${names.join(', ')}.`);
			setting.settingEl.addClass('has-conflict');
		}
		const keys = setting.controlEl.createDiv('setting-command-hotkeys');
		for (const hotkey of hotkeys) {
			const chip = keys.createSpan({ cls: 'setting-hotkey', text: formatHotkey(hotkey) });
			const remove = chip.createSpan({ cls: 'setting-hotkey-icon setting-delete-hotkey', attr: { 'aria-label': 'Delete hotkey' }, text: '×' });
			remove.addEventListener('click', () => {
				manager.setHotkeys(command.id, hotkeys.filter((h) => h !== hotkey));
				this.renderList();
			});
		}
		if (this.recording === command.id) {
			keys.createSpan({ cls: 'setting-hotkey mod-active', text: 'Press hotkey…' });
		} else if (!hotkeys.length) {
			keys.createSpan({ cls: 'setting-hotkey mod-empty', text: 'Blank' });
		}
		if (manager.getHotkeys(command.id) !== undefined) {
			setting.addExtraButton((b) =>
				b
					.setIcon('rotate-ccw')
					.setTooltip('Restore default')
					.onClick(() => {
						manager.removeHotkeys(command.id);
						this.renderList();
					}),
			);
		}
		setting.addExtraButton((b) =>
			b
				.setIcon('circle-plus')
				.setTooltip('Customize this command')
				.onClick(() => this.startRecording(command.id)),
		);
	}

	/** The next key press (with its modifiers) becomes a hotkey of the command; Escape cancels. */
	private startRecording(id: string): void {
		this.stopRecording();
		this.recording = id;
		const scope = new Scope();
		scope.register(null, null, (evt) => {
			if (['Shift', 'Control', 'Alt', 'Meta'].includes(evt.key)) return false;
			if (evt.key === 'Escape' && !evt.shiftKey && !evt.metaKey && !evt.ctrlKey && !evt.altKey) {
				this.stopRecording();
				this.renderList();
				return false;
			}
			const hotkey: Hotkey = { modifiers: eventModifiers(evt), key: eventKey(evt) };
			const manager = this.app.hotkeyManager;
			manager.setHotkeys(id, [...manager.getEffectiveHotkeys(id), hotkey]);
			this.stopRecording();
			this.renderList();
			return false;
		});
		this.recordScope = scope;
		this.app.keymap.pushScope(scope);
		this.renderList();
	}

	private stopRecording(): void {
		if (this.recordScope) this.app.keymap.popScope(this.recordScope);
		this.recordScope = null;
		this.recording = null;
	}
}
