/** The "Community plugins" settings tab: restricted mode and the installed plugins with their toggles. */

import { Setting, SettingTab, type App } from '@emeraldmd/api';
import type { PluginHost } from './host';

export class CommunityPluginsTab extends SettingTab {
	private readonly host: PluginHost;
	private unsubscribe: (() => void) | null = null;

	constructor(app: App, host: PluginHost) {
		super(app);
		this.host = host;
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

	override hide(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		super.hide();
	}
}
