import {
	App,
	DailyNotes,
	isDangerousUrl,
	registerEditorCommands,
	type Editor,
	isMacOS,
	Menu,
	moment,
	Notice,
	setIcon,
	setRequestBackend,
	setTooltip,
	Vault,
	type ConfigStore,
	type WorkspaceHost,
	type WorkspaceLeaf,
} from '@emeraldmd/api';
import {
	joinPath,
	MetadataCache,
	RemoteBackend,
	TFile,
	TFolder,
	type TAbstractFile,
	type VaultBackend,
	type VaultSnapshot,
	type VaultUpdate,
} from '@emeraldmd/core';
import { MemoryConfigStore } from '@emeraldmd/api/testing';
import { Vim, wikilinkAt } from '@emeraldmd/editor';

// Plugins that add Vim commands or mappings reach the emulation as `CodeMirrorAdapter.Vim`.
const vimAdapter = ((globalThis as { CodeMirrorAdapter?: Record<string, unknown> }).CodeMirrorAdapter ??= { commands: {} });
vimAdapter.Vim = Vim;
import { CommunityDirectory, CommunityPluginsTab, PluginHost } from '@emeraldmd/plugin-host';
import type { Extension } from '@codemirror/state';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask, open as openDialog } from '@tauri-apps/plugin-dialog';
import { AppearanceTab } from './appearance-tab';
import { BacklinksPane } from './backlinks';
import { FileExplorer } from './file-explorer';
import { EditorTab, FilesTab, HotkeysTab } from './settings-tabs';
import { CorePluginsTab, DailyNotesTab, FileRecoveryTab, NoteComposerTab, TemplatesTab, UniqueNoteCreatorTab } from './core-plugin-tabs';
import { CommandPalette } from './command-palette';
import { registerCoreViews, revealSearch } from './core-views';
import { RemoteVaults } from './remote';
import { hostOf } from './remote/connect-modal';
import { setupSyncStatus } from './synced';
import { NotePane, reasonOf, type PaneHost } from './pane';
import { fromObsidianLayout, toObsidianLayout, type ObsidianLayout } from './obsidian-layout';
import { SplitLayout, type SavedLayout, type SplitDirection } from './splits';
import { isEmptyTab, type Tab, type TabBar } from './tabs';
import { TauriBackend, TauriConfigStore, tauriRequestBackend, tauriTrustStore } from './tauri-backend';

/** A note to reopen after the page reloads to switch vaults (see `attach`). */
const REOPEN_FILE_KEY = 'emeraldmd:reopen-file';
/** Edits not saved yet when the page reloads (the server was unreachable): saved after the reload. */
const UNSAVED_KEY = 'emeraldmd:unsaved';
/** How often failed saves are tried again. */
const SAVE_RETRY_MS = 15_000;

/** Local storage keys (per vault, through `app.saveLocalStorage`). */
const LAST_FILE_KEY = 'emerald-last-file';
/** The main area: panes with their tabs (see `SavedLayout` in splits.ts). */
const LAYOUT_KEY = 'emerald-layout';
/** The tabs of the single pane, as saved before splits: `{ tabs: [{ file, mode }], active }`. */
const TABS_KEY = 'emerald-tabs';
/** How many closed tabs ⇧⌘T can reopen. */
const CLOSED_TABS_LIMIT = 20;
const SIDEBARS_KEY = 'emerald-sidebars';


function $(id: string): HTMLElement {
	const el = document.getElementById(id);
	if (!el) throw new Error(`#${id} is missing from index.html`);
	return el;
}

function countWords(text: string): number {
	const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/, '');
	return body.match(/\S+/g)?.length ?? 0;
}

/** The config folder of a server vault, through the server's config endpoints. */
async function remoteConfigStore(backend: VaultBackend): Promise<ConfigStore> {
	if (!(backend instanceof RemoteBackend) || !(await backend.supportsConfig().catch(() => false))) return new MemoryConfigStore();
	return {
		read: (path) => backend.readConfig(path),
		write: (path, data) => backend.writeConfig(path, data),
		list: (path) => backend.listConfig(path),
		stat: async (path) => {
			const entry = await backend.statConfig(path);
			return entry && { type: entry.kind, ctime: entry.ctime, mtime: entry.mtime, size: entry.size };
		},
		mkdir: (path) => backend.mkdirConfig(path),
		trash: (path) => backend.trashConfig(path),
	};
}

function isInside(file: TAbstractFile, folder: TAbstractFile): boolean {
	for (let f: TAbstractFile | null = file; f; f = f.parent) if (f === folder) return true;
	return false;
}

/** A stable per-vault id (plugins use it to namespace local storage). */
function appIdFor(basePath: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < basePath.length; i++) {
		const c = basePath.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 ^ c, 0x811c9dc5);
	}
	return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).slice(0, 16);
}

setRequestBackend(tauriRequestBackend);

class EmeraldApp {
	private app: App | null = null;
	private backend: VaultBackend | null = null;
	private readonly remote: RemoteVaults;
	private host: PluginHost | null = null;
	private renderQueued = false;
	private explorer: FileExplorer | null = null;
	private backlinks: BacklinksPane | null = null;
	/** The panes of the main area (splits), and the current one, where commands act and files open. */
	private layout: SplitLayout | null = null;
	private pane: NotePane | null = null;
	private paneHost: PaneHost | null = null;
	/** Closed tabs, where they were, most recent last, for "Undo close tab". */
	private readonly closedTabs: { pane: NotePane; tab: Tab; index: number }[] = [];
	private tabClock = 0;
	/** Saves of every pane, one after another: a note is read again only after them. */
	private pendingSave: Promise<void> = Promise.resolve();
	/**
	 * Notes whose last save failed (a server vault while the server is
	 * unreachable, a disk error), with the text to save: shown instead of the
	 * file, and saved again every few seconds and when the server is back.
	 */
	private readonly unsaved = new Map<TFile, string>();
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	/** A failed save was announced; the next time everything is saved, that is announced too. */
	private savesFailing = false;
	/** Editor extensions registered by plugins, for every pane's editor. */
	private editorExtensions: Extension[] = [];
	private lastHandledShortcut = -Infinity;
	private readonly el = {
		emptyState: $('empty-state'),
		workspace: $('workspace'),
		vaultName: $('vault-name'),
		tree: $('file-tree'),
		backlinks: $('backlinks'),
		status: $('status-core'),
	};

