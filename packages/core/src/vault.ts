/**
 * In-memory mirror of the vault's file tree, with the same shape as the plugin
 * API's `Vault`, `TFile` and `TFolder`. The Rust core owns the files; every
 * operation goes through the backend and the returned `VaultUpdate` is applied
 * here. External changes arrive as updates too (see `applyUpdate`).
 *
 * Events: `create`, `modify`, `delete`, `rename` (file, oldPath), like the
 * plugin API, plus the internal `emerald:update` (raw update) for
 * MetadataCache.
 */

import { Events } from './events';
import { fileName, normalizePath, parentPath, splitExtension } from './path';
import type { FileEntry, VaultBackend, VaultUpdate } from './types';

export interface FileStats {
	ctime: number;
	mtime: number;
	size: number;
}

export abstract class TAbstractFile {
	vault: Vault;
	path: string;
	name: string;
	parent: TFolder | null = null;

	constructor(vault: Vault, path: string) {
		this.vault = vault;
		this.path = path;
		this.name = path === '/' ? '' : fileName(path);
	}

	/** @internal */
	setPath(path: string): void {
		this.path = path;
		this.name = fileName(path);
	}
}

export class TFile extends TAbstractFile {
	stat: FileStats;
	basename = '';
	extension = '';

	constructor(vault: Vault, path: string, stat: FileStats) {
		super(vault, path);
		this.stat = stat;
		this.updateNames();
	}

	override setPath(path: string): void {
		super.setPath(path);
		this.updateNames();
	}

	private updateNames(): void {
		({ basename: this.basename, extension: this.extension } = splitExtension(this.name));
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];

	isRoot(): boolean {
		return this.path === '/';
	}
}

/** Content just written by this client, so it can be cached instead of re-read. */
interface Written {
	path: string;
	data: string;
}

function statOf(entry: FileEntry): FileStats {
	return { ctime: entry.ctime, mtime: entry.mtime, size: entry.size };
}

export class Vault extends Events {
	readonly configDir = '.obsidian';
	/** Bumped whenever a path appears, disappears or moves. */
	structureVersion = 0;

	private readonly backend: VaultBackend;
	private readonly name: string;
	private readonly root: TFolder;
	private readonly fileMap = new Map<string, TAbstractFile>();
	private readonly contentCache = new Map<string, string>();

	constructor(backend: VaultBackend, name: string, files: FileEntry[]) {
		super();
		this.backend = backend;
		this.name = name;
		this.root = new TFolder(this, '/');
		this.fileMap.set('/', this.root);
		for (const entry of files) this.add(entry, false);
	}

	getName(): string {
		return this.name;
	}

	getRoot(): TFolder {
		return this.root;
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this.fileMap.get(normalizePath(path)) ?? null;
	}

