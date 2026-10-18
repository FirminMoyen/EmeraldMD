/**
 * The file tree in the left sidebar.
 *
 * DOM as themes and plugins (Iconize, file colour plugins…) expect it:
 * `.nav-folder > .nav-folder-title[data-path] > .nav-folder-collapse-indicator
 * + .nav-folder-title-content`, then `.nav-folder-children`; files are
 * `.nav-file > .nav-file-title[data-path] > .nav-file-title-content
 * (+ .nav-file-tag)`.
 *
 * Right-click opens a context menu, which plugins extend through the
 * `file-menu` workspace event. Items can be renamed in place and dragged onto
 * folders to move them; files dragged in from Finder are copied into the
 * folder they are dropped on; a file dragged into a note inserts a link.
 */

import { FuzzySuggestModal, Keymap, Menu, setIcon, type App } from '@emeraldmd/api';
import { joinPath, TFile, TFolder, type TAbstractFile } from '@emeraldmd/core';

/** Drag data type carrying a vault path. */
export const PATH_TYPE = 'application/x-emeraldmd-path';

export interface FileExplorerHost {
	activeFile(): TFile | null;
	/** Opens a file in the current tab, or a new one (Cmd/Ctrl-click, middle click, "Open in new tab"). */
	openFile(file: TFile, newTab?: boolean): Promise<void>;
	/** Saves pending edits; called before files move. */
	flush(): Promise<void>;
	newNote(folder: TFolder): Promise<void>;
	newFolder(folder: TFolder): Promise<void>;
	/** Moves to the vault's trash, after asking. */
	trash(file: TAbstractFile): Promise<void>;
	/** Shows the item in Finder; absent for remote vaults. */
	reveal?(file: TAbstractFile): Promise<void>;
	notice(message: string): void;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function isInside(file: TAbstractFile, folder: TFolder): boolean {
	for (let p: TFolder | null = file instanceof TFolder ? file : file.parent; p; p = p.parent) if (p === folder) return true;
	return false;
}

/** Local storage key (per vault) for the folders the user opened. */
const EXPANDED_KEY = 'emerald-expanded-folders';

export class FileExplorer {
	/** Folders shown open; the others start closed, so large vaults draw only their top level. */
	readonly expanded: Set<string>;
	private renaming: TAbstractFile | null = null;
	private dragged: TAbstractFile | null = null;
	/** The title element of each drawn file, to move the highlight without redrawing. */
	private readonly titles = new Map<string, HTMLElement>();
	private activeTitle: HTMLElement | null = null;

	constructor(
		private readonly app: App,
		private readonly el: HTMLElement,
		private readonly host: FileExplorerHost,
	) {
		const saved = app.loadLocalStorage(EXPANDED_KEY);
		this.expanded = new Set(Array.isArray(saved) ? saved.filter((p): p is string => typeof p === 'string') : []);
		el.addEventListener('contextmenu', (event) => {
			if (event.target instanceof Element && event.target.closest('.tree-item-self')) return;
			this.showMenu(event, this.app.vault.getRoot());
		});
		this.dropTarget(el, () => this.app.vault.getRoot());
	}

	render(): void {
		const scroll = this.el.scrollTop;
		this.titles.clear();
		this.activeTitle = null;
		this.el.replaceChildren(this.renderChildren(this.app.vault.getRoot(), 0));
		this.el.scrollTop = scroll;
	}

	/** Moves the highlight to the open note without redrawing the tree. */
	setActive(file: TFile | null): void {
		this.activeTitle?.removeClass('is-active');
		this.activeTitle = file ? (this.titles.get(file.path) ?? null) : null;
		this.activeTitle?.addClass('is-active');
	}

	/** Opens the folders above `file` and scrolls it into view. */
	reveal(file: TAbstractFile): void {
		for (let p = file.parent; p && !p.isRoot(); p = p.parent) this.expanded.add(p.path);
		this.saveExpanded();
		this.render();
		this.titles.get(file.path)?.scrollIntoView({ block: 'center' });
	}