	constructor() {
		// Links that would run code or replace the page (javascript:, data:…) are never followed,
		// whatever drew them: notes are untrusted, and the page can call the app's commands.
		document.addEventListener(
			'click',
			(event) => {
				const link = event.target instanceof Element ? event.target.closest('a') : null;
				if (link && isDangerousUrl(link.getAttribute('href') ?? link.getAttribute('xlink:href'))) {
					event.preventDefault();
					event.stopImmediatePropagation();
				}
			},
			true,
		);
		// Links in rendered Markdown (reading view, Live Preview widgets, plugin views) open in the browser.
		document.addEventListener('click', (event) => {
			const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a.external-link[href]') : null;
			if (!link || event.defaultPrevented) return;
			event.preventDefault();
			void this.openExternal(link.href);
		});
		$('open-vault').addEventListener('click', () => void this.pickVault());
		$('switch-vault').addEventListener('click', () => void this.pickVault());
		$('new-note').addEventListener('click', () => void this.newNote());
		$('new-folder').addEventListener('click', () => void this.newFolder());
		// Once a vault is open, shortcuts are commands (see registerCommands); before that, only this one.
		window.addEventListener('keydown', (e) => {
			if (!this.app && (e.metaKey || e.ctrlKey) && !e.altKey && e.key === 'o') {
				e.preventDefault();
				void this.pickVault();
			}
		});
		this.followSystemTheme();
		this.markFrame();
		this.remote = new RemoteVaults({
			attach: (backend, snapshot, options) => this.attach(backend, snapshot, options),
			applyUpdate: (update) => this.vault?.applyUpdate(update),
			showEmptyState: () => this.showEmptyState(),
			notice: (message) => this.notice(message),
			openLocal: (path) => this.open(path),
			connected: () => {
				void this.retryUnsaved();
				for (const pane of this.panes()) pane.retryUnreadable();
			},
		});
		// The local vault's watcher; a remote vault's changes come through RemoteVaults.
		void listen<VaultUpdate>('vault-changed', (event) => {
			if (this.backend instanceof TauriBackend) this.vault?.applyUpdate(event.payload);
		});
		void getCurrentWindow().onCloseRequested(async (event) => {
			if (!(await this.saveAllOrAsk())) event.preventDefault();
		});
		// The native menu (src-tauri/src/menu.rs) and quitting.
		void listen<string>('menu-command', (event) => this.runMenuCommand(event.payload));
		void listen('quit-requested', async () => {
			if (await this.saveAllOrAsk()) await invoke('quit_app');
		});
		window.addEventListener('keydown', (e) => {
			// A shortcut the page handled; its menu item must not run the command again.
			if (e.defaultPrevented && (e.metaKey || e.ctrlKey)) this.lastHandledShortcut = performance.now();
		});
		// Leaving the window saves, so nothing is lost if the app is quit from elsewhere.
		window.addEventListener('blur', () => void this.flush());
	}

	/** A menu bar item: runs the command with that id, unless the page just ran it from the same shortcut. */
	private runMenuCommand(id: string): void {
		if (performance.now() - this.lastHandledShortcut < 300) return;
		if (id === 'app:open-vault') return void this.pickVault();
		if (id === 'emerald:connect-server') return this.remote.showDialog();
		if (this.app) this.app.commands.executeCommandById(id);
	}

	private get vault(): Vault | null {
		return this.app?.vault ?? null;
	}

	private get metadataCache(): MetadataCache | null {
		return this.app?.metadataCache ?? null;
	}

	/** The note in the current pane's editor. */
	private get activeFile(): TFile | null {
		return this.pane?.activeFile ?? null;
	}

	private panes(): NotePane[] {
		return this.layout?.panes() ?? [];
	}

	async start(): Promise<void> {
		if (await this.remote.resumeSession()) return;
		if (await this.remote.reopenLast()) return;
		const last = await invoke<string | null>('last_vault');
		if (last) {
			try {
				await this.open(last);
				return;
			} catch (err) {
				this.notice(`Could not reopen ${last}: ${err}`);
			}
		}
		this.showEmptyState();
	}

	/**
	 * macOS, where the title bar is hidden (tauri.conf.json): Obsidian's body
	 * classes, which themes use to leave room for the window's buttons; none
	 * of it in full screen, where the buttons are gone.
	 */
	private markFrame(): void {
		if (!isMacOS || !('__TAURI_INTERNALS__' in window)) return;
		document.body.addClass('mod-macos', 'is-frameless', 'is-hidden-frameless');
		const win = getCurrentWindow();
		const update = async () => document.body.toggleClass('is-fullscreen', (await win.isFullscreen().catch(() => false)) === true);
		void win.onResized(() => void update());
		void update();
	}

	private followSystemTheme(): void {
		const query = window.matchMedia('(prefers-color-scheme: dark)');
		const apply = () => {
			// With a vault open, its appearance settings decide (app.appearance).
			if (this.app) return;
			document.body.classList.toggle('theme-dark', query.matches);
			document.body.classList.toggle('theme-light', !query.matches);
		};
		apply();
		query.addEventListener('change', apply);
	}

	private showEmptyState(): void {
		this.el.emptyState.hidden = false;
		this.el.workspace.hidden = true;
		void getCurrentWindow().setTitle('EmeraldMD');
	}

	private async pickVault(): Promise<void> {
		const path = await openDialog({ directory: true, title: 'Open folder as vault' });
		if (typeof path === 'string') {
			try {
				await this.open(path);
			} catch (err) {
				this.notice(`Could not open ${path}: ${err}`);
			}
		}
	}

	private async open(path: string): Promise<void> {
		await this.flush();
		const snapshot = await invoke<VaultSnapshot>('open_vault', { path });
		await this.attach(new TauriBackend(), snapshot);
	}

