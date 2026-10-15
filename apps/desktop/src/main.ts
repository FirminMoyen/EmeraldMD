import {
	getLinkpath,
	openVault,
	TFile,
	TFolder,
	type MetadataCache,
	type TAbstractFile,
	type Vault,
	type VaultBackend,
	type VaultSnapshot,
	type VaultUpdate,
} from '@emeraldmd/core';
import { MarkdownEditor } from '@emeraldmd/editor';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask, open as openDialog } from '@tauri-apps/plugin-dialog';
import { RemoteVaults } from './remote';
import { TauriBackend } from './tauri-backend';

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

class EmeraldApp {
	private vault: Vault | null = null;
	private backend: VaultBackend | null = null;
	private metadataCache: MetadataCache | null = null;
	private activeFile: TFile | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private dirty = false;
	private saving = false;
	private applyingExternalChange = false;
	private renderQueued = false;
	private readonly collapsed = new Set<string>();
	private readonly editor: MarkdownEditor;
	private readonly remote: RemoteVaults;
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
		status: $('status-bar'),
		notices: $('notices'),
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
		window.addEventListener('keydown', (e) => {
			if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
			if (e.key === 'n') {
				e.preventDefault();
				void this.newNote();
			} else if (e.key === 's') {
				e.preventDefault();
				void this.flush();
			} else if (e.key === 'o') {
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
		});
		// The local vault's watcher; a remote vault's changes come through RemoteVaults.
		void listen<VaultUpdate>('vault-changed', (event) => {
			if (this.backend instanceof TauriBackend) this.vault?.applyUpdate(event.payload);
		});
		void getCurrentWindow().onCloseRequested(() => this.flush());
	}

	async start(): Promise<void> {
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

	/** Shows a vault, local or remote. `keepActiveFile`: reopen the same note if it still exists. */
	private async attach(backend: VaultBackend, snapshot: VaultSnapshot, options: { keepActiveFile?: boolean } = {}): Promise<void> {
		await this.flush();
		const keep = options.keepActiveFile ? this.activeFile?.path : undefined;
		this.remote.vaultOpened(backend);
		this.backend = backend;
		const { vault, metadataCache } = openVault(backend, snapshot);
		this.vault = vault;
		this.metadataCache = metadataCache;
		this.activeFile = null;

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
	}

	private async openFile(file: TFile): Promise<void> {
		if (!this.vault) return;
		await this.flush();
		if (file.extension !== 'md') {
			this.notice(`${file.name}: only Markdown notes can be opened for now.`);
			return;
		}
		const text = await this.vault.read(file);
		this.activeFile = file;
		this.editor.setValue(text);
		this.el.editor.hidden = false;
		this.el.noFile.hidden = true;
		this.renderHeader();
		this.renderTree();
		this.renderSidePanels();
		this.editor.focus();
	}

	private closeFile(): void {
		clearTimeout(this.saveTimer);
		this.dirty = false;
		this.activeFile = null;
		this.editor.setValue('');
		this.el.editor.hidden = true;
		this.el.noFile.hidden = false;
		this.renderHeader();
		this.renderTree();
		this.renderSidePanels();
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
			await this.vault.modify(file, this.editor.getValue());
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

	private notice(message: string): void {
		const el = document.createElement('div');
		el.className = 'notice';
		el.textContent = message;
		el.addEventListener('click', () => el.remove());
		this.el.notices.append(el);
		setTimeout(() => el.remove(), 6000);
	}
}

void new EmeraldApp().start();
