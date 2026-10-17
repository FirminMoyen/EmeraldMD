/** The "Community plugins" settings tab: restricted mode and the installed plugins with their toggles. */

import { Notice, Setting, SettingTab, type App } from '@emeraldmd/api';
import { PluginBrowser } from './browser';
import { CommunityDirectory } from './community';
import type { PluginHost } from './host';

export class CommunityPluginsTab extends SettingTab {
	private readonly host: PluginHost;
	private readonly directory: CommunityDirectory;
	private unsubscribe: (() => void) | null = null;
	/** Plugins with a newer version (id → version), after "Check for updates". */
	private updates: Record<string, string> | null = null;
	private checking = false;

	constructor(app: App, host: PluginHost, directory = new CommunityDirectory(app)) {
		super(app);
		this.host = host;
		this.directory = directory;
		this.id = 'community-plugins';
		this.name = 'Community plugins';
		this.icon = 'blocks';
	}

	override display(): void {
		this.unsubscribe ??= this.host.onChange(() => {
			if (this.containerEl.isConnected) this.render();
		});
		const { containerEl, host } = this;
		containerEl.empty();

		if (host.restricted) {
			new Setting(containerEl)
				.setName('Restricted mode is on')
				.setDesc(
					'Community plugins run code with access to this vault, the network and the app. ' +
						'Turn them on only for plugins and vaults you trust.',
				)
				.addButton((b) => b.setButtonText('Turn on community plugins').setCta().onClick(() => host.setRestricted(false)));
		} else {
			new Setting(containerEl)
				.setName('Restricted mode')
				.setDesc('Turn on to stop all community plugins in this vault.')
				.addButton((b) => b.setButtonText('Turn on restricted mode').onClick(() => host.setRestricted(true)));
		}

		new Setting(containerEl)
			.setName('Community plugins')
			.setDesc('Plugins made by the community, from the same directory as Obsidian.')
			.addButton((b) => b.setButtonText('Browse').setCta().onClick(() => new PluginBrowser(this.app, host, this.directory).open()));

		const updates = new Setting(containerEl).setName('Check for updates').setDesc(this.updatesSummary());
		updates.addButton((b) =>
			b
				.setButtonText(this.checking ? 'Checking…' : 'Check for updates')
				.setDisabled(this.checking)
				.onClick(() => void this.checkForUpdates()),
		);
		if (this.updates && Object.keys(this.updates).length > 1) {
			updates.addButton((b) => b.setButtonText('Update all').setCta().onClick(() => void this.updateAll()));
		}

		new Setting(containerEl)
			.setName('Installed plugins')
			.setDesc(`Plugins in ${this.app.vault.configDir}/plugins.`)
			.setHeading()
			.addExtraButton((b) =>
				b
					.setIcon('refresh-cw')
					.setTooltip('Reload plugins')
					.onClick(() => void host.loadManifests()),
			);

		const manifests = Object.values(host.manifests).sort((a, b) => a.name.localeCompare(b.name));
		if (manifests.length === 0) {
			containerEl.createDiv({ cls: 'setting-item-description community-plugins-empty', text: 'No community plugins are installed in this vault.' });
		}
		for (const manifest of manifests) {
			const enabled = host.isEnabled(manifest.id);
			const loaded = Boolean(host.plugins[manifest.id]);
			const error = host.errors[manifest.id];
			const setting = new Setting(containerEl).setName(manifest.name).setClass('community-plugin-item');
			const desc = createFragment();
			desc.createDiv({ cls: 'community-plugin-meta', text: `Version ${manifest.version}${manifest.author ? ` by ${manifest.author}` : ''}` });
			if (manifest.description) desc.createDiv({ text: manifest.description });
			if (manifest.isDesktopOnly) {
				desc.createDiv({ cls: 'mod-warning', text: 'Desktop only: it may need Node.js APIs that EmeraldMD does not provide yet.' });
			}
			if (error && enabled && !host.restricted) desc.createDiv({ cls: 'mod-warning community-plugin-error', text: `Failed to load: ${error}` });
			setting.setDesc(desc);
			const update = this.updates?.[manifest.id];
			if (update) {
				setting.addButton((b) => b.setButtonText(`Update to ${update}`).setCta().onClick(() => void this.updatePlugin(manifest.id)));
			}
			const tab = this.app.setting.pluginTabs.find((t) => t.id === manifest.id);
			if (tab && loaded) {
				setting.addExtraButton((b) =>
					b
						.setIcon('settings')
						.setTooltip('Options')
						.onClick(() => this.app.setting.openTabById(manifest.id)),
				);
			}
			setting.addToggle((t) =>
				t
					.setValue(enabled && !host.restricted)
					.setDisabled(host.restricted)
					.onChange(async (on) => {
						if (on) await host.enablePluginAndSave(manifest.id);
						else await host.disablePluginAndSave(manifest.id);
					}),
			);
		}

		for (const [folder, err] of Object.entries(host.errors)) {
			if (host.manifests[folder]) continue;
			new Setting(containerEl).setName(folder).setDesc(err).setClass('community-plugin-item');
		}
	}

	private updatesSummary(): string {
		if (this.updates === null) return 'See whether installed plugins have newer versions.';
		const count = Object.keys(this.updates).length;
		return count ? `${count} plugin${count === 1 ? ' has' : 's have'} a newer version.` : 'All plugins are up to date.';
	}

	private async checkForUpdates(): Promise<void> {
		this.checking = true;
		this.render();
		try {
			this.updates = await this.directory.findUpdates(this.host.manifests);
		} catch (err) {
			new Notice(`Could not check for updates: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.checking = false;
			if (this.containerEl.isConnected) this.render();
		}
	}

	private async updatePlugin(id: string): Promise<void> {
		const entry = (await this.directory.listPlugins()).find((p) => p.id === id);
		if (!entry) return;
		try {
			await this.directory.installPlugin(entry);
			await this.host.reloadPlugin(id);
			if (this.updates) delete this.updates[id];
			new Notice(`Updated ${entry.name}.`);
		} catch (err) {
			new Notice(`Could not update ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (this.containerEl.isConnected) this.render();
	}

	private async updateAll(): Promise<void> {
		for (const id of Object.keys(this.updates ?? {})) await this.updatePlugin(id);
	}

	override hide(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		super.hide();
	}
}