	/**
	 * Shows a vault, local or remote. With a vault already open, the page
	 * reloads instead, because plugins can leave global state behind; the
	 * new vault opens on start (local: the Rust side remembers it; remote:
	 * `RemoteVaults.resumeSession`). `keepActiveFile` reopens the same note.
	 */
	private async attach(backend: VaultBackend, snapshot: VaultSnapshot, options: { keepActiveFile?: boolean } = {}): Promise<void> {
		this.remote.vaultOpened(backend);
		if (this.app) {
			await this.flush();
			await this.retryUnsaved();
			// Still not saved: kept for after the reload, when the same vault opens again.
			if (this.unsaved.size && options.keepActiveFile) {
				sessionStorage.setItem(UNSAVED_KEY, JSON.stringify([...this.unsaved].map(([file, text]) => ({ path: file.path, text }))));
			}
			if (options.keepActiveFile && this.activeFile) sessionStorage.setItem(REOPEN_FILE_KEY, this.activeFile.path);
			this.host?.unloadAll();
			window.location.reload();
			return;
		}
		const keep = sessionStorage.getItem(REOPEN_FILE_KEY);
		sessionStorage.removeItem(REOPEN_FILE_KEY);
		const local = backend instanceof TauriBackend;
		this.backend = backend;
		// Remote vaults keep `.obsidian` on the server; servers from before the config endpoints get it in memory.
		const config = local ? new TauriConfigStore() : await remoteConfigStore(backend);
		const vault = new Vault(backend, snapshot.name, snapshot.files, config);
		await vault.loadConfig();
		if (local) {
			// Attachments load through Tauri's asset protocol (allowed for the open vault only).
			vault.adapter.resourcePath = (path) => convertFileSrc(`${snapshot.basePath}/${path}`);
		}
		const metadataCache = new MetadataCache(vault, snapshot);
		const app = new App({
			vault,
			metadataCache,
			appId: appIdFor(local ? snapshot.basePath : `remote:${snapshot.name}`),
			statusBarEl: $('status-bar'),
			workspaceEl: this.el.workspace,
		});
		this.app = app;
		this.explorer = new FileExplorer(app, this.el.tree, {
			activeFile: () => this.pane?.tab?.file ?? null,
			openFile: (file, newTab) => this.pane!.openFile(file, { newTab }),
			flush: () => this.flush(),
			newNote: (folder) => this.newNote(folder),
			newFolder: (folder) => this.newFolder(folder),
			trash: (file) => this.trash(file),
			reveal: local ? (file) => invoke('reveal_path', { path: file.path }) : undefined,
			notice: (message) => this.notice(message),
		});
		this.backlinks = new BacklinksPane(app, this.el.backlinks, {
			activeFile: () => this.activeFile,
			openFileAt: (file, select) => this.pane!.openFileAt(file, select),
			search: backend.search ? (query, options) => backend.search!(query, options) : undefined,
			notice: (message) => this.notice(message),
		});
		await app.metadataTypeManager.load();
		await app.hotkeyManager.load();
		// Before plugins load, so their styles go under the theme's (see addPluginStyle).
		app.appearance.load();
		await app.customCss.load();
		// The order of Obsidian's settings.
		app.setting.addBuiltInTab(new EditorTab(app));
		app.setting.addBuiltInTab(new FilesTab(app));
		const directory = new CommunityDirectory(app);
		app.setting.addBuiltInTab(
			new AppearanceTab(app, {
				showFolder: local ? (path) => invoke('show_config_folder', { path }) : undefined,
				directory: local || !(config instanceof MemoryConfigStore) ? directory : undefined,
			}),
		);
		app.setting.addBuiltInTab(new HotkeysTab(app));
		app.setting.addBuiltInTab(new CorePluginsTab(app));
		app.setting.addCorePluginTab(new DailyNotesTab(app));
		app.setting.addCorePluginTab(new TemplatesTab(app));
		app.setting.addCorePluginTab(new FileRecoveryTab(app));
		app.setting.addCorePluginTab(new NoteComposerTab(app));
		app.setting.addCorePluginTab(new UniqueNoteCreatorTab(app));
		if (local) void listen<string>('config-changed', (event) => app.customCss.onConfigFileChanged(event.payload));
		this.mountWorkspace(app);
		this.applyEditorSettings();
		vault.on('config-changed', (key: string) => this.onConfigChanged(key));
		this.registerCommands(app);
		registerEditorCommands(app, { followLink: (editor, newTab) => this.followLinkAtCursor(editor, newTab) });
		await app.internalPlugins.load(app);
		if (local) {
			void setupSyncStatus(app, {
				notice: (message) => this.notice(message),
				reconnect: () => this.remote.showDialog(),
				reload: () => void this.flush().finally(() => window.location.reload()),
			});
		}
		registerCoreViews(app, {
			search: backend.search ? (query, options) => backend.search!(query, options) : undefined,
			openFile: (file, select) => this.pane!.openFileAt(file, select),
			openSearch: (query) => revealSearch(app, query),
		});

		for (const name of ['create', 'delete', 'rename']) vault.on(name, () => this.queueTreeRender());
		vault.on('rename', (file: TAbstractFile) => {
			let shown = false;
			for (const pane of this.panes()) shown = pane.onRenamed(file) || shown;
			if (!shown) return;
			this.renderWindowTitle();
			this.saveLayout();
		});
		vault.on('delete', (file: TAbstractFile) => {
			for (const pane of this.panes()) pane.onDeleted(file);
			// Deleted elsewhere while its edits waited to be saved: they cannot be saved any more.
			for (const lost of [...this.unsaved.keys()].filter((f) => isInside(f, file))) {
				this.unsaved.delete(lost);
				this.notice(`${lost.path} was deleted, so the changes not saved yet were dropped.`, 10000);
			}
		});
		vault.on('modify', (file: TFile) => {
			for (const pane of this.panes()) pane.onModified(file);
		});
		metadataCache.on('resolved', () => this.renderSidePanels());

		this.el.vaultName.textContent = snapshot.name;
		this.el.emptyState.hidden = true;
		this.el.workspace.hidden = false;
		this.renderTree();
		this.restoreSidebars(app);
		this.restoreUnsaved(vault);
		await this.restoreLayout(app, keep);
		// Every pane shows its current tab; the current pane last, so it keeps the focus.
		for (const pane of this.panes()) if (pane !== this.pane) await pane.showTab(pane.tab!);
		const daily = app.internalPlugins.getEnabledPluginById('daily-notes');
		if (daily instanceof DailyNotes && daily.options.autorun === true && !keep) await daily.openDay(moment());
		else await this.pane!.showTab(this.pane!.tab!);

		// Server vaults keep their plugins in `.obsidian` on the server; servers without the config endpoints have none.
		const server = local ? null : this.remote.activeVault();
		if (!local && (!server || config instanceof MemoryConfigStore)) {
			app.workspace.setLayoutReady();
			return;
		}
		const host = new PluginHost(app, tauriTrustStore(server ? `${server.serverUrl}|${server.vaultId}` : undefined));
		this.host = host;
		app.setting.addBuiltInTab(new CommunityPluginsTab(app, host, directory, { server: server ? hostOf(server.serverUrl) : undefined }));
		try {
			await host.initialize();
		} catch (err) {
			this.notice(`Could not load community plugins: ${err}`);
		}
		app.workspace.setLayoutReady();
		if (host.restricted && [...host.enabledPlugins].some((id) => host.manifests[id])) {
			const where = server ? ` (stored on ${hostOf(server.serverUrl)})` : '';
			this.notice(`This vault uses community plugins${where}. They stay off until you turn them on in Settings → Community plugins.`, 10000);
		}
	}