	private setExpanded(folder: TFolder, open: boolean): void {
		if (open) this.expanded.add(folder.path);
		else this.expanded.delete(folder.path);
		this.saveExpanded();
	}

	private saveExpanded(): void {
		// Only folders that still exist.
		for (const path of this.expanded) if (!this.app.vault.getFolderByPath(path)) this.expanded.delete(path);
		this.app.saveLocalStorage(EXPANDED_KEY, [...this.expanded]);
	}

	/** Starts renaming an item in place (after a "New folder", say). */
	startRename(file: TAbstractFile): void {
		for (let p = file.parent; p && !p.isRoot(); p = p.parent) this.expanded.add(p.path);
		this.saveExpanded();
		this.renaming = file;
		this.render();
	}

	private renderChildren(folder: TFolder, depth: number): DocumentFragment {
		const fragment = document.createDocumentFragment();
		const children = [...folder.children].sort((a, b) => {
			const aFolder = a instanceof TFolder;
			if (aFolder !== b instanceof TFolder) return aFolder ? -1 : 1;
			return collator.compare(a.name, b.name);
		});
		for (const child of children) fragment.append(child instanceof TFolder ? this.renderFolder(child, depth) : this.renderFile(child as TFile, depth));
		return fragment;
	}

	private renderFolder(folder: TFolder, depth: number): HTMLElement {
		const collapsed = !this.expanded.has(folder.path);
		const item = createDiv({ cls: ['tree-item', 'nav-folder', ...(collapsed ? ['is-collapsed'] : [])] });
		const title = item.createDiv({ cls: 'tree-item-self nav-folder-title is-clickable mod-collapsible', attr: { 'data-path': folder.path, draggable: 'true' } });
		title.style.paddingInlineStart = `${8 + depth * 16}px`;
		const indicator = title.createDiv('tree-item-icon collapse-icon nav-folder-collapse-indicator');
		setIcon(indicator, 'chevron-down');
		const content = title.createDiv({ cls: 'tree-item-inner nav-folder-title-content', text: folder.name });
		title.addEventListener('click', () => {
			if (this.renaming === folder) return;
			this.setExpanded(folder, collapsed);
			this.render();
		});
		this.common(title, content, folder);
		this.dropTarget(item, () => folder);
		if (!collapsed) item.createDiv('tree-item-children nav-folder-children').append(this.renderChildren(folder, depth + 1));
		return item;
	}

	private renderFile(file: TFile, depth: number): HTMLElement {
		const item = createDiv('tree-item nav-file');
		const active = file === this.host.activeFile();
		const title = item.createDiv({
			cls: ['tree-item-self', 'nav-file-title', 'is-clickable', ...(active ? ['is-active'] : [])],
			attr: { 'data-path': file.path, draggable: 'true' },
		});
		title.style.paddingInlineStart = `${8 + depth * 16}px`;
		this.titles.set(file.path, title);
		if (active) this.activeTitle = title;
		const content = title.createDiv({ cls: 'tree-item-inner nav-file-title-content', text: file.extension === 'md' ? file.basename : file.name });
		if (file.extension !== 'md') title.createDiv({ cls: 'nav-file-tag', text: file.extension });
		title.addEventListener('click', (event) => {
			if (this.renaming !== file) void this.host.openFile(file, Boolean(Keymap.isModEvent(event)));
		});
		title.addEventListener('auxclick', (event) => {
			if (event.button === 1 && this.renaming !== file) void this.host.openFile(file, true);
		});
		this.common(title, content, file);
		// Dropping on a file drops into its folder.
		if (file.parent) this.dropTarget(item, () => file.parent!);
		return item;
	}

