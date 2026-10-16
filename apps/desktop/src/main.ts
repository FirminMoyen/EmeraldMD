import {
	App,
	CodeMirrorEditor,
	editorInfoExtensions,
	MarkdownView,
	Notice,
	Platform,
	setIcon,
	setRequestBackend,
	setTooltip,
	Vault,
	type WorkspaceHost,
} from '@emeraldmd/api';
import {
	getLinkpath,
	MetadataCache,
	TFile,
	TFolder,
	type TAbstractFile,
	type VaultBackend,
	type VaultSnapshot,
	type VaultUpdate,
} from '@emeraldmd/core';
import { MemoryConfigStore } from '@emeraldmd/api/testing';
import { MarkdownEditor } from '@emeraldmd/editor';
import { CommunityPluginsTab, PluginHost } from '@emeraldmd/plugin-host';
import type { Extension } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask, open as openDialog } from '@tauri-apps/plugin-dialog';
import { CommandPalette } from './command-palette';
import { setupMobile } from './mobile';
import { RemoteVaults } from './remote';
import { TauriBackend, TauriConfigStore, tauriRequestBackend, tauriTrustStore } from './tauri-backend';

/** A note to reopen after the page reloads to switch vaults (see `attach`). */
const REOPEN_FILE_KEY = 'emeraldmd:reopen-file';

/** Same autosave delay as Obsidian. */
const SAVE_DELAY_MS = 2000;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function $(id: string): HTMLElement {
	const el = document.getElementById(id);
	if (!el) throw new Error(`#${id} is missing from index.html`);
	return el;
}

