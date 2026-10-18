/**
 * Settings for core plugins: Settings → Core plugins (on/off, saved in
 * core-plugins.json), and each implemented plugin's options under "Core
 * plugins" (saved in daily-notes.json and templates.json, as in Obsidian).
 */

import { confirmAction, FileRecovery, moment, Notice, Setting, SettingTab, type App, type InternalPluginInstance } from '@emeraldmd/api';

export class CorePluginsTab extends SettingTab {
	constructor(app: App) {
		super(app);
		this.id = 'plugins';
		this.name = 'Core plugins';
		this.icon = 'plug';
	}

	override display(): void {
		this.containerEl.empty();
		const internal = this.app.internalPlugins;
		for (const plugin of Object.values(internal.plugins)) {
			const { instance } = plugin;
			const setting = new Setting(this.containerEl).setName(instance.name).setDesc(instance.description);
			if (plugin.enabled) {
				setting.addExtraButton((b) =>
					b
						.setIcon('settings')
						.setTooltip('Options')
						.onClick(() => this.app.setting.openTabById(instance.id)),
				);
			}
			setting.addToggle((t) =>
				t.setValue(plugin.enabled).onChange(async (on) => {
					await internal.setEnabled(instance.id, on);
					this.app.setting.updateTabs();
					this.display();
				}),
			);
		}
		this.containerEl.createDiv({
			cls: 'setting-item-description',
			text: 'Other core plugins, such as search, the graph view and canvas, are built in and always on.',
		});
	}
}

/** The options tab of one core plugin; listed only while the plugin is on. */
abstract class CorePluginOptionsTab extends SettingTab {
	protected readonly pluginId: string;

	constructor(app: App, pluginId: string) {
		super(app);
		this.pluginId = pluginId;
		this.id = pluginId;
		const plugin = app.internalPlugins.getPluginById(pluginId);
		this.name = plugin?.instance.name ?? pluginId;
		this.icon = 'settings';
	}

	override isAvailable(): boolean {
		return this.app.internalPlugins.getPluginById(this.pluginId)?.enabled === true;
	}

	protected get instance(): InternalPluginInstance {
		return this.app.internalPlugins.getPluginById(this.pluginId)!.instance;
	}

	protected text(name: string, desc: string | DocumentFragment, key: string, placeholder: string, onChange?: (value: string) => void): Setting {
		return new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((t) =>
				t
					.setPlaceholder(placeholder)
					.setValue(typeof this.instance.options[key] === 'string' ? (this.instance.options[key] as string) : '')
					.onChange((value) => {
						this.instance.options[key] = value.trim();
						void this.instance.saveOptions().catch((err: unknown) => console.error(err));
						onChange?.(value.trim());
					}),
			);
	}
}

/** A description showing today's date in `format`, and a function to update it as the format changes. */
function formatPreview(format: unknown, fallback: string): { fragment: DocumentFragment; update: (value: string) => void } {
	const fragment = createFragment();
	fragment.appendText(`A Moment.js format, such as ${fallback}. `);
	const sample = fragment.createSpan({ cls: 'u-pop' });
	const update = (value: string) => sample.setText(`Today: ${moment().format(value || fallback)}`);
	update(typeof format === 'string' ? format : '');
	return { fragment, update };
}

export class DailyNotesTab extends CorePluginOptionsTab {
	constructor(app: App) {
		super(app, 'daily-notes');
	}

	override display(): void {
		this.containerEl.empty();
		const preview = formatPreview(this.instance.options.format, 'YYYY-MM-DD');
		this.text('Date format', preview.fragment, 'format', 'YYYY-MM-DD', preview.update);
		this.text('New file location', 'New daily notes go in this folder.', 'folder', 'Example: folder 1/folder 2');
		this.text('Template file location', 'A note to start daily notes from, like "Templates/Daily".', 'template', 'Example: folder/note');
		new Setting(this.containerEl)
			.setName('Open daily note on startup')
			.setDesc("Open today's note when the vault opens.")
			.addToggle((t) =>
				t.setValue(this.instance.options.autorun === true).onChange((on) => {
					this.instance.options.autorun = on;
					void this.instance.saveOptions().catch((err: unknown) => console.error(err));
				}),
			);
	}
}

export class TemplatesTab extends CorePluginOptionsTab {
	constructor(app: App) {
		super(app, 'templates');
	}