	/** Puts the workspace pieces (ribbon, side docks, the main area's first pane) into the page. */
	private mountWorkspace(app: App): void {
		const ws = app.workspace;
		const ribbon = ws.leftRibbon.containerEl;
		$('ribbon').replaceChildren(ribbon);
		// Its empty parts move the window, like the title bar they replace on macOS.
		ribbon.setAttribute('data-tauri-drag-region', '');
		const settings = ribbon.createDiv('side-dock-settings').createDiv({ cls: 'clickable-icon side-dock-ribbon-action', attr: { 'aria-label': 'Settings' } });
		setIcon(settings, 'settings');
		setTooltip(settings, 'Settings', { placement: 'right' });
		settings.addEventListener('click', () => app.setting.open());

		$('left-split').append(ws.leftSplit.containerEl);
		ws.leftSplit.addStaticTab('file-explorer', 'Files', 'folder-closed', $('file-explorer'));
		$('right-split').append(ws.rightSplit.containerEl);
		ws.rightSplit.addStaticTab('backlinks', 'Backlinks', 'links-coming-in', $('backlinks-pane'));

		this.paneHost = {
			app,
			notice: (message, duration) => this.notice(message, duration),
			saveText: (file, text) => this.saveText(file, text),
			saved: () => this.pendingSave,
			unsavedText: (file) => this.unsaved.get(file),
			activate: (pane) => this.activatePane(pane),
			isCurrent: (pane) => pane === this.pane,
			saveLayout: () => this.saveLayout(),
			shown: (pane) => {
				if (pane === this.pane) this.onCurrentNoteChanged();
			},
			statusChanged: (pane) => {
				if (pane === this.pane) this.renderStatus();
			},
			closed: (pane, tab, index) => {
				this.closedTabs.push({ pane, tab, index });
				if (this.closedTabs.length > CLOSED_TABS_LIMIT) this.closedTabs.shift();
			},
			removeIfEmpty: (pane) => this.removePane(pane),
			nextTabClock: () => ++this.tabClock,
			openExternal: (url) => this.openExternal(url),
			trash: (file) => this.trash(file),
			propertiesInDocument: () => this.propertiesInDocument(),
			editorExtensions: () => this.editorExtensions,
			tabMenu: (pane, tab, event) => this.showTabMenu(pane, tab, event),
			moveTab: (tab, from, to, index) => this.moveTab(tab, from, to, index),
			splitWithTab: (tab, from, target, direction, before) => this.splitWithTab(tab, from, target, direction, before),
		};
		// The first pane uses the note view's parts in index.html.
		const first = new NotePane(this.paneHost, ws.rootLeaf, {
			title: $('file-title') as HTMLInputElement,
			trash: $('trash-file'),
			editor: $('editor'),
			noFile: $('no-file'),
		});
		this.pane = first;
		first.setActive(true);
		this.layout = new SplitLayout(ws.rootSplit.containerEl, first);
		this.layout.onResize = () => this.saveLayout();
		ws.rootSplit.onLeafUpdated = (leaf) => this.paneOf(leaf)?.syncWithLeaf();
		$('root-split').replaceWith(ws.rootSplit.containerEl);

		const host: WorkspaceHost = {
			openFile: (file, leaf) => this.paneFor(leaf).openFile(file),
			openInTab: (file, leaf) => this.paneFor(leaf).openFile(file),
			newTab: (leaf) => void this.paneFor(leaf).newTab(),
			closeTab: (leaf) => {
				const pane = this.paneFor(leaf);
				if (pane.tab) pane.closeTab(pane.tab);
			},
			split: (leaf, direction, before) => this.splitPane(this.paneFor(leaf), direction, { before }).leaf,
			activatePane: (leaf) => {
				const pane = this.paneOf(leaf);
				if (pane) this.activatePane(pane);
			},
			save: () => this.flush(),
			getLayout: () => this.obsidianLayout(),
			changeLayout: (layout) => this.changeLayout(layout),
			setEditorExtensions: (extensions: Extension[]) => {
				this.editorExtensions = extensions;
				for (const pane of this.panes()) pane.setExtensions(extensions);
			},
		};
		ws.setHost(host, first.view);
	}

	private paneOf(leaf: WorkspaceLeaf | undefined): NotePane | null {
		return (leaf && this.panes().find((pane) => pane.leaf === leaf)) || null;
	}

	/** The pane of `leaf`, else the current one. */
	private paneFor(leaf: WorkspaceLeaf | undefined): NotePane {
		return this.paneOf(leaf) ?? this.pane!;
	}

	/** A new pane (not yet in the layout) with a new leaf and note view. */
	private createPane(): NotePane {
		const ws = this.app!.workspace;
		const pane = new NotePane(this.paneHost!, ws.createRootLeaf());
		ws.addRootLeaf(pane.leaf, pane.view);
		pane.applySettings();
		return pane;
	}

	/** Keeps the workspace's pane leaves in layout order. */
	private syncRootLeaves(): void {
		const ws = this.app!.workspace;
		ws.rootLeaves = this.panes().map((pane) => pane.leaf);
	}

	/** Makes `pane` the current one: commands act there and files open there. */
	private activatePane(pane: NotePane): void {
		if (this.pane === pane || !this.panes().includes(pane)) return;
		this.pane = pane;
		for (const other of this.panes()) other.setActive(other === pane);
		const ws = this.app!.workspace;
		ws.setActiveLeaf(pane.leaf);
		this.onCurrentNoteChanged();
		ws.trigger('file-open', pane.leaf.view === pane.view ? pane.activeFile : ((pane.leaf.view as { file?: TFile | null }).file ?? null));
		this.saveLayout();
	}

	/**
	 * Opens a new pane next to `pane`: on its right (`vertical`) or below it
	 * (`horizontal`). With `duplicate`, it shows the same note (as Obsidian's
	 * "Split right"); else an empty tab, for a plugin to fill.
	 */
	private splitPane(pane: NotePane, direction: SplitDirection, options: { before?: boolean; duplicate?: boolean } = {}): NotePane {
		void pane.flush();
		const added = this.createPane();
		this.layout!.split(pane, added, direction, options.before);
		this.syncRootLeaves();
		const tab = pane.tab;
		added.restore(null, options.duplicate && tab?.file ? tab.file : null);
		if (options.duplicate && tab) added.tab!.mode = tab.mode;
		this.activatePane(added);
		if (added.tab?.file) void added.showTab(added.tab);
		else added.showEmptyTab();
		this.saveLayout();
		return added;
	}