function countWords(text: string): number {
	const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/, '');
	return body.match(/\S+/g)?.length ?? 0;
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
	private readonly collapsed = new Set<string>();
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
			onOpenLink: (link) => void this.openLink(link),
		});
		$('open-vault').addEventListener('click', () => void this.pickVault());
		$('switch-vault').addEventListener('click', () => void this.pickVault());
		$('new-note').addEventListener('click', () => void this.newNote());
		$('new-folder').addEventListener('click', () => void this.newFolder());
		this.el.trash.addEventListener('click', () => void this.trashActiveFile());
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
		setupMobile({ open: (path) => this.open(path), notice: (message) => this.notice(message) });
		this.remote = new RemoteVaults({
			attach: (backend, snapshot, options) => this.attach(backend, snapshot, options),
			applyUpdate: (update) => this.vault?.applyUpdate(update),
			showEmptyState: () => this.showEmptyState(),
			notice: (message) => this.notice(message),
		});
		// The local vault's watcher; a remote vault's changes come through RemoteVaults.
		void listen<VaultUpdate>('vault-changed', (event) => {
			if (this.backend instanceof TauriBackend) this.vault?.applyUpdate(event.payload);
		});
		void getCurrentWindow().onCloseRequested(() => this.flush());
	}

	private get vault(): Vault | null {
		return this.app?.vault ?? null;
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
			document.body.classList.toggle('theme-dark', query.matches);
			document.body.classList.toggle('theme-light', !query.matches);
			this.app?.workspace.trigger('css-change');
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
		// Mobile folder pickers return content URIs, not paths: show the app's own vaults instead.
		if (Platform.isMobile) {
			this.showEmptyState();
			return;
		}
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
		// Remote vaults keep their settings in memory until the server serves `.obsidian`.
		const vault = new Vault(backend, snapshot.name, snapshot.files, local ? new TauriConfigStore() : new MemoryConfigStore());
		await vault.loadConfig();
		const metadataCache = new MetadataCache(vault, snapshot);
		const app = new App({
			vault,
			metadataCache,
			appId: appIdFor(local ? snapshot.basePath : `remote:${snapshot.name}`),
			statusBarEl: $('status-bar'),
			workspaceEl: this.el.workspace,
		});
		this.app = app;
		await app.metadataTypeManager.load();
		this.activeFile = null;
		this.mountWorkspace(app);
		this.registerCommands(app);

		for (const name of ['create', 'delete', 'rename']) vault.on(name, () => this.queueTreeRender());
		vault.on('rename', (file: TAbstractFile) => {
			if (this.activeFile && isInside(this.activeFile, file)) this.renderHeader();
		});
		vault.on('delete', (file: TAbstractFile) => {
			if (this.activeFile && isInside(this.activeFile, file)) this.closeFile();
		});
		vault.on('modify', (file: TFile) => {
			if (file === this.activeFile) void this.reloadIfChangedOnDisk(file);
		});
		metadataCache.on('resolved', () => this.renderSidePanels());

		this.el.vaultName.textContent = snapshot.name;
		this.el.emptyState.hidden = true;
		this.el.workspace.hidden = false;
		this.renderTree();
		const recent = (keep && vault.getFileByPath(keep)) || vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime)[0];
		if (recent) await this.openFile(recent);
		else this.closeFile();

		if (!local) {
			// Community plugins run from the local `.obsidian` folder only, for now.
			app.workspace.setLayoutReady();
			return;
		}
		const host = new PluginHost(app, tauriTrustStore);
		this.host = host;
		app.setting.addBuiltInTab(new CommunityPluginsTab(app, host));
		try {
			await host.initialize();
		} catch (err) {
			this.notice(`Could not load community plugins: ${err}`);
		}
		app.workspace.setLayoutReady();
		if (host.restricted && [...host.enabledPlugins].some((id) => host.manifests[id])) {
			this.notice('This vault uses community plugins. They stay off until you turn them on in Settings → Community plugins.', 10000);
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
		view.actionsEl.append(this.el.trash);
		view.contentEl.append(this.el.editor, this.el.noFile);
		this.markdownView = view;
		$('root-split').replaceWith(ws.rootSplit.containerEl);

		const host: WorkspaceHost = {
			openFile: (file) => this.openFile(file),
			save: () => this.flush(),
			setEditorExtensions: (extensions: Extension[]) =>
				this.editor.setExtensions([editorInfoExtensions(view, () => this.editor.view), ...extensions]),
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
			id: 'app:delete-file',
			name: 'Delete current file',
			checkCallback: (checking) => {
				if (!this.activeFile) return false;
				if (!checking) void this.trashActiveFile();
				return true;
			},
		});
		add({ id: 'app:open-vault', name: 'Open another vault', hotkeys: [{ modifiers: ['Mod'], key: 'O' }], callback: () => this.pickVault() });
		add({ id: 'app:toggle-left-sidebar', name: 'Toggle left sidebar', callback: () => this.toggleSplit($('left-split')) });
		add({ id: 'app:toggle-right-sidebar', name: 'Toggle right sidebar', callback: () => this.toggleSplit($('right-split')) });
		add({ id: 'app:reload', name: 'Reload app without saving', callback: () => window.location.reload() });
	}

	private toggleSplit(el: HTMLElement): void {
		el.toggleClass('is-collapsed', !el.hasClass('is-collapsed'));
		this.app?.workspace.trigger('resize');
	}

	private async openFile(file: TFile): Promise<void> {
		if (!this.vault || !this.app || !this.markdownView) return;
		await this.flush();
		const ws = this.app.workspace;
		if (file.extension !== 'md') {
			const type = this.app.viewRegistry.getTypeByExtension(file.extension);
			if (type) {
				await ws.rootLeaf.setViewState({ type, state: { file: file.path } });
				ws.recordOpenFile(file);
				ws.trigger('file-open', file);
			} else {
				this.notice(`${file.name}: only Markdown notes can be opened for now.`);
			}
			return;
		}
		const text = await this.vault.read(file);
		if (ws.rootLeaf.view !== this.markdownView) await ws.rootLeaf.open(this.markdownView);
		this.activeFile = file;
		this.markdownView.file = file;
		this.markdownView.data = text;
		this.editor.setValue(text);
		this.el.editor.hidden = false;
		this.el.noFile.hidden = true;
		this.renderHeader();
		this.renderTree();
		this.renderSidePanels();
		this.editor.focus();
		ws.recordOpenFile(file);
		ws.trigger('file-open', file);
	}

	private closeFile(): void {
		clearTimeout(this.saveTimer);
		this.dirty = false;
		this.activeFile = null;
		if (this.markdownView) this.markdownView.file = null;
		this.editor.setValue('');
		this.el.editor.hidden = true;
		this.el.noFile.hidden = false;
		this.renderHeader();
		this.renderTree();
		this.renderSidePanels();
		this.app?.workspace.trigger('file-open', null);
	}

	private async openLink(linktext: string): Promise<void> {
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
		await this.openFile(target);
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

	/** Saves pending edits to the active file now. */
	private async flush(): Promise<void> {
		clearTimeout(this.saveTimer);
		if (!this.dirty || !this.activeFile || !this.vault) return;
		const file = this.activeFile;
		this.dirty = false;
		this.saving = true;
		this.renderStatus();
		try {
			const text = this.editor.getValue();
			await this.vault.modify(file, text);
			if (this.markdownView?.file === file) this.markdownView.data = text;
		} catch (err) {
			this.dirty = true;
			this.notice(`Could not save ${file.path}: ${err}`);
		} finally {
			this.saving = false;
			this.renderStatus();
		}
	}

	/** Shows a change made outside the app, unless there are unsaved edits here. */
	private async reloadIfChangedOnDisk(file: TFile): Promise<void> {
		if (!this.vault || this.dirty) return;
		const text = await this.vault.cachedRead(file);
		if (file !== this.activeFile || this.dirty || text === this.editor.getValue()) return;
		this.applyingExternalChange = true;
		try {
			this.editor.replaceValue(text);
		} finally {
			this.applyingExternalChange = false;
		}
		this.renderStatus();
	}

	private async newNote(): Promise<void> {
		if (!this.vault) return;
		try {
			await this.openFile(await this.vault.create(this.vault.getAvailablePath('Untitled', 'md'), ''));
			this.el.title.select();
		} catch (err) {
			this.notice(`Could not create a note: ${err}`);
		}
	}

	private async newFolder(): Promise<void> {
		if (!this.vault) return;
		try {
			await this.vault.createFolder(this.vault.getAvailablePath('Untitled', ''));
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
			await this.vault.rename(file, `${folder}${newName}.${file.extension}`);
		} catch (err) {
			this.notice(`Could not rename: ${err}`);
			this.el.title.value = file.basename;
		}
	}

	private async trashActiveFile(): Promise<void> {
		const file = this.activeFile;
		if (!file || !this.vault) return;
		const ok = await ask(`Move "${file.name}" to the vault's .trash folder?`, { title: 'Move to trash', kind: 'warning' });
		if (!ok) return;
		try {
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
		const vaultName = this.vault?.getName() ?? '';
		void getCurrentWindow().setTitle(file ? `${file.basename} - ${vaultName} - EmeraldMD` : `${vaultName} - EmeraldMD`);
	}

	private renderTree(): void {
		if (!this.vault) return;
		const scroll = this.el.tree.scrollTop;
		this.el.tree.replaceChildren(this.renderChildren(this.vault.getRoot(), 0));
		this.el.tree.scrollTop = scroll;
	}

	private renderChildren(folder: TFolder, depth: number): DocumentFragment {
		const fragment = document.createDocumentFragment();
		const children = [...folder.children].sort((a, b) => {
			const aFolder = a instanceof TFolder;
			if (aFolder !== b instanceof TFolder) return aFolder ? -1 : 1;
			return collator.compare(a.name, b.name);
		});
		for (const child of children) {
			const item = document.createElement('div');
			const title = document.createElement('div');
			title.style.paddingInlineStart = `${8 + depth * 16}px`;
			title.title = child.path;
			if (child instanceof TFolder) {
				const collapsed = this.collapsed.has(child.path);
				item.className = 'tree-item nav-folder' + (collapsed ? ' is-collapsed' : '');
				title.className = 'tree-item-self nav-folder-title';
				title.textContent = child.name;
				title.addEventListener('click', () => {
					if (collapsed) this.collapsed.delete(child.path);
					else this.collapsed.add(child.path);
					this.renderTree();
				});
				item.append(title);
				if (!collapsed) {
					const kids = document.createElement('div');
					kids.className = 'tree-item-children nav-folder-children';
					kids.append(this.renderChildren(child, depth + 1));
					item.append(kids);
				}
			} else if (child instanceof TFile) {
				item.className = 'tree-item nav-file';
				title.className = 'tree-item-self nav-file-title' + (child === this.activeFile ? ' is-active' : '');
				title.textContent = child.extension === 'md' ? child.basename : child.name;
				if (child.extension !== 'md') {
					const tag = document.createElement('span');
					tag.className = 'nav-file-tag';
					tag.textContent = child.extension;
					title.append(tag);
				}
				title.addEventListener('click', () => void this.openFile(child));
				item.append(title);
			}
			fragment.append(item);
		}
		return fragment;
	}

	private renderSidePanels(): void {
		this.renderStatus();
		const list = this.el.backlinks;
		list.replaceChildren();
		const file = this.activeFile;
		if (!file || !this.vault || !this.metadataCache) return;
		const sources = this.metadataCache.getBacklinks(file);
		if (sources.length === 0) {
			list.textContent = 'No backlinks.';
			return;
		}
		for (const path of sources) {
			const source = this.vault.getFileByPath(path);
			if (!source) continue;
			const row = document.createElement('div');
			row.className = 'tree-item-self search-result-file-title';
			row.textContent = source.basename;
			row.title = path;
			row.addEventListener('click', () => void this.openFile(source));
			list.append(row);
		}
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