	override display(): void {
		this.containerEl.empty();
		this.text('Template folder location', 'Notes in this folder are offered by "Insert template".', 'folder', 'Example: folder 1/folder 2');
		const date = formatPreview(this.instance.options.dateFormat, 'YYYY-MM-DD');
		this.text('Date format', date.fragment, 'dateFormat', 'YYYY-MM-DD', date.update);
		const time = formatPreview(this.instance.options.timeFormat, 'HH:mm');
		this.text('Time format', time.fragment, 'timeFormat', 'HH:mm', time.update);
		this.containerEl.createDiv({
			cls: 'setting-item-description',
			text: 'In templates, {{title}}, {{date}} and {{time}} are replaced; {{date:YYYY}} uses its own format.',
		});
	}
}

export class FileRecoveryTab extends CorePluginOptionsTab {
	constructor(app: App) {
		super(app, 'file-recovery');
	}

	private number(name: string, desc: string, key: 'interval' | 'keep', min: number, max: number): void {
		const recovery = this.instance as FileRecovery;
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addSlider((s) =>
				s
					.setLimits(min, max, 1)
					.setValue(recovery[key])
					.setDynamicTooltip()
					.onChange((value) => {
						recovery.options[key] = value;
						void recovery.saveOptions().catch((err: unknown) => console.error(err));
					}),
			);
	}

	override display(): void {
		this.containerEl.empty();
		const recovery = this.instance as FileRecovery;
		this.number('Snapshot interval', 'Minutes between two snapshots of the same note.', 'interval', 1, 60);
		this.number('History length', 'Days snapshots are kept. They stay on this device and are not synced.', 'keep', 1, 90);
		new Setting(this.containerEl)
			.setName('Snapshots')
			.setDesc('Look back at earlier versions of your notes and restore one.')
			.addButton((b) => b.setButtonText('View').onClick(() => recovery.openHistory(null)));
		new Setting(this.containerEl)
			.setName('Clear history')
			.setDesc('Delete every snapshot of this vault on this device.')
			.addButton((b) =>
				b
					.setButtonText('Clear')
					.setWarning()
					.onClick(async () => {
						const ok = await confirmAction(this.app, { title: 'Clear history?', message: 'All snapshots of this vault on this device are deleted.', confirm: 'Clear' });
						if (!ok) return;
						await recovery.clearHistory();
						new Notice('Snapshots deleted.');
					}),
			);
	}
}

export class NoteComposerTab extends CorePluginOptionsTab {
	constructor(app: App) {
		super(app, 'note-composer');
	}

	override display(): void {
		this.containerEl.empty();
		const options = this.instance.options;
		const save = () => void this.instance.saveOptions().catch((err: unknown) => console.error(err));
		new Setting(this.containerEl)
			.setName('Text after extraction')
			.setDesc('What replaces the text moved to another note.')
			.addDropdown((d) =>
				d
					.addOptions({ link: 'Link to the new note', embed: 'Embed of the new note', none: 'Nothing' })
					.setValue(typeof options.replacementText === 'string' ? options.replacementText : 'link')
					.onChange((value) => {
						options.replacementText = value;
						save();
					}),
			);
		this.text(
			'Template file location',
			'A note to start extracted notes from; {{content}} is the extracted text, {{fromTitle}} and {{newTitle}} the notes’ names.',
			'template',
			'Example: Templates/Extracted',
		);
		new Setting(this.containerEl)
			.setName('Confirm file merge')
			.setDesc('Ask before merging a note into another.')
			.addToggle((t) =>
				t.setValue(options.askBeforeMerging !== false).onChange((on) => {
					options.askBeforeMerging = on;
					save();
				}),
			);
	}
}

export class UniqueNoteCreatorTab extends CorePluginOptionsTab {
	constructor(app: App) {
		super(app, 'zk-prefixer');
	}

	override display(): void {
		this.containerEl.empty();
		this.text('New file location', 'New unique notes go in this folder.', 'folder', 'Example: Zettelkasten');
		const preview = formatPreview(this.instance.options.format, 'YYYYMMDDHHmm');
		this.text('Unique prefix format', preview.fragment, 'format', 'YYYYMMDDHHmm', preview.update);
		this.text('Template file location', 'A note to start unique notes from.', 'template', 'Example: Templates/Zettel');
	}
}
