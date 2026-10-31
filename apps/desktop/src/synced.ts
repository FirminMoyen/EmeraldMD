/**
 * Status of a synced vault (a local copy kept in step with a server, see
 * src-tauri/src/synced.rs): a status bar item that also syncs on click, the
 * "Sync now" command, the Sync settings tab (with the opt-in to sync
 * `.obsidian`), and notices for conflict copies, settings received from
 * another device and rejected tokens.
 */

import { FuzzySuggestModal, Notice, Setting, SettingTab, setIcon, setTooltip, TFolder, type App } from '@emeraldmd/api';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Attachment types a device can leave out of sync (notes, canvases and bases always sync). */
type FileType = 'image' | 'audio' | 'video' | 'pdf' | 'other';

/** Selective sync: what this device leaves out. */
export interface SyncFilter {
	excludedFolders: string[];
	excludedTypes: FileType[];
}

export interface SyncedVault {
	localPath: string;
	serverUrl: string;
	vaultId: string;
	name: string;
	syncConfig: boolean;
	filter?: SyncFilter;
}

const FILE_TYPES: { type: FileType; name: string; desc: string }[] = [
	{ type: 'image', name: 'Sync images', desc: 'PNG, JPEG, GIF, SVG, WebP, HEIC…' },
	{ type: 'audio', name: 'Sync audio', desc: 'MP3, WAV, M4A, FLAC, OGG…' },
	{ type: 'video', name: 'Sync videos', desc: 'MP4, WebM, MOV, MKV…' },
	{ type: 'pdf', name: 'Sync PDFs', desc: '' },
	{ type: 'other', name: 'Sync other types', desc: 'Any other attachment.' },
];

/** Picks a vault folder to leave out of sync. */
class FolderChoice extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private readonly excluded: string[],
		private readonly choose: (folder: TFolder) => void,
	) {
		super(app);
		this.setPlaceholder('Folder to leave out of sync…');
	}

	getItems(): TFolder[] {
		return this.app.vault.getAllFolders().filter((f) => !this.excluded.includes(f.path));
	}

	getItemText(folder: TFolder): string {
		return folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.choose(folder);
	}
}

type SyncStatus =
	| { state: 'syncing' }
	| { state: 'synced'; lastSync: number; conflictCopies: string[]; failed: number }
	| { state: 'offline'; message: string }
	| { state: 'unauthorized' }
	| { state: 'error'; message: string };

export interface SyncStatusHost {
	notice(message: string): void;
	/** Shows the Connect to server dialog, to enter a new token. */
	reconnect(): void;
	/** Saves and reloads the window, to apply settings received from another device. */
	reload(): void;
}

/** Settings → Sync, for a synced vault. */
class SyncTab extends SettingTab {
	constructor(
		app: App,
		private readonly config: SyncedVault,
		private readonly syncNow: () => void,
	) {
		super(app);
		this.id = 'sync';
		this.name = 'Sync';
		this.icon = 'refresh-cw';
	}

	override display(): void {
		const { containerEl, config } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName('Server vault')
			.setDesc(`This folder is a synced copy of ${config.name} on ${hostOf(config.serverUrl)}.`)
			.addButton((b) => b.setButtonText('Sync now').onClick(() => this.syncNow()));
		new Setting(containerEl)
			.setName('Sync settings, themes and plugins')
			.setDesc(
				'Also keep this vault’s .obsidian folder in step with the server: settings, hotkeys, themes, CSS snippets and community plugins (not the window layout). ' +
					'Turn it on on each device that should share them. When a settings file changed on both sides, the server’s version is kept and this device’s goes to the vault’s .trash.',
			)
			.addToggle((t) =>
				t.setValue(config.syncConfig).onChange(async (enabled) => {
					try {
						await invoke('set_sync_config', { enabled });
						config.syncConfig = enabled;
					} catch (err) {
						new Notice(`Could not change sync settings: ${err}`);
						t.setValue(config.syncConfig);
					}
				}),
			);
		this.selectiveSync();
	}

	/** Folders and file types this device leaves out: neither sent, fetched nor deleted. */
	private selectiveSync(): void {
		const { containerEl, config } = this;
		// Read at each change: another setting may have changed it since this tab was drawn.
		const current = (): SyncFilter => config.filter ?? { excludedFolders: [], excludedTypes: [] };
		const filter = current();
		const save = async (next: SyncFilter): Promise<boolean> => {
			try {
				await invoke('set_sync_filter', { filter: next });
				config.filter = next;
				return true;
			} catch (err) {
				new Notice(`Could not change selective sync: ${err}`);
				return false;
			}
		};
		new Setting(containerEl)
			.setName('Selective sync')
			.setDesc('What this device leaves out. Left-out files stay on the server and on this device, and are not deleted on either side.')
			.setHeading();
		new Setting(containerEl)
			.setName('Excluded folders')
			.setDesc(filter.excludedFolders.length ? '' : 'None: every folder is synced.')
			.addButton((b) =>
				b.setButtonText('Add folder').onClick(() =>
					new FolderChoice(this.app, current().excludedFolders, (folder) => {
						const now = current();
						void save({ ...now, excludedFolders: [...now.excludedFolders, folder.path].sort() }).then(() => this.display());
					}).open(),
				),
			);
		for (const folder of filter.excludedFolders) {
			new Setting(containerEl)
				.setClass('emerald-sync-excluded-folder')
				.setName(folder)
				.addExtraButton((b) =>
					b
						.setIcon('x')
						.setTooltip('Sync this folder again')
						.onClick(() => {
							const now = current();
							void save({ ...now, excludedFolders: now.excludedFolders.filter((f) => f !== folder) }).then(() => this.display());
						}),
				);
		}
		for (const { type, name, desc } of FILE_TYPES) {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((t) =>
					t.setValue(!filter.excludedTypes.includes(type)).onChange(async (synced) => {
						const now = current();
						const excludedTypes = synced ? now.excludedTypes.filter((x) => x !== type) : [...now.excludedTypes, type];
						if (!(await save({ ...now, excludedTypes }))) t.setValue(!synced);
					}),
				);
		}
	}
}

