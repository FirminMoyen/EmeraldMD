/**
 * Settings for core plugins: Settings → Core plugins (on/off, saved in
 * core-plugins.json), and each implemented plugin's options under "Core
 * plugins" (saved in daily-notes.json and templates.json, as in Obsidian).
 */

import { moment, Setting, SettingTab, type App, type InternalPluginInstance } from '@emeraldmd/api';

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