	/** Context menu, drag start and in-place rename, for files and folders. */
	private common(title: HTMLElement, content: HTMLElement, file: TAbstractFile): void {
		title.title = file.path;
		title.addEventListener('contextmenu', (event) => {
			event.stopPropagation();
			this.showMenu(event, file);
		});
		title.addEventListener('dragstart', (event) => {
			const transfer = event.dataTransfer;
			if (!transfer) return;
			this.dragged = file;
			transfer.effectAllowed = 'copyMove';
			transfer.setData(PATH_TYPE, file.path);
			// Dropped into a note, a file becomes a link to it.
			if (file instanceof TFile) transfer.setData('text/plain', this.app.fileManager.generateMarkdownLink(file, this.host.activeFile()?.path ?? ''));
			title.addClass('is-being-dragged');
		});
		title.addEventListener('dragend', () => {
			this.dragged = null;
			title.removeClass('is-being-dragged');
			for (const el of this.el.querySelectorAll('.is-being-dragged-over')) el.removeClass('is-being-dragged-over');
		});
		if (this.renaming === file) this.editName(content, file);
	}

	private showMenu(event: MouseEvent, file: TAbstractFile): void {
		event.preventDefault();
		const menu = new Menu();
		const folder = file instanceof TFolder ? file : null;
		if (folder) {
			menu.addItem((item) => item.setTitle('New note').setIcon('square-pen').setSection('new').onClick(() => void this.host.newNote(folder)));
			menu.addItem((item) => item.setTitle('New folder').setIcon('folder-plus').setSection('new').onClick(() => void this.host.newFolder(folder)));
		}
		if (file instanceof TFile) {
			menu.addItem((item) => item.setTitle('Open in new tab').setIcon('file-plus').setSection('open').onClick(() => void this.host.openFile(file, true)));
		}
		if (!(folder?.isRoot() ?? false)) {
			menu.addItem((item) => item.setTitle('Rename…').setIcon('pencil').setSection('action').onClick(() => this.startRename(file)));
			menu.addItem((item) =>
				item
					.setTitle('Move to…')
					.setIcon('folder-input')
					.setSection('action')
					.onClick(() => new FolderPicker(this.app, file, (target) => void this.move(file, target)).open()),
			);
		}
		menu.addItem((item) =>
			item
				.setTitle('Copy path')
				.setIcon('copy')
				.setSection('info')
				.onClick(() => void navigator.clipboard.writeText(folder?.isRoot() ? '/' : file.path).catch((err: unknown) => this.host.notice(`Could not copy: ${err}`))),
		);
		const reveal = this.host.reveal;
		if (reveal) menu.addItem((item) => item.setTitle('Reveal in Finder').setIcon('folder-open').setSection('info').onClick(() => void reveal(file)));
		if (!(folder?.isRoot() ?? false)) {
			menu.addItem((item) => item.setTitle('Delete').setIcon('trash-2').setSection('danger').setWarning(true).onClick(() => void this.host.trash(file)));
		}
		this.app.workspace.trigger('file-menu', menu, file, 'file-explorer-context-menu', this.app.workspace.getLeavesOfType('file-explorer')[0]);
		menu.showAtMouseEvent(event);
	}

	/** Makes `el` accept dragged tree items (moved into the folder) and files from Finder (copied in). */
	private dropTarget(el: HTMLElement, folder: () => TFolder): void {
		const accepts = (event: DragEvent): boolean => {
			const types = event.dataTransfer?.types ?? [];
			if (types.includes('Files')) return true;
			return types.includes(PATH_TYPE) && this.dragged !== null && this.canMove(this.dragged, folder());
		};
		el.addEventListener('dragover', (event) => {
			if (!accepts(event)) return;
			event.preventDefault();
			event.stopPropagation();
			event.dataTransfer!.dropEffect = event.dataTransfer!.types.includes('Files') ? 'copy' : 'move';
			for (const other of this.el.querySelectorAll('.is-being-dragged-over')) if (other !== el) other.removeClass('is-being-dragged-over');
			el.addClass('is-being-dragged-over');
		});
		el.addEventListener('dragleave', (event) => {
			if (!(event.relatedTarget instanceof Node && el.contains(event.relatedTarget))) el.removeClass('is-being-dragged-over');
		});
		el.addEventListener('drop', (event) => {
			el.removeClass('is-being-dragged-over');
			if (!accepts(event)) return;
			event.preventDefault();
			event.stopPropagation();
			const target = folder();
			const files = [...(event.dataTransfer?.files ?? [])];
			if (files.length) void this.importFiles(files, target);
			else if (this.dragged) void this.move(this.dragged, target);
		});
	}

