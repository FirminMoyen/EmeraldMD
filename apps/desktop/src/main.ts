import {
	App,
	CodeMirrorEditor,
	Component,
	DailyNotes,
	moment,
	editorInfoExtensions,
	MarkdownRenderer,
	MarkdownView,
	isDangerousUrl,
	Notice,
	setIcon,
	setLivePreviewEffect,
	setRequestBackend,
	setTooltip,
	Vault,
	type ConfigStore,
	type MarkdownViewModeType,
	type WorkspaceHost,
} from '@emeraldmd/api';
import {
	getLinkpath,
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
import { MarkdownEditor, Vim } from '@emeraldmd/editor';

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
import { CorePluginsTab, DailyNotesTab, TemplatesTab } from './core-plugin-tabs';
import { CommandPalette } from './command-palette';
import { registerCoreViews, revealSearch } from './core-views';
import { RemoteVaults } from './remote';
import { hostOf } from './remote/connect-modal';
import { setupSyncStatus } from './synced';
import { emptyTab, isEmptyTab, TabBar, type Tab } from './tabs';
import { TauriBackend, TauriConfigStore, tauriRequestBackend, tauriTrustStore } from './tauri-backend';

/** A note to reopen after the page reloads to switch vaults (see `attach`). */
const REOPEN_FILE_KEY = 'emeraldmd:reopen-file';

/** Same autosave delay as Obsidian. */
const SAVE_DELAY_MS = 2000;
/** Local storage keys (per vault, through `app.saveLocalStorage`). */
const LAST_FILE_KEY = 'emerald-last-file';
/** The open tabs: `{ tabs: [{ file, mode }], active }`. */
const TABS_KEY = 'emerald-tabs';
/** How many notes back/forward remembers. */
const HISTORY_LIMIT = 50;
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
	private markdownView: MarkdownView | null = null;
	private activeFile: TFile | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private dirty = false;
	private saving = false;
	private applyingExternalChange = false;
	private renderQueued = false;
	private explorer: FileExplorer | null = null;
	private backlinks: BacklinksPane | null = null;
	/** The tabs of the main area; the current one shows in the note view (see tabs.ts). */
	private tabBar: TabBar | null = null;
	/** Closed tabs and where they were, most recent last, for "Reopen closed tab". */
	private readonly closedTabs: { tab: Tab; index: number }[] = [];
	private tabClock = 0;
	/** Increases each time a tab starts to show, so a slower earlier one gives up. */
	private showing = 0;
	/** The save in progress, if any: a note is read again only after it. */
	private pendingSave: Promise<void> = Promise.resolve();
	private readonly noHistory = { back: [] as TFile[], forward: [] as TFile[] };
	private navigating = false;
	private navButtons: { back: HTMLElement; forward: HTMLElement } | null = null;
	private lastHandledShortcut = -Infinity;
	private readonly editor: MarkdownEditor;
	private readonly el = {
		emptyState: $('empty-state'),
		workspace: $('workspace'),
		vaultName: $('vault-name'),
		tree: $('file-tree'),
		title: $('file-title') as HTMLInputElement,
		trash: $('trash-file'),
		editor: $('editor'),
		noFile: $('no-file'),
		backlinks: $('backlinks'),
		status: $('status-core'),
	};

	constructor() {
		this.editor = new MarkdownEditor({
			parent: this.el.editor,
			onChange: () => this.onEdit(),
			onOpenLink: (link, newTab) => void this.openLink(link, newTab),
			onOpenUrl: (url) => void this.openExternal(url),
			onHoverLink: (event, linktext, targetEl) => {
				const view = this.markdownView;
				if (!view || !this.app) return;
				this.app.workspace.trigger('hover-link', { event, source: 'editor', hoverParent: view, targetEl, linktext, sourcePath: this.activeFile?.path ?? '' });
			},
			onFiles: (files, pos) => void this.insertAttachments(files, pos),
			livePreview: {
				renderMarkdown: (markdown, el) => this.renderInEditor(markdown, el),
				isResolved: (link) => !this.metadataCache || Boolean(this.metadataCache.getFirstLinkpathDest(getLinkpath(link), this.activeFile?.path ?? '')),
			},
		});
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
		this.el.trash.addEventListener('click', () => void (this.activeFile && this.trash(this.activeFile)));
		this.el.title.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') this.el.title.blur();
			if (e.key === 'Escape') {
				this.el.title.value = this.activeFile?.basename ?? '';
				this.el.title.blur();
			}
		});
		this.el.title.addEventListener('change', () => void this.renameActiveFile(this.el.title.value));
		// Once a vault is open, shortcuts are commands (see registerCommands); before that, only this one.
		window.addEventListener('keydown', (e) => {
			if (!this.app && (e.metaKey || e.ctrlKey) && !e.altKey && e.key === 'o') {
				e.preventDefault();
				void this.pickVault();
			}
		});
		this.followSystemTheme();
		this.remote = new RemoteVaults({
			attach: (backend, snapshot, options) => this.attach(backend, snapshot, options),
			applyUpdate: (update) => this.vault?.applyUpdate(update),
			showEmptyState: () => this.showEmptyState(),
			notice: (message) => this.notice(message),
			openLocal: (path) => this.open(path),
		});
		// The local vault's watcher; a remote vault's changes come through RemoteVaults.
		void listen<VaultUpdate>('vault-changed', (event) => {
			if (this.backend instanceof TauriBackend) this.vault?.applyUpdate(event.payload);
		});
		void getCurrentWindow().onCloseRequested(() => this.flush());
		// The native menu (src-tauri/src/menu.rs) and quitting.
		void listen<string>('menu-command', (event) => this.runMenuCommand(event.payload));
		void listen('quit-requested', async () => {
			await this.flush().catch((err: unknown) => console.error(err));
			await invoke('quit_app');
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

	private get tab(): Tab | null {
		return this.tabBar?.active ?? null;
	}

	/** Notes visited before and after the open one in the current tab (back/forward). */
	private get history(): Tab['history'] {
		return this.tab?.history ?? this.noHistory;
	}

	private get metadataCache(): MetadataCache | null {
		return this.app?.metadataCache ?? null;
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
			activeFile: () => this.tab?.file ?? null,
			openFile: (file, newTab) => this.openFile(file, { newTab }),
			flush: () => this.flush(),
			newNote: (folder) => this.newNote(folder),
			newFolder: (folder) => this.newFolder(folder),
			trash: (file) => this.trash(file),
			reveal: local ? (file) => invoke('reveal_path', { path: file.path }) : undefined,
			notice: (message) => this.notice(message),
		});
		this.backlinks = new BacklinksPane(app, this.el.backlinks, {
			activeFile: () => this.activeFile,
			openFileAt: (file, select) => this.openFileAt(file, select),
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
		if (local) void listen<string>('config-changed', (event) => app.customCss.onConfigFileChanged(event.payload));
		this.activeFile = null;
		this.mountWorkspace(app);
		this.applyEditorSettings();
		vault.on('config-changed', (key: string) => this.onConfigChanged(key));
		this.registerCommands(app);
		await app.internalPlugins.load(app);
		if (local) void setupSyncStatus(app, { notice: (message) => this.notice(message), reconnect: () => this.remote.showDialog() });
		registerCoreViews(app, {
			search: backend.search ? (query, options) => backend.search!(query, options) : undefined,
			openFile: (file, select) => this.openFileAt(file, select),
			openSearch: (query) => revealSearch(app, query),
		});

		for (const name of ['create', 'delete', 'rename']) vault.on(name, () => this.queueTreeRender());
		vault.on('rename', (file: TAbstractFile) => {
			if (!this.tabBar?.tabs.some((tab) => tab.file && isInside(tab.file, file))) return;
			this.tabBar.render();
			this.renderHeader();
			this.saveTabs();
		});
		vault.on('delete', (file: TAbstractFile) => this.onDeleted(file));
		vault.on('modify', (file: TFile) => {
			if (file === this.activeFile) void this.reloadIfChangedOnDisk(file);
		});
		metadataCache.on('resolved', () => this.renderSidePanels());

		this.el.vaultName.textContent = snapshot.name;
		this.el.emptyState.hidden = true;
		this.el.workspace.hidden = false;
		this.renderTree();
		this.restoreSidebars(app);
		this.restoreTabs(app, keep);
		const daily = app.internalPlugins.getEnabledPluginById('daily-notes');
		if (daily instanceof DailyNotes && daily.options.autorun === true && !keep) await daily.openDay(moment());
		else await this.showTab(this.tab!);

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

	/** Puts the workspace pieces (ribbon, side docks, root leaf with the note editor) into the page. */
	private mountWorkspace(app: App): void {
		const ws = app.workspace;
		const ribbon = ws.leftRibbon.containerEl;
		$('ribbon').replaceChildren(ribbon);
		const settings = ribbon.createDiv('side-dock-settings').createDiv({ cls: 'clickable-icon side-dock-ribbon-action', attr: { 'aria-label': 'Settings' } });
		setIcon(settings, 'settings');
		setTooltip(settings, 'Settings', { placement: 'right' });
		settings.addEventListener('click', () => app.setting.open());

		$('left-split').append(ws.leftSplit.containerEl);
		ws.leftSplit.addStaticTab('file-explorer', 'Files', 'folder-closed', $('file-explorer'));
		$('right-split').append(ws.rightSplit.containerEl);
		ws.rightSplit.addStaticTab('backlinks', 'Backlinks', 'links-coming-in', $('backlinks-pane'));

		const view = new MarkdownView(ws.rootLeaf);
		view.editor = new CodeMirrorEditor(this.editor.view);
		view.titleEl.replaceWith(this.el.title);
		// Reading view toggle, like the book/pencil button in Obsidian's note header.
		const modeButton = view.addAction('book-open', 'Reading view (⌘E)', () => void this.toggleReading());
		view.onModeChange = (mode) => {
			setIcon(modeButton, mode === 'preview' ? 'pencil' : 'book-open');
			modeButton.setAttribute('aria-label', mode === 'preview' ? 'Edit (⌘E)' : 'Reading view (⌘E)');
			const tab = this.tab;
			if (tab && ws.rootLeaf.view === view && tab.file === this.activeFile && tab.mode !== mode) {
				tab.mode = mode;
				this.saveTabs();
			}
		};
		const navButton = (icon: string, label: string, direction: -1 | 1) => {
			const el = view.navButtonsEl.createEl('button', { cls: 'clickable-icon view-header-nav-button is-disabled', attr: { 'aria-label': label } });
			setIcon(el, icon);
			setTooltip(el, label);
			el.addEventListener('click', () => void this.navigate(direction));
			return el;
		};
		this.navButtons = { back: navButton('arrow-left', 'Navigate back (⌥⌘←)', -1), forward: navButton('arrow-right', 'Navigate forward (⌥⌘→)', 1) };
		// The mouse's back and forward buttons.
		view.containerEl.addEventListener('mouseup', (event) => {
			if (event.button === 3 || event.button === 4) void this.navigate(event.button === 3 ? -1 : 1);
		});
		view.onLivePreviewChange = (on) => this.editor.setLivePreview(on, [setLivePreviewEffect.of(on)]);
		view.livePreview = app.vault.getConfig('livePreview') !== false;
		this.editor.setLivePreview(view.livePreview, [setLivePreviewEffect.of(view.livePreview)]);
		view.actionsEl.append(this.el.trash);
		view.contentEl.append(this.el.editor, this.el.noFile);
		this.markdownView = view;
		// The root split as themes expect it: `.workspace-tabs.mod-top > .workspace-tab-header-container + .workspace-tab-container > .workspace-leaf`.
		this.tabBar = new TabBar({
			activate: (tab) => this.activateTab(tab),
			close: (tab) => this.closeTab(tab),
			newTab: () => this.newTab(),
		});
		const tabsEl = ws.rootSplit.containerEl.createDiv('workspace-tabs mod-top mod-active');
		tabsEl.append(this.tabBar.containerEl);
		tabsEl.createDiv('workspace-tab-container').append(ws.rootLeaf.containerEl);
		ws.rootSplit.onLeafUpdated = () => this.syncTabWithLeaf();
		$('root-split').replaceWith(ws.rootSplit.containerEl);

		const host: WorkspaceHost = {
			openFile: (file) => this.openFile(file),
			openInTab: (file) => this.openFile(file),
			newTab: () => void this.newTab(),
			closeTab: () => this.tab && this.closeTab(this.tab),
			save: () => this.flush(),
			setEditorExtensions: (extensions: Extension[]) =>
				this.editor.setExtensions([editorInfoExtensions(view, () => this.editor.view, () => this.editor.isLivePreview()), ...extensions]),
		};
		ws.setHost(host, view);
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
				if (!checking) void this.toggleReading();
				return true;
			},
		});
		add({ id: 'app:go-back', name: 'Navigate back', hotkeys: [{ modifiers: ['Mod', 'Alt'], key: 'ArrowLeft' }], callback: () => this.navigate(-1) });
		add({ id: 'app:go-forward', name: 'Navigate forward', hotkeys: [{ modifiers: ['Mod', 'Alt'], key: 'ArrowRight' }], callback: () => this.navigate(1) });
		add({ id: 'workspace:new-tab', name: 'New tab', hotkeys: [{ modifiers: ['Mod'], key: 'T' }], callback: () => void this.newTab() });
		add({
			id: 'workspace:close',
			name: 'Close current tab',
			hotkeys: [{ modifiers: ['Mod'], key: 'W' }],
			checkCallback: (checking) => {
				const tab = this.tab;
				// The only tab, already empty: nothing to close.
				if (!tab || (isEmptyTab(tab) && this.tabBar!.tabs.length === 1)) return false;
				if (!checking) this.closeTab(tab);
				return true;
			},
		});
		add({
			id: 'workspace:close-others',
			name: 'Close all other tabs',
			checkCallback: (checking) => {
				const tab = this.tab;
				if (!tab || this.tabBar!.tabs.length < 2) return false;
				if (!checking) for (const other of [...this.tabBar!.tabs]) if (other !== tab) this.closeTab(other);
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
					const bar = this.tabBar;
					if (!bar?.active || bar.tabs.length < 2) return false;
					if (!checking) this.activateTab(bar.neighbour(bar.active, direction));
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
					const tab = this.tabBar?.tabs[n - 1];
					if (!tab) return false;
					if (!checking) this.activateTab(tab);
					return true;
				},
			});
		}
		add({
			id: 'workspace:goto-last-tab',
			name: 'Go to last tab',
			hotkeys: [{ modifiers: ['Mod'], key: '9' }],
			checkCallback: (checking) => {
				const tab = this.tabBar?.tabs.at(-1);
				if (!tab) return false;
				if (!checking) this.activateTab(tab);
				return true;
			},
		});
		add({
			id: 'editor:toggle-source',
			name: 'Toggle Live Preview/Source mode',
			checkCallback: (checking) => {
				const view = this.markdownView;
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

	/**
	 * Saves pasted or dropped files as attachments (where the vault's settings
	 * say) and inserts embeds for them, like Obsidian: "Pasted image <time>.png".
	 */
	private async insertAttachments(files: File[], pos: number): Promise<void> {
		const app = this.app;
		const note = this.activeFile;
		if (!app || !note) return;
		const embeds: string[] = [];
		for (const file of files) {
			const dot = file.name.lastIndexOf('.');
			const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : (file.type.split('/')[1] ?? 'bin');
			const generic = !file.name || /^image\.\w+$/i.test(file.name);
			const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
			const base = generic ? `Pasted image ${stamp}` : file.name.slice(0, dot > 0 ? dot : undefined);
			try {
				const path = await app.fileManager.getAvailablePathForAttachment(`${base}.${extension}`, note.path);
				const created = await app.vault.createBinary(path, await file.arrayBuffer());
				embeds.push(`!${app.fileManager.generateMarkdownLink(created, note.path)}`);
			} catch (err) {
				this.notice(`Could not save ${file.name || 'the pasted file'}: ${err}`);
			}
		}
		if (!embeds.length || this.activeFile !== note) return;
		this.editor.view.dispatch({ changes: { from: pos, insert: embeds.join('\n') }, selection: { anchor: pos + embeds.join('\n').length } });
	}

	/** Applies Settings → Editor (app.json) to the editor and the reading view. */
	private applyEditorSettings(): void {
		const vault = this.vault;
		if (!vault) return;
		const get = (key: string) => vault.getConfig(key);
		const readable = get('readableLineLength') !== false;
		this.editor.configure({
			lineNumbers: get('showLineNumber') === true,
			spellcheck: get('spellcheck') === true,
			tabSize: Math.min(8, Math.max(1, Number(get('tabSize')) || 4)),
			useTab: get('useTab') !== false,
			autoPairBrackets: get('autoPairBrackets') !== false,
			readableLineLength: readable,
			vim: get('vimMode') === true,
		});
		this.markdownView?.previewMode.containerEl.toggleClass('is-readable-line-width', readable);
	}

	private onConfigChanged(key: string): void {
		if (['showLineNumber', 'spellcheck', 'tabSize', 'useTab', 'autoPairBrackets', 'readableLineLength', 'vimMode'].includes(key)) this.applyEditorSettings();
		else if (key === 'strictLineBreaks') void this.markdownView?.renderPreview();
		else if (key === 'livePreview') this.markdownView?.setLivePreview(this.vault?.getConfig('livePreview') !== false);
	}

	/** Renders Markdown into a Live Preview widget (embeds, callouts, tables), like the reading view. */
	private renderInEditor(markdown: string, el: HTMLElement): (() => void) | undefined {
		const app = this.app;
		if (!app) return undefined;
		const component = new Component();
		component.load();
		void MarkdownRenderer.render(app, markdown, el, this.activeFile?.path ?? '', component).catch((err: unknown) => console.error(err));
		return () => component.unload();
	}

	/** Opens a web or mail link in the default app. */
	private async openExternal(url: string): Promise<void> {
		try {
			await invoke('open_external', { url });
		} catch (err) {
			this.notice(`Could not open ${url}: ${err}`);
		}
	}

	/** Opens the previous (-1) or next (1) note in the history, skipping deleted ones. */
	private async navigate(direction: -1 | 1): Promise<void> {
		const from = direction < 0 ? this.history.back : this.history.forward;
		const to = direction < 0 ? this.history.forward : this.history.back;
		let target: TFile | undefined;
		while ((target = from.pop()) && !this.vault?.getFileByPath(target.path)) {}
		if (!target) return this.renderNavButtons();
		const current = this.tab?.file;
		if (current && current !== target) to.push(current);
		this.navigating = true;
		try {
			await this.openFile(target);
		} finally {
			this.navigating = false;
		}
	}

	private renderNavButtons(): void {
		const exists = (file: TFile) => Boolean(this.vault?.getFileByPath(file.path));
		this.navButtons?.back.toggleClass('is-disabled', !this.history.back.some(exists));
		this.navButtons?.forward.toggleClass('is-disabled', !this.history.forward.some(exists));
	}

	/** Switches the open note between editing and the reading view (saving first). */
	private async toggleReading(): Promise<void> {
		const view = this.markdownView;
		if (!view || !this.activeFile) return;
		await this.flush();
		await view.setMode(view.getMode() === 'preview' ? 'source' : 'preview');
	}

	/** Opens a file; for notes, `select` is a UTF-16 range to select and scroll to. */
	private async openFileAt(file: TFile, select?: { from: number; to: number }): Promise<void> {
		await this.openFile(file);
		const editor = this.markdownView?.editor;
		if (!select || file !== this.activeFile || !editor) return;
		const from = editor.offsetToPos(select.from);
		const to = editor.offsetToPos(select.to);
		editor.setSelection(from, to);
		editor.scrollIntoView({ from, to }, true);
		editor.focus();
	}

	/** Opens a file in the current tab, or in a new one. */
	private async openFile(file: TFile, options: { newTab?: boolean } = {}): Promise<void> {
		const app = this.app;
		const view = this.markdownView;
		if (!app || !view || !this.tabBar) return;
		const type = file.extension === 'md' ? 'markdown' : app.viewRegistry.getTypeByExtension(file.extension);
		if (!type) {
			this.notice(`${file.name}: there is no viewer for this kind of file.`);
			return;
		}
		if (options.newTab) this.newTab();
		const tab = this.tab!;
		const shown = app.workspace.rootLeaf.view as { file?: unknown };
		// Already open here: keep the cursor and undo history.
		if (tab.file === file && (this.activeFile === file || shown.file === file)) return this.editor.focus();
		if (!this.navigating && tab.file && tab.file !== file) {
			tab.history.back.push(tab.file);
			if (tab.history.back.length > HISTORY_LIMIT) tab.history.back.shift();
			tab.history.forward = [];
		}
		void this.flush();
		tab.file = file;
		tab.state = null;
		tab.scroll = 0;
		tab.viewState = type === 'markdown' ? null : { type, state: { file: file.path } };
		tab.title = tab.icon = undefined;
		this.tabBar.render();
		this.saveTabs();
		await this.showTab(tab);
	}

	/** Makes `tab` current: keeps the state of the one being left and shows this one. */
	private activateTab(tab: Tab): void {
		const bar = this.tabBar;
		if (!bar || tab === bar.active || !bar.tabs.includes(tab)) return;
		this.leaveTab();
		this.setActiveTab(tab);
		void this.showTab(tab);
	}

	private setActiveTab(tab: Tab): void {
		const bar = this.tabBar!;
		bar.active = tab;
		tab.lastActive = ++this.tabClock;
		bar.render();
		this.saveTabs();
	}

	/** Before another tab shows: saves the current note and keeps the editor's state (or the view's) with the tab. */
	private leaveTab(): void {
		const tab = this.tab;
		const view = this.markdownView;
		const ws = this.app?.workspace;
		if (!tab || !view || !ws) return;
		// flush() reads the text before its first await, so the editor can change right after.
		void this.flush();
		if (ws.rootLeaf.view === view) {
			if (tab.file && tab.file === this.activeFile) {
				tab.state = this.editor.getState();
				tab.mode = view.getMode();
				tab.scroll = view.currentMode.getScroll();
			}
		} else if (!isEmptyTab(tab)) {
			tab.viewState = ws.rootLeaf.getViewState();
		}
	}

	/** An empty tab after the current one, made current. */
	private newTab(): Tab {
		const bar = this.tabBar!;
		this.leaveTab();
		const tab = emptyTab(this.defaultMode());
		bar.tabs.splice(bar.active ? bar.tabs.indexOf(bar.active) + 1 : bar.tabs.length, 0, tab);
		this.setActiveTab(tab);
		// Synchronous, so a plugin can put its own view in the leaf right after `getLeaf(true)`.
		this.showEmptyTab();
		return tab;
	}

	/** Closes a tab; closing the current one goes back to the tab used most recently, or an empty tab. */
	private closeTab(tab: Tab): void {
		const bar = this.tabBar;
		const i = bar ? bar.tabs.indexOf(tab) : -1;
		if (!bar || i === -1) return;
		const current = tab === bar.active;
		if (current) this.leaveTab();
		if (!isEmptyTab(tab)) {
			this.closedTabs.push({ tab, index: i });
			if (this.closedTabs.length > CLOSED_TABS_LIMIT) this.closedTabs.shift();
		}
		bar.tabs.splice(i, 1);
		if (!current) {
			bar.render();
			this.saveTabs();
			return;
		}
		const next = bar.tabs.reduce<Tab | null>((best, t) => (!best || t.lastActive > best.lastActive ? t : best), null);
		if (next) {
			this.setActiveTab(next);
			void this.showTab(next);
		} else {
			const empty = emptyTab(this.defaultMode());
			bar.tabs.push(empty);
			this.setActiveTab(empty);
			this.showEmptyTab();
		}
	}

	/** Reopens the last closed tab where it was (its note, history and editor state), unless its file is gone. */
	private reopenClosedTab(): void {
		const bar = this.tabBar;
		if (!bar) return;
		let closed: { tab: Tab; index: number } | undefined;
		while ((closed = this.closedTabs.pop()) && closed.tab.file && !this.vault?.getFileByPath(closed.tab.file.path)) {}
		if (!closed) return;
		const current = bar.active;
		this.leaveTab();
		// An empty tab gives its place to the reopened one.
		if (current && isEmptyTab(current) && !current.history.back.length) bar.tabs.splice(bar.tabs.indexOf(current), 1);
		bar.tabs.splice(Math.min(closed.index, bar.tabs.length), 0, closed.tab);
		this.setActiveTab(closed.tab);
		void this.showTab(closed.tab);
	}

	/** Tabs showing a deleted file become empty. */
	private onDeleted(file: TAbstractFile): void {
		const bar = this.tabBar;
		if (!bar) return;
		let changed = false;
		for (const tab of bar.tabs) {
			if (!tab.file || !isInside(tab.file, file)) continue;
			changed = true;
			tab.file = null;
			tab.state = null;
			tab.viewState = null;
			if (tab === bar.active) this.showEmptyTab();
		}
		if (!changed) return;
		bar.render();
		this.saveTabs();
	}

	/** Shows a tab in the root leaf: its note in the editor (restoring its state), another view, or nothing. */
	private async showTab(tab: Tab): Promise<void> {
		const app = this.app;
		const view = this.markdownView;
		if (!app || !view) return;
		if (isEmptyTab(tab)) return this.showEmptyTab();
		const ws = app.workspace;
		const seq = ++this.showing;
		const current = () => seq === this.showing && this.tab === tab;
		// A save of this note may be in flight (the tab was left a moment ago).
		await this.pendingSave;
		if (!current()) return;
		const file = tab.file;
		let viewState = tab.viewState;
		if (!viewState && file && file.extension !== 'md') {
			const type = app.viewRegistry.getTypeByExtension(file.extension);
			if (type) viewState = tab.viewState = { type, state: { file: file.path } };
		}
		if (viewState || !file || file.extension !== 'md') {
			this.clearNote();
			if (viewState) await ws.rootLeaf.setViewState(viewState);
			else this.notice(`${file?.name ?? 'This tab'}: there is no viewer for this kind of file.`);
			if (current()) this.afterShow(tab.file);
			return;
		}
		const text = await app.vault.read(file);
		if (!current()) return;
		if (ws.rootLeaf.view !== view) await ws.rootLeaf.open(view);
		if (!current()) return;
		this.activeFile = file;
		view.file = file;
		view.data = text;
		const state = tab.state;
		tab.state = null;
		if (state) {
			this.editor.restoreState(state, [setLivePreviewEffect.of(view.livePreview)]);
			// Changed on disk while the tab was in the background: show the new text, keeping undo.
			if (state.doc.toString() !== text) this.applyExternalText(text);
		} else {
			this.editor.setValue(text);
		}
		this.el.editor.hidden = false;
		this.el.noFile.hidden = true;
		if (view.getMode() !== tab.mode) await view.setMode(tab.mode);
		else await view.renderPreview();
		if (!current()) return;
		const scroll = tab.scroll;
		if (scroll) requestAnimationFrame(() => current() && view.currentMode.applyScroll(scroll));
		if (tab.mode === 'source') this.editor.focus();
		this.afterShow(file);
	}

	/** An empty tab: the note view with nothing open ("No file is open"). */
	private showEmptyTab(): void {
		const ws = this.app?.workspace;
		const view = this.markdownView;
		if (!ws || !view) return;
		++this.showing;
		this.clearNote();
		if (ws.rootLeaf.view !== view) void ws.rootLeaf.open(view);
		this.el.editor.hidden = true;
		this.el.noFile.hidden = false;
		this.afterShow(null);
	}

	/** Empties the note editor (its edits were saved when the tab was left). */
	private clearNote(): void {
		clearTimeout(this.saveTimer);
		this.dirty = false;
		this.activeFile = null;
		if (this.markdownView) this.markdownView.file = null;
		this.editor.setValue('');
	}

	private afterShow(file: TFile | null): void {
		const app = this.app!;
		this.renderHeader();
		this.explorer?.setActive(file);
		this.renderSidePanels();
		this.renderNavButtons();
		this.tabBar?.render();
		if (file) {
			app.workspace.recordOpenFile(file);
			app.saveLocalStorage(LAST_FILE_KEY, file.path);
		}
		app.workspace.trigger('file-open', file);
	}

	/** A plugin (or a view) changed what the root leaf shows: the current tab follows. */
	private syncTabWithLeaf(): void {
		const tab = this.tab;
		const shown = this.app?.workspace.rootLeaf.view;
		if (!tab || !shown || shown === this.markdownView) return;
		const file = (shown as { file?: unknown }).file;
		if (this.activeFile) {
			void this.flush();
			this.clearNote();
		}
		tab.file = file instanceof TFile ? file : null;
		tab.title = shown.getDisplayText();
		tab.icon = shown.getIcon();
		if (!tab.viewState || tab.viewState.type !== shown.getViewType()) tab.viewState = { type: shown.getViewType() };
		this.tabBar!.render();
		this.saveTabs();
	}

	private defaultMode(): MarkdownViewModeType {
		return this.vault?.getConfig('defaultViewMode') === 'preview' ? 'preview' : 'source';
	}

	/** Remembers the open tabs (per vault) for the next start. */
	private saveTabs(): void {
		const bar = this.tabBar;
		if (!bar || !this.app) return;
		this.app.saveLocalStorage(TABS_KEY, {
			tabs: bar.tabs.map((tab) => ({ file: tab.file?.path ?? null, mode: tab.mode })),
			active: bar.active ? bar.tabs.indexOf(bar.active) : 0,
		});
	}

	/**
	 * The tabs open when the app last closed (only the current one is loaded
	 * now); else one tab with the last note, or the most recently edited one.
	 * `keep` is a note to show after a reload.
	 */
	private restoreTabs(app: App, keep: string | null): void {
		const bar = this.tabBar!;
		const vault = app.vault;
		const saved = app.loadLocalStorage(TABS_KEY) as { tabs?: unknown; active?: unknown } | null;
		let active: Tab | null = null;
		const entries: unknown[] = Array.isArray(saved?.tabs) ? saved.tabs : [];
		for (const [i, entry] of entries.entries()) {
			const { file: path, mode } = (entry ?? {}) as { file?: unknown; mode?: unknown };
			const file = typeof path === 'string' ? vault.getFileByPath(path) : null;
			// A note deleted or renamed outside the app since: its tab goes.
			if (typeof path === 'string' && !file) continue;
			const tab = emptyTab(mode === 'preview' ? 'preview' : 'source');
			tab.file = file;
			bar.tabs.push(tab);
			if (i === saved?.active) active = tab;
		}
		const kept = keep ? vault.getFileByPath(keep) : null;
		if (kept) active = bar.tabs.find((tab) => tab.file === kept) ?? null;
		if (!bar.tabs.length || (kept && !active)) {
			const last = app.loadLocalStorage(LAST_FILE_KEY);
			const tab = emptyTab(this.defaultMode());
			tab.file =
				kept ||
				(typeof last === 'string' && vault.getFileByPath(last)) ||
				vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime)[0] ||
				null;
			bar.tabs.push(tab);
			active = tab;
		}
		this.setActiveTab(active ?? bar.tabs[0]!);
	}

	private async openLink(linktext: string, newTab = false): Promise<void> {
		if (!this.vault || !this.metadataCache) return;
		const linkpath = getLinkpath(linktext);
		if (!linkpath) return;
		let target = this.metadataCache.getFirstLinkpathDest(linkpath, this.activeFile?.path ?? '');
		if (!target) {
			// Like Obsidian, following a link to a missing note creates it.
			const path = linkpath.toLowerCase().endsWith('.md') ? linkpath : `${linkpath}.md`;
			try {
				target = await this.vault.create(path, '');
			} catch (err) {
				this.notice(`Could not create ${path}: ${err}`);
				return;
			}
		}
		await this.openFile(target, { newTab });
	}

	private onEdit(): void {
		if (!this.activeFile || this.applyingExternalChange) return;
		this.dirty = true;
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
		this.renderStatus();
		const view = this.markdownView;
		if (view) this.app?.workspace.trigger('editor-change', view.editor, view);
	}

	/**
	 * Saves pending edits to the active file now. The text is taken before
	 * this returns, so the editor may show another note right after; saves
	 * run one after another (`pendingSave`).
	 */
	private flush(): Promise<void> {
		clearTimeout(this.saveTimer);
		const vault = this.vault;
		const file = this.activeFile;
		if (!this.dirty || !file || !vault) return this.pendingSave;
		const text = this.editor.getValue();
		this.dirty = false;
		this.saving = true;
		this.renderStatus();
		const save = this.pendingSave.then(async () => {
			try {
				await vault.modify(file, text);
				if (this.markdownView?.file === file) this.markdownView.data = text;
			} catch (err) {
				if (file === this.activeFile) this.dirty = true;
				this.notice(`Could not save ${file.path}: ${err}`);
			} finally {
				this.saving = false;
				this.renderStatus();
			}
		});
		this.pendingSave = save;
		return save;
	}

	/** Shows a change made outside the app, unless there are unsaved edits here. */
	private async reloadIfChangedOnDisk(file: TFile): Promise<void> {
		if (!this.vault || this.dirty) return;
		const text = await this.vault.cachedRead(file);
		if (file !== this.activeFile || this.dirty || text === this.editor.getValue()) return;
		this.applyExternalText(text);
		void this.markdownView?.renderPreview();
		this.renderStatus();
	}

	/** Puts text changed outside the app into the editor, keeping undo history and the cursor where possible. */
	private applyExternalText(text: string): void {
		this.applyingExternalChange = true;
		try {
			this.editor.replaceValue(text);
		} finally {
			this.applyingExternalChange = false;
		}
	}

	/** A new note in `folder`, or where the vault's "Default location for new notes" says. */
	private async newNote(folder?: TFolder): Promise<void> {
		const app = this.app;
		if (!app) return;
		const parent = folder ?? app.fileManager.getNewFileParent(this.activeFile?.path ?? '');
		try {
			await this.openFile(await app.vault.create(app.vault.getAvailablePath(joinPath(parent.isRoot() ? '' : parent.path, 'Untitled'), 'md'), ''));
			this.el.title.select();
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

	private async renameActiveFile(newName: string): Promise<void> {
		const file = this.activeFile;
		if (!file || !this.vault) return;
		newName = newName.trim();
		if (!newName || newName === file.basename) {
			this.el.title.value = file.basename;
			return;
		}
		if (/[\\/:]/.test(newName)) {
			this.notice('Note names cannot contain \\ / or :');
			this.el.title.value = file.basename;
			return;
		}
		const folder = file.parent && !file.parent.isRoot() ? file.parent.path + '/' : '';
		try {
			await this.flush();
			await this.app!.fileManager.renameFile(file, `${folder}${newName}.${file.extension}`);
		} catch (err) {
			this.notice(`Could not rename: ${err}`);
			this.el.title.value = file.basename;
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
			if (this.activeFile && isInside(this.activeFile, file)) await this.flush();
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

	private renderHeader(): void {
		const file = this.activeFile;
		this.el.title.value = file?.basename ?? '';
		this.el.title.disabled = !file;
		this.el.trash.hidden = !file;
		const shown = this.tab?.file ?? file;
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
		const file = this.activeFile;
		if (!file || !this.metadataCache) {
			this.el.status.textContent = '';
			return;
		}
		const backlinks = this.metadataCache.getBacklinks(file).length;
		const words = countWords(this.editor.getValue());
		const state = this.saving ? 'Saving…' : this.dirty ? 'Unsaved changes' : 'Saved';
		this.el.status.textContent = `${state} · ${words} words · ${backlinks} backlink${backlinks === 1 ? '' : 's'}`;
	}

	private notice(message: string, duration = 6000): void {
		new Notice(message, duration);
	}
}

void new EmeraldApp().start();