	getFileByPath(path: string): TFile | null {
		const file = this.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	getFolderByPath(path: string): TFolder | null {
		const file = this.getAbstractFileByPath(path);
		return file instanceof TFolder ? file : null;
	}

	getAllLoadedFiles(): TAbstractFile[] {
		return [...this.fileMap.values()];
	}

	getAllFolders(includeRoot = false): TFolder[] {
		return [...this.fileMap.values()].filter(
			(f): f is TFolder => f instanceof TFolder && (includeRoot || !f.isRoot()),
		);
	}

	getFiles(): TFile[] {
		return [...this.fileMap.values()].filter((f): f is TFile => f instanceof TFile);
	}

	getMarkdownFiles(): TFile[] {
		return this.getFiles().filter((f) => f.extension === 'md');
	}

	async read(file: TFile): Promise<string> {
		const data = await this.backend.read(file.path);
		this.contentCache.set(file.path, data);
		return data;
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.contentCache.get(file.path) ?? this.read(file);
	}

	/** @internal Cached content without reading, if any. */
	peekContent(path: string): string | undefined {
		return this.contentCache.get(path);
	}

	async modify(file: TFile, data: string): Promise<void> {
		this.applyUpdate(await this.backend.write(file.path, data), { path: file.path, data });
	}

	async create(path: string, data: string): Promise<TFile> {
		path = normalizePath(path);
		if (this.fileMap.has(path)) throw new Error(`File already exists: ${path}`);
		this.applyUpdate(await this.backend.create(path, data), { path, data });
		const file = this.getFileByPath(path);
		if (!file) throw new Error(`File was not created: ${path}`);
		return file;
	}

	async createFolder(path: string): Promise<TFolder> {
		path = normalizePath(path);
		if (this.fileMap.has(path)) throw new Error(`Folder already exists: ${path}`);
		this.applyUpdate(await this.backend.createFolder(path));
		const folder = this.getFolderByPath(path);
		if (!folder) throw new Error(`Folder was not created: ${path}`);
		return folder;
	}

	async rename(file: TAbstractFile, newPath: string): Promise<void> {
		this.applyUpdate(await this.backend.rename(file.path, normalizePath(newPath)));
	}

	/** Moves the file or folder to the vault's `.trash` folder. */
	async trash(file: TAbstractFile): Promise<void> {
		this.applyUpdate(await this.backend.trash(file.path));
	}

	/**
	 * Same as `trash` for now: nothing is ever deleted permanently until
	 * EmeraldMD has a trash setting and a confirmation flow.
	 */
	async delete(file: TAbstractFile): Promise<void> {
		await this.trash(file);
	}

	/** "Untitled.md", then "Untitled 1.md", "Untitled 2.md", … */
	getAvailablePath(base: string, extension: string): string {
		const suffix = extension ? '.' + extension : '';
		let candidate = normalizePath(base + suffix);
		for (let n = 1; this.fileMap.has(candidate); n++) {
			candidate = normalizePath(`${base} ${n}${suffix}`);
		}
		return candidate;
	}

	/** Applies a change set from the backend (own operations and external changes alike). */
	applyUpdate(update: VaultUpdate, written?: Written): void {
		for (const [from, to] of update.renamed) this.move(from, to);
		for (const path of update.removed) this.remove(path);
		for (const entry of update.upserted) this.upsert(entry, written);
		this.trigger('emerald:update', update);
	}

	private add(entry: FileEntry, notify: boolean): TAbstractFile {
		const parent = this.ensureFolder(parentPath(entry.path), notify);
		const file = entry.kind === 'folder' ? new TFolder(this, entry.path) : new TFile(this, entry.path, statOf(entry));
		this.attach(file, parent);
		this.structureVersion++;
		if (notify) this.trigger('create', file);
		return file;
	}

	private ensureFolder(path: string, notify: boolean): TFolder {
		const existing = this.fileMap.get(path);
		if (existing instanceof TFolder) return existing;
		const now = Date.now();
		return this.add({ path, kind: 'folder', ctime: now, mtime: now, size: 0 }, notify) as TFolder;
	}

	private attach(file: TAbstractFile, parent: TFolder): void {
		file.parent = parent;
		parent.children.push(file);
		this.fileMap.set(file.path, file);
	}

	private detach(file: TAbstractFile): void {
		if (file.parent) file.parent.children = file.parent.children.filter((c) => c !== file);
		file.parent = null;
	}

	private upsert(entry: FileEntry, written?: Written): void {
		const existing = this.fileMap.get(entry.path);
		if (!existing) {
			this.add(entry, true);
			if (written?.path === entry.path) this.contentCache.set(entry.path, written.data);
			return;
		}
		if (!(existing instanceof TFile) || entry.kind !== 'file') return;
		const ownWrite = written?.path === entry.path;
		const changed = ownWrite || existing.stat.mtime !== entry.mtime || existing.stat.size !== entry.size;
		existing.stat = statOf(entry);
		if (ownWrite) this.contentCache.set(entry.path, written.data);
		else this.contentCache.delete(entry.path);
		if (changed) this.trigger('modify', existing);
	}

	private remove(path: string): void {
		const file = this.fileMap.get(path);
		if (!file || file === this.root) return;
		this.detach(file);
		for (const f of [file, ...descendants(file)]) {
			this.fileMap.delete(f.path);
			this.contentCache.delete(f.path);
		}
		this.structureVersion++;
		this.trigger('delete', file);
	}

	private move(from: string, to: string): void {
		const file = this.fileMap.get(from);
		if (!file || file === this.root) return;
		const moved = [file, ...descendants(file)];
		const oldPaths = moved.map((f) => f.path);
		this.detach(file);
		for (const f of moved) this.fileMap.delete(f.path);
		moved.forEach((f, i) => f.setPath(to + oldPaths[i]!.slice(from.length)));
		this.attach(file, this.ensureFolder(parentPath(to), true));
		for (const f of moved.slice(1)) this.fileMap.set(f.path, f);
		moved.forEach((f, i) => {
			const content = this.contentCache.get(oldPaths[i]!);
			if (content !== undefined) {
				this.contentCache.delete(oldPaths[i]!);
				this.contentCache.set(f.path, content);
			}
		});
		this.structureVersion++;
		moved.forEach((f, i) => this.trigger('rename', f, oldPaths[i]));
	}
}

function descendants(file: TAbstractFile): TAbstractFile[] {
	if (!(file instanceof TFolder)) return [];
	return file.children.flatMap((child) => [child, ...descendants(child)]);
}