	private canMove(file: TAbstractFile, folder: TFolder): boolean {
		if (file.parent === folder) return false;
		return !(file instanceof TFolder && isInside(folder, file));
	}

	private async move(file: TAbstractFile, folder: TFolder): Promise<void> {
		if (!this.canMove(file, folder)) return;
		const path = joinPath(folder.isRoot() ? '' : folder.path, file.name);
		if (this.app.vault.getAbstractFileByPath(path)) {
			this.host.notice(`${folder.isRoot() ? 'The vault' : folder.name} already has an item named ${file.name}.`);
			return;
		}
		try {
			await this.host.flush();
			this.setExpanded(folder, true);
			await this.app.fileManager.renameFile(file, path);
		} catch (err) {
			this.host.notice(`Could not move ${file.name}: ${err}`);
		}
	}

	private async importFiles(files: File[], folder: TFolder): Promise<void> {
		for (const file of files) {
			const dot = file.name.lastIndexOf('.');
			const base = joinPath(folder.isRoot() ? '' : folder.path, dot > 0 ? file.name.slice(0, dot) : file.name);
			const path = this.app.vault.getAvailablePath(base, dot > 0 ? file.name.slice(dot + 1) : '');
			try {
				await this.app.vault.createBinary(path, await file.arrayBuffer());
			} catch (err) {
				this.host.notice(`Could not copy ${file.name}: ${err}`);
			}
		}
	}

	/** Turns the title into an editable field; Enter saves, Escape cancels. */
	private editName(content: HTMLElement, file: TAbstractFile): void {
		const isNote = file instanceof TFile && file.extension === 'md';
		const original = isNote ? (file as TFile).basename : file.name;
		content.contentEditable = 'plaintext-only';
		content.addClass('is-being-renamed');
		let done = false;
		const finish = (save: boolean) => {
			if (done) return;
			done = true;
			this.renaming = null;
			const name = (content.textContent ?? '').trim();
			if (save && name && name !== original) void this.rename(file, isNote ? `${name}.md` : name);
			else this.render();
		};
		content.addEventListener('keydown', (event) => {
			event.stopPropagation();
			if (event.key === 'Enter') {
				event.preventDefault();
				finish(true);
			} else if (event.key === 'Escape') {
				event.preventDefault();
				finish(false);
			}
		});
		content.addEventListener('blur', () => finish(true));
		requestAnimationFrame(() => {
			content.focus();
			const selection = window.getSelection();
			const range = document.createRange();
			range.selectNodeContents(content);
			selection?.removeAllRanges();
			selection?.addRange(range);
		});
	}

	private async rename(file: TAbstractFile, name: string): Promise<void> {
		if (/[\\/:]/.test(name)) {
			this.host.notice('Names cannot contain \\ / or :');
			this.render();
			return;
		}
		const path = joinPath(file.parent && !file.parent.isRoot() ? file.parent.path : '', name);
		if (this.app.vault.getAbstractFileByPath(path)) {
			this.host.notice(`${name} already exists.`);
			this.render();
			return;
		}
		try {
			await this.host.flush();
			await this.app.fileManager.renameFile(file, path);
		} catch (err) {
			this.host.notice(`Could not rename ${file.name}: ${err}`);
			this.render();
		}
	}
}

/** "Move to…": pick a folder by name. */
class FolderPicker extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private readonly file: TAbstractFile,
		private readonly choose: (folder: TFolder) => void,
	) {
		super(app);
		this.setPlaceholder(`Move ${file.name} to…`);
	}

	getItems(): TFolder[] {
		return this.app.vault
			.getAllFolders(true)
			.filter((folder) => folder !== this.file.parent && !(this.file instanceof TFolder && isInside(folder, this.file)))
			.sort((a, b) => collator.compare(a.path, b.path));
	}

	getItemText(folder: TFolder): string {
		return folder.isRoot() ? '/' : folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.choose(folder);
	}
}