function ago(ms: number): string {
	const seconds = Math.round((Date.now() - ms) / 1000);
	if (seconds < 45) return 'just now';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours} h ago` : new Date(ms).toLocaleString();
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** Sets up a synced vault's status and settings; its server and vault, or null if the vault is not synced. */
export async function setupSyncStatus(app: App, host: SyncStatusHost): Promise<SyncedVault | null> {
	const config = await invoke<SyncedVault | null>('open_vault_sync').catch(() => null);
	if (!config) return null;

	const item = app.statusBar.containerEl.createDiv({ cls: 'status-bar-item mod-clickable emerald-sync-status', attr: { role: 'button' } });
	app.statusBar.containerEl.prepend(item);
	const icon = item.createSpan('emerald-sync-icon');
	const label = item.createSpan('emerald-sync-label');
	const server = hostOf(config.serverUrl);
	let last: SyncStatus = { state: 'syncing' };

	const render = () => {
		item.dataset.state = last.state;
		switch (last.state) {
			case 'syncing':
				setIcon(icon, 'refresh-cw');
				label.setText('Syncing…');
				setTooltip(item, `Syncing with ${server}`);
				break;
			case 'synced':
				setIcon(icon, last.failed ? 'triangle-alert' : 'circle-check');
				label.setText(last.failed ? `Synced, ${last.failed} to retry` : 'Synced');
				setTooltip(item, `Synced with ${server} ${ago(last.lastSync)}. Click to sync now.`);
				break;
			case 'offline':
				setIcon(icon, 'cloud-off');
				label.setText('Offline');
				setTooltip(item, `${server} is unreachable; your changes are kept and will sync later.\n${last.message}`);
				break;
			case 'unauthorized':
				setIcon(icon, 'key-round');
				label.setText('Sign in again');
				setTooltip(item, `${server} no longer accepts the saved token. Click to enter a new one.`);
				break;
			case 'error':
				setIcon(icon, 'triangle-alert');
				label.setText('Sync error');
				setTooltip(item, last.message);
				break;
		}
	};
	render();

	const syncNow = () => {
		if (last.state === 'unauthorized') {
			host.reconnect();
			return;
		}
		void invoke('sync_now').catch((err: unknown) => host.notice(`Could not sync: ${err}`));
	};
	item.addEventListener('click', syncNow);
	app.commands.addCommand({ id: 'sync:sync-now', name: 'Sync: Sync now', callback: syncNow });
	app.setting.addBuiltInTab(new SyncTab(app, config, syncNow));
	// Refresh "x min ago" in the tooltip.
	window.setInterval(() => last.state === 'synced' && render(), 30_000);

	const unlisten = await listen<SyncStatus>('sync-status', (event) => {
		const previous = last;
		last = event.payload;
		render();
		if (last.state === 'synced' && last.conflictCopies.length) {
			// Settings files are not merged: the server's version stays, this device's goes to .trash.
			const settings = last.conflictCopies.filter((path) => path.startsWith('.trash/'));
			const notes = last.conflictCopies.filter((path) => !path.startsWith('.trash/'));
			if (notes.length) host.notice(`Edited on two devices: kept both versions. Your version is saved as ${notes.join(', ')}.`);
			if (settings.length) host.notice(`Settings changed on two devices: kept the server’s. This device’s are in ${settings.join(', ')}.`);
		}
		if (last.state === 'unauthorized' && previous.state !== 'unauthorized') {
			host.notice(`${server} no longer accepts the saved token. Click "Sign in again" in the status bar.`);
		}
	});
	// Settings from another device: themes and snippets reload by themselves; the rest needs a reload.
	const unlistenConfig = await listen<string[]>('config-synced', (event) => {
		const live = event.payload.every((path) => /^\.obsidian\/(snippets|themes)\//.test(path));
		if (live) return;
		const message = createFragment((f) => {
			f.appendText('Settings changed on another device. ');
			const button = f.createEl('button', { cls: 'mod-cta', text: 'Reload' });
			button.addEventListener('click', () => host.reload());
		});
		new Notice(message, 0);
	});
	window.addEventListener('beforeunload', unlistenConfig);
	// Statuses sent before this listener existed are lost: ask for a fresh pass.
	await invoke('sync_now').catch(() => {});
	window.addEventListener('beforeunload', unlisten);
	return config;
}