	/** Takes out a pane whose last tab closed; false if it is the only one. */
	private removePane(pane: NotePane): boolean {
		const panes = this.panes();
		if (panes.length < 2) return false;
		void pane.flush();
		const next = panes[panes.indexOf(pane) - 1] ?? panes[panes.indexOf(pane) + 1]!;
		this.layout!.remove(pane);
		this.syncRootLeaves();
		if (this.pane === pane) {
			this.pane = null;
			this.activatePane(next);
			next.focus();
		}
		this.app!.workspace.removeRootLeaf(pane.leaf);
		pane.destroy();
		this.saveLayout();
		return true;
	}

	/** The current pane's note changed (or the current pane did): file tree, side panels, window title. */
	private onCurrentNoteChanged(): void {
		const file = this.pane?.tab?.file ?? null;
		this.renderWindowTitle();
		this.explorer?.setActive(file);
		this.renderSidePanels();
		if (file) this.app?.saveLocalStorage(LAST_FILE_KEY, file.path);
	}

	/** Saves the panes and their tabs (per vault) for the next start. */
	private saveLayout(): void {
		if (!this.app || !this.layout) return;
		this.app.saveLocalStorage(LAYOUT_KEY, this.layout.serialize(this.pane));
	}

	/**
	 * The panes and tabs open when the app last closed (only the current tab
	 * of each pane loads its note); else one tab with the last note, or the
	 * most recently edited one. `keep` is a note to show after a reload.
	 */
	private async restoreLayout(app: App, keep: string | null): Promise<void> {
		const vault = app.vault;
		const first = this.pane!;
		const last = app.loadLocalStorage(LAST_FILE_KEY);
		const fallback =
			(typeof last === 'string' && vault.getFileByPath(last)) || vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime)[0] || null;
		let saved = app.loadLocalStorage(LAYOUT_KEY) as SavedLayout | null;
		if (!saved && app.loadLocalStorage(TABS_KEY) === null) {
			// A vault opened here for the first time: the layout Obsidian left in workspace.json, if any.
			const fromObsidian = await this.readObsidianLayout(app);
			if (fromObsidian) {
				saved = fromObsidian.saved;
				if (fromObsidian.sidebars.left !== undefined) $('left-split').toggleClass('is-collapsed', !fromObsidian.sidebars.left);
				if (fromObsidian.sidebars.right !== undefined) $('right-split').toggleClass('is-collapsed', !fromObsidian.sidebars.right);
			}
		}
		if (saved && typeof saved === 'object' && (saved.type === 'split' || saved.type === 'tabs')) {
			this.buildLayout(saved, fallback);
		} else {
			first.restore(app.loadLocalStorage(TABS_KEY), fallback);
		}
		const kept = keep ? vault.getFileByPath(keep) : null;
		if (kept) {
			const pane = this.panes().find((p) => p.tabBar.tabs.some((tab) => tab.file === kept)) ?? this.pane!;
			this.activatePane(pane);
			pane.selectFile(kept);
		}
		this.saveLayout();
	}

	/** Panes and tabs from a saved layout, on a layout with only the first pane (shown later). */
	private buildLayout(saved: SavedLayout, fallback: TFile | null): void {
		const first = this.pane!;
		const current = this.layout!.restore(saved, first, (tabs, isFirst) => {
			const pane = isFirst ? first : this.createPane();
			pane.restore(tabs, isFirst ? fallback : null);
			return pane;
		});
		this.syncRootLeaves();
		// Nothing saved for the first pane (an older layout): it still needs a tab.
		if (!first.tab) first.restore(null, fallback);
		this.activatePane(current);
	}

	private async readObsidianLayout(app: App): Promise<ReturnType<typeof fromObsidianLayout>> {
		const path = `${app.vault.configDir}/workspace.json`;
		try {
			if (!(await app.vault.adapter.exists(path))) return null;
			return fromObsidianLayout(JSON.parse(await app.vault.adapter.read(path)));
		} catch {
			return null;
		}
	}

	/** The layout in Obsidian's format (`workspace.getLayout()`). */
	private obsidianLayout(): ObsidianLayout {
		const sidebars = { left: !$('left-split').hasClass('is-collapsed'), right: !$('right-split').hasClass('is-collapsed') };
		return toObsidianLayout(this.layout!.serialize(this.pane), sidebars, this.app?.workspace.getLastOpenFiles() ?? []);
	}

	/** Replaces the main area's panes and tabs with a layout in Obsidian's format (`workspace.changeLayout()`, Workspaces). */
	private async changeLayout(layout: unknown): Promise<void> {
		const converted = fromObsidianLayout(layout);
		if (!converted || !this.layout) return;
		await this.flush();
		const first = this.panes()[0]!;
		for (const pane of this.panes()) {
			if (pane === first) continue;
			this.layout.remove(pane);
			this.app!.workspace.removeRootLeaf(pane.leaf);
			pane.destroy();
		}
		this.pane = first;
		first.leaveTab();
		first.tabBar.tabs = [];
		first.tabBar.active = null;
		this.buildLayout(converted.saved, null);
		if (converted.sidebars.left !== undefined) $('left-split').toggleClass('is-collapsed', !converted.sidebars.left);
		if (converted.sidebars.right !== undefined) $('right-split').toggleClass('is-collapsed', !converted.sidebars.right);
		for (const pane of this.panes()) if (pane !== this.pane) await pane.showTab(pane.tab!);
		await this.pane!.showTab(this.pane!.tab!);
		this.saveLayout();
		this.app!.workspace.trigger('layout-change');
	}

	/** A dragged tab dropped in a tab bar or on a pane: reordered, or moved to that pane. */
	private moveTab(tab: Tab, fromBar: TabBar, to: NotePane, index: number): void {
		const from = this.panes().find((pane) => pane.tabBar === fromBar);
		if (!from || !fromBar.tabs.includes(tab)) return;
		if (from === to) return to.reorder(tab, index);
		from.release(tab);
		to.takeTab(tab, index);
	}

	/** A dragged tab dropped on an edge of `target`: a new pane on that side shows it. */
	private splitWithTab(tab: Tab, fromBar: TabBar, target: NotePane, direction: SplitDirection, before: boolean): void {
		const from = this.panes().find((pane) => pane.tabBar === fromBar);
		if (!from || !fromBar.tabs.includes(tab)) return;
		// The only tab of a pane dropped on its own edge: nothing would change.
		if (from === target && fromBar.tabs.length === 1) return;
		const added = this.createPane();
		this.layout!.split(target, added, direction, before);
		this.syncRootLeaves();
		from.release(tab);
		added.takeTab(tab, 0);
		this.saveLayout();
	}

	/** "Follow link under cursor": a wikilink, a Markdown link or a URL on the cursor's line. */
	private followLinkAtCursor(editor: Editor, newTab: boolean): boolean {
		const app = this.app!;
		const pos = editor.getCursor();
		const line = editor.getLine(pos.line);
		const wikilink = wikilinkAt(line, pos.ch);
		if (wikilink !== null) {
			void app.workspace.openLinkText(wikilink, this.activeFile?.path ?? '', newTab);
			return true;
		}
		const around = (re: RegExp) => [...line.matchAll(re)].find((m) => m.index <= pos.ch && pos.ch <= m.index + m[0].length);
		const markdown = around(/\[[^\]]*\]\(([^)\s]+)\)/g);
		const target = markdown?.[1] ?? around(/[a-z][a-z0-9+.-]*:\/\/[^\s)>\]]+/gi)?.[0];
		if (!target) return false;
		if (/^[a-z][a-z0-9+.-]*:/i.test(target)) void this.openExternal(target);
		else void app.workspace.openLinkText(decodeURI(target), this.activeFile?.path ?? '', newTab);
		return true;
	}

	/** Context menu of a tab header: close, split. */
	private showTabMenu(pane: NotePane, tab: Tab, event: MouseEvent): void {
		const menu = new Menu();
		const split = (direction: SplitDirection) => {
			pane.activateTab(tab);
			this.splitPane(pane, direction, { duplicate: true });
		};
		menu.addItem((item) => item.setTitle('Close').setIcon('x').setSection('close').onClick(() => pane.closeTab(tab)));
		menu.addItem((item) =>
			item
				.setTitle('Close others')
				.setIcon('x-circle')
				.setSection('close')
				.setDisabled(pane.tabBar.tabs.length < 2)
				.onClick(() => {
					for (const other of [...pane.tabBar.tabs]) if (other !== tab) pane.closeTab(other);
				}),
		);
		menu.addItem((item) => item.setTitle('Split right').setIcon('separator-vertical').setSection('split').onClick(() => split('vertical')));
		menu.addItem((item) => item.setTitle('Split down').setIcon('separator-horizontal').setSection('split').onClick(() => split('horizontal')));
		menu.showAtMouseEvent(event);
	}

	/** Reopens the last closed tab where it was (its note, history and editor state), unless its file is gone. */
	private reopenClosedTab(): void {
		let closed: { pane: NotePane; tab: Tab; index: number } | undefined;
		while ((closed = this.closedTabs.pop()) && closed.tab.file && !this.vault?.getFileByPath(closed.tab.file.path)) {}
		if (!closed) return;
		const pane = this.panes().includes(closed.pane) ? closed.pane : this.pane!;
		// Editor state belongs to the editor it came from: in another pane, the note loads afresh.
		if (pane !== closed.pane) closed.tab.state = null;
		this.activatePane(pane);
		pane.reopen(closed.tab, closed.index);
	}

	/** Built-in commands, with the shortcuts the app has always had. */
	private registerCommands(app: App): void {
		const add = app.commands.addCommand.bind(app.commands);
		add({ id: 'command-palette:open', name: 'Command palette: Open command palette', hotkeys: [{ modifiers: ['Mod'], key: 'P' }], callback: () => new CommandPalette(app).open() });
		add({ id: 'app:open-settings', name: 'Open settings', hotkeys: [{ modifiers: ['Mod'], key: ',' }], callback: () => app.setting.open() });
		add({ id: 'file-explorer:new-file', name: 'Create new note', hotkeys: [{ modifiers: ['Mod'], key: 'N' }], callback: () => this.newNote() });
		add({ id: 'file-explorer:new-folder', name: 'Create new folder', callback: () => this.newFolder() });
		add({
			id: 'file-explorer:reveal-active-file',
			name: 'Files: Reveal current file in navigation',
			checkCallback: (checking) => {
				if (!this.activeFile) return false;
				if (!checking) this.explorer?.reveal(this.activeFile);
				return true;
			},
		});
		add({
			id: 'editor:save-file',
			name: 'Save current file',
			hotkeys: [{ modifiers: ['Mod'], key: 'S' }],
			checkCallback: (checking) => {
				if (!this.activeFile) return false;
				if (!checking) void this.flush();
				return true;
			},
		});
		add({
			id: 'markdown:toggle-preview',
			name: 'Toggle reading view',
			hotkeys: [{ modifiers: ['Mod'], key: 'E' }],
			checkCallback: (checking) => {
				if (!this.activeFile) return false;
				if (!checking) void this.pane!.toggleReading();
				return true;
			},
		});
		add({ id: 'app:go-back', name: 'Navigate back', hotkeys: [{ modifiers: ['Mod', 'Alt'], key: 'ArrowLeft' }], callback: () => this.pane?.navigate(-1) });
		add({ id: 'app:go-forward', name: 'Navigate forward', hotkeys: [{ modifiers: ['Mod', 'Alt'], key: 'ArrowRight' }], callback: () => this.pane?.navigate(1) });
		add({ id: 'workspace:new-tab', name: 'New tab', hotkeys: [{ modifiers: ['Mod'], key: 'T' }], callback: () => void this.pane?.newTab() });
		add({
			id: 'workspace:close',
			name: 'Close current tab',
			hotkeys: [{ modifiers: ['Mod'], key: 'W' }],
			checkCallback: (checking) => {
				const pane = this.pane;
				const tab = pane?.tab;
				// The only tab of the only pane, already empty: nothing to close.
				if (!pane || !tab || (isEmptyTab(tab) && pane.tabBar.tabs.length === 1 && this.panes().length === 1)) return false;
				if (!checking) pane.closeTab(tab);
				return true;
			},
		});
		add({
			id: 'workspace:close-others',
			name: 'Close all other tabs',
			checkCallback: (checking) => {
				const pane = this.pane;
				const tab = pane?.tab;
				if (!pane || !tab || pane.tabBar.tabs.length < 2) return false;
				if (!checking) for (const other of [...pane.tabBar.tabs]) if (other !== tab) pane.closeTab(other);
				return true;
			},
		});
		add({
			id: 'workspace:undo-close-pane',
			name: 'Undo close tab',
			hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'T' }],
			checkCallback: (checking) => {
				if (!this.closedTabs.length) return false;
				if (!checking) this.reopenClosedTab();
				return true;
			},
		});
		const step = (id: string, name: string, direction: 1 | -1, hotkeys: { modifiers: ('Ctrl' | 'Mod' | 'Shift' | 'Alt')[]; key: string }[]) =>
			add({
				id,
				name,
				hotkeys,
				checkCallback: (checking) => {
					const bar = this.pane?.tabBar;
					if (!bar?.active || bar.tabs.length < 2) return false;
					if (!checking) this.pane!.activateTab(bar.neighbour(bar.active, direction));
					return true;
				},
			});
		step('workspace:next-tab', 'Go to next tab', 1, [{ modifiers: ['Ctrl'], key: 'Tab' }, { modifiers: ['Mod', 'Shift'], key: ']' }]);
		step('workspace:previous-tab', 'Go to previous tab', -1, [{ modifiers: ['Ctrl', 'Shift'], key: 'Tab' }, { modifiers: ['Mod', 'Shift'], key: '[' }]);
		for (let n = 1; n <= 8; n++) {
			add({
				id: `workspace:goto-tab-${n}`,
				name: `Go to tab #${n}`,
				hotkeys: [{ modifiers: ['Mod'], key: String(n) }],
				checkCallback: (checking) => {
					const tab = this.pane?.tabBar.tabs[n - 1];
					if (!tab) return false;
					if (!checking) this.pane!.activateTab(tab);
					return true;
				},
			});
		}
		add({
			id: 'workspace:goto-last-tab',
			name: 'Go to last tab',
			hotkeys: [{ modifiers: ['Mod'], key: '9' }],
			checkCallback: (checking) => {
				const tab = this.pane?.tabBar.tabs.at(-1);
				if (!tab) return false;
				if (!checking) this.pane!.activateTab(tab);
				return true;
			},
		});
		// Splits (Obsidian's ids): the new pane shows the same note.
		add({ id: 'workspace:split-vertical', name: 'Split right', callback: () => void this.splitPane(this.pane!, 'vertical', { duplicate: true }) });
		add({ id: 'workspace:split-horizontal', name: 'Split down', callback: () => void this.splitPane(this.pane!, 'horizontal', { duplicate: true }) });
		add({
			id: 'workspace:close-tab-group',
			name: 'Close this tab group',
			checkCallback: (checking) => {
				const pane = this.pane;
				if (!pane || this.panes().length < 2) return false;
				if (!checking) for (const tab of [...pane.tabBar.tabs]) pane.closeTab(tab);
				return true;
			},
		});
		for (const [side, name] of [
			['left', 'left'],
			['right', 'right'],
			['top', 'above'],
			['bottom', 'below'],
		] as const) {
			add({
				id: `editor:focus-${side}`,
				name: `Focus on tab group ${name}`,
				checkCallback: (checking) => {
					const target = this.pane && this.layout?.neighbour(this.pane, side);
					if (!target) return false;
					if (!checking) {
						this.activatePane(target);
						target.focus();
					}
					return true;
				},
			});
		}
		for (const [id, name, replace, hotkey] of [
			['editor:open-search', 'Search current file', false, [{ modifiers: ['Mod'], key: 'F' }]],
			['editor:open-search-replace', 'Search & replace in current file', true, [{ modifiers: ['Mod', 'Alt'], key: 'F' }]],
		] as const) {
			add({
				id,
				name,
				hotkeys: hotkey.map((h) => ({ modifiers: [...h.modifiers], key: h.key })),
				checkCallback: (checking) => {
					const pane = this.pane;
					if (!pane?.activeFile || pane.view.getMode() !== 'source') return false;
					if (!checking) pane.editor.openSearch(replace);
					return true;
				},
			});
		}
		add({
			id: 'markdown:add-metadata-property',
			name: 'Add file property',
			hotkeys: [{ modifiers: ['Mod'], key: ';' }],
			checkCallback: (checking) => {
				if (!this.activeFile) return false;
				if (!checking) void this.pane!.addProperty();
				return true;
			},
		});
		add({
			id: 'editor:toggle-source',
			name: 'Toggle Live Preview/Source mode',
			checkCallback: (checking) => {
				const view = this.pane?.view;
				if (!view || !this.activeFile || view.getMode() !== 'source') return false;
				if (!checking) view.setLivePreview(!view.livePreview);
				return true;
			},
		});
		add({
			id: 'app:delete-file',
			name: 'Delete current file',
			checkCallback: (checking) => {
				if (!this.activeFile) return false;
				if (!checking && this.activeFile) void this.trash(this.activeFile);
				return true;
			},
		});
		// Mod+O is the quick switcher, as in Obsidian.
		add({ id: 'app:open-vault', name: 'Open another vault', callback: () => this.pickVault() });
		add({ id: 'emerald:connect-server', name: 'Connect to a server vault', callback: () => this.remote.showDialog() });
		add({ id: 'app:toggle-left-sidebar', name: 'Toggle left sidebar', callback: () => this.toggleSplit($('left-split')) });
		add({ id: 'app:toggle-right-sidebar', name: 'Toggle right sidebar', callback: () => this.toggleSplit($('right-split')) });
		add({ id: 'app:reload', name: 'Reload app without saving', callback: () => window.location.reload() });
	}

	private toggleSplit(el: HTMLElement): void {
		el.toggleClass('is-collapsed', !el.hasClass('is-collapsed'));
		this.app?.saveLocalStorage(SIDEBARS_KEY, { left: !$('left-split').hasClass('is-collapsed'), right: !$('right-split').hasClass('is-collapsed') });
		this.app?.workspace.trigger('resize');
	}

	/** Shows or hides the sidebars as they were when the vault was last open. */
	private restoreSidebars(app: App): void {
		const saved = app.loadLocalStorage(SIDEBARS_KEY) as { left?: unknown; right?: unknown } | null;
		if (!saved) return;
		$('left-split').toggleClass('is-collapsed', saved.left === false);
		$('right-split').toggleClass('is-collapsed', saved.right === false);
	}

	/** Applies Settings → Editor (app.json) to every pane. */
	private applyEditorSettings(): void {
		for (const pane of this.panes()) pane.applySettings();
	}

	private onConfigChanged(key: string): void {
		const panes = this.panes();
		if (['showLineNumber', 'spellcheck', 'tabSize', 'useTab', 'autoPairBrackets', 'readableLineLength', 'vimMode', 'foldHeading', 'foldIndent'].includes(key)) this.applyEditorSettings();
		else if (key === 'strictLineBreaks') for (const pane of panes) void pane.view.renderPreview();
		else if (key === 'livePreview') for (const pane of panes) pane.view.setLivePreview(this.vault?.getConfig('livePreview') !== false);
		else if (key === 'propertiesInDocument') for (const pane of panes) pane.refreshProperties();
	}

	private propertiesInDocument(): 'visible' | 'hidden' | 'source' {
		const mode = this.vault?.getConfig('propertiesInDocument');
		return mode === 'hidden' || mode === 'source' ? mode : 'visible';
	}

	/** Opens a web or mail link in the default app. */
	private async openExternal(url: string): Promise<void> {
		try {
			await invoke('open_external', { url });
		} catch (err) {
			this.notice(`Could not open ${url}: ${err}`);
		}
	}

	/** Saves pending edits in every pane now, and tries again the saves that failed. */
	private flush(): Promise<void> {
		for (const pane of this.panes()) void pane.flush();
		if (this.unsaved.size) void this.retryUnsaved();
		return this.pendingSave;
	}

	/**
	 * Saves `text` (or, with `null`, the text still waiting to be saved for
	 * `file`, read when the save runs) after the saves already queued. Saves
	 * run in order, so the last one for a file decides whether it is saved.
	 */
	private saveText(file: TFile, text: string | null): Promise<boolean> {
		const vault = this.vault;
		const save = this.pendingSave.then(async () => {
			const data = text ?? this.unsaved.get(file);
			if (!vault || data === undefined) return true;
			try {
				await vault.modify(file, data);
				this.unsaved.delete(file);
				if (!this.unsaved.size && this.savesFailing) {
					this.savesFailing = false;
					this.notice('All changes are saved.');
				}
				return true;
			} catch (err) {
				this.unsaved.set(file, data);
				if (!this.savesFailing) {
					this.savesFailing = true;
					this.notice(`Could not save ${file.path}: ${reasonOf(err)}. Your changes are kept and saved as soon as possible.`, 10000);
				}
				this.scheduleRetry();
				return false;
			} finally {
				this.renderStatus();
			}
		});
		this.pendingSave = save.then(() => undefined);
		return save;
	}

	private scheduleRetry(): void {
		clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => void this.retryUnsaved(), SAVE_RETRY_MS);
	}

	/** Saves again the notes whose last save failed. */
	private async retryUnsaved(): Promise<void> {
		clearTimeout(this.retryTimer);
		const files = [...this.unsaved.keys()];
		await Promise.all(files.map((file) => this.saveText(file, null)));
	}

	/** Edits kept across a reload (see `attach`), for the notes that still exist. */
	private restoreUnsaved(vault: Vault): void {
		const saved = sessionStorage.getItem(UNSAVED_KEY);
		sessionStorage.removeItem(UNSAVED_KEY);
		if (!saved) return;
		try {
			for (const { path, text } of JSON.parse(saved) as { path: string; text: string }[]) {
				const file = vault.getFileByPath(path);
				if (file && typeof text === 'string') this.unsaved.set(file, text);
			}
		} catch {
			return;
		}
		if (this.unsaved.size) this.scheduleRetry();
	}

	/** Before the window closes or the app quits: saves everything; if some notes still cannot be saved, asks. */
	private async saveAllOrAsk(): Promise<boolean> {
		await this.flush().catch((err: unknown) => console.error(err));
		if (!this.unsaved.size) return true;
		await this.retryUnsaved();
		if (!this.unsaved.size) return true;
		const names = [...this.unsaved.keys()].map((file) => file.basename).join(', ');
		return ask(`These notes could not be saved: ${names}. Quit anyway and lose those changes?`, { title: 'Unsaved changes', kind: 'warning' });
	}

	/** A new note in `folder`, or where the vault's "Default location for new notes" says. */
	private async newNote(folder?: TFolder): Promise<void> {
		const app = this.app;
		const pane = this.pane;
		if (!app || !pane) return;
		const parent = folder ?? app.fileManager.getNewFileParent(this.activeFile?.path ?? '');
		try {
			await pane.openFile(await app.vault.create(app.vault.getAvailablePath(joinPath(parent.isRoot() ? '' : parent.path, 'Untitled'), 'md'), ''));
			pane.selectTitle();
		} catch (err) {
			this.notice(`Could not create a note: ${err}`);
		}
	}

	/** A new folder, named in place in the file tree. */
	private async newFolder(folder?: TFolder): Promise<void> {
		const app = this.app;
		if (!app) return;
		const parent = folder ?? app.vault.getRoot();
		try {
			const created = await app.vault.createFolder(app.vault.getAvailablePath(joinPath(parent.isRoot() ? '' : parent.path, 'Untitled'), ''));
			this.explorer?.startRename(created);
		} catch (err) {
			this.notice(`Could not create a folder: ${err}`);
		}
	}

	/** Moves a file or folder to the vault's `.trash`, after asking. */
	private async trash(file: TAbstractFile): Promise<void> {
		if (!this.vault) return;
		const what = file instanceof TFolder ? `the folder "${file.name}" and everything in it` : `"${file.name}"`;
		if (this.app?.vault.getConfig('promptDelete') !== false) {
			const ok = await ask(`Move ${what} to the vault's .trash folder?`, { title: 'Move to trash', kind: 'warning' });
			if (!ok) return;
		}
		try {
			if (this.panes().some((pane) => pane.activeFile && isInside(pane.activeFile, file))) await this.flush();
			await this.vault.trash(file);
		} catch (err) {
			this.notice(`Could not move to trash: ${err}`);
		}
	}

	private queueTreeRender(): void {
		if (this.renderQueued) return;
		this.renderQueued = true;
		requestAnimationFrame(() => {
			this.renderQueued = false;
			this.renderTree();
			this.renderSidePanels();
		});
	}

	private renderWindowTitle(): void {
		const shown = this.pane?.tab?.file ?? null;
		const vaultName = this.vault?.getName() ?? '';
		void getCurrentWindow().setTitle(shown ? `${shown.extension === 'md' ? shown.basename : shown.name} - ${vaultName} - EmeraldMD` : `${vaultName} - EmeraldMD`);
	}

	private renderTree(): void {
		this.explorer?.render();
	}

	private renderSidePanels(): void {
		this.renderStatus();
		this.backlinks?.requestRender();
	}

	private renderStatus(): void {
		const pane = this.pane;
		const file = this.activeFile;
		if (!pane || !file || !this.metadataCache) {
			this.el.status.textContent = '';
			return;
		}
		const backlinks = this.metadataCache.getBacklinks(file).length;
		const words = countWords(pane.editor.getValue());
		const state = pane.saving ? 'Saving…' : this.unsaved.has(file) ? 'Not saved yet, retrying' : pane.hasUnsavedEdits ? 'Unsaved changes' : 'Saved';
		this.el.status.textContent = `${state} · ${words} words · ${backlinks} backlink${backlinks === 1 ? '' : 's'}`;
	}

	private notice(message: string, duration = 6000): void {
		new Notice(message, duration);
	}
}

void new EmeraldApp().start();
