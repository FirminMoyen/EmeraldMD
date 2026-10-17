/**
 * `vault.adapter`: path-based file access. Paths inside the config folder
 * (`.obsidian/…`) go to a `ConfigStore` (Rust commands on desktop, which
 * only allow paths inside that folder); every other path goes through the
 * vault mirror so the file tree and metadata stay in sync.
 */

import { normalizePath, TFile, TFolder, type Vault } from '@emeraldmd/core';
import { concatBytes } from './util';

export interface Stat {
	type: 'file' | 'folder';
	ctime: number;
	mtime: number;
	size: number;
}

export interface ListedFiles {
	files: string[];
	folders: string[];
}

export interface DataWriteOptions {
	ctime?: number;
	mtime?: number;
}

/** Files under the vault's config folder. Paths are vault-relative, e.g. `.obsidian/plugins/x/data.json`. */
export interface ConfigStore {
	read(path: string): Promise<string | null>;
	write(path: string, data: string): Promise<void>;
	list(path: string): Promise<ListedFiles>;
	stat(path: string): Promise<Stat | null>;
	mkdir(path: string): Promise<void>;
	/** Moves a plugin or theme folder to the vault's trash (uninstalling). Other paths are refused. */
	trash?(path: string): Promise<void>;
}

export interface DataAdapter {
	getName(): string;
	exists(normalizedPath: string, sensitive?: boolean): Promise<boolean>;
	stat(normalizedPath: string): Promise<Stat | null>;
	list(normalizedPath: string): Promise<ListedFiles>;
	read(normalizedPath: string): Promise<string>;
	readBinary(normalizedPath: string): Promise<ArrayBuffer>;
	write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void>;
	writeBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
	append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void>;
	appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
	process(normalizedPath: string, fn: (data: string) => string, options?: DataWriteOptions): Promise<string>;
	getResourcePath(normalizedPath: string): string;
	mkdir(normalizedPath: string): Promise<void>;
	trashSystem(normalizedPath: string): Promise<boolean>;
	trashLocal(normalizedPath: string): Promise<void>;
	rmdir(normalizedPath: string, recursive: boolean): Promise<void>;
	remove(normalizedPath: string): Promise<void>;
	rename(normalizedPath: string, normalizedNewPath: string): Promise<void>;
	copy(normalizedPath: string, normalizedNewPath: string): Promise<void>;
}

/** Exported so plugins' `adapter instanceof FileSystemAdapter` checks work; EmeraldMD's adapter is neither. */
export class FileSystemAdapter {}
export class CapacitorAdapter {}

function notFound(path: string): Error {
	return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' });
}

function unsupported(what: string, path: string): Error {
	return new Error(`${what} is not supported for '${path}' in EmeraldMD yet`);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class VaultAdapter implements DataAdapter {
	/** Builds `getResourcePath` URLs; the desktop shell sets this. */
	resourcePath: (path: string) => string = (path) => path;
	private readonly vault: Vault;
	private readonly config: ConfigStore;

	constructor(vault: Vault, config: ConfigStore) {
		this.vault = vault;
		this.config = config;
	}

	getName(): string {
		return this.vault.getName();
	}

	/** @internal */
	isConfigPath(path: string): boolean {
		const dir = this.vault.configDir;
		return path === dir || path.startsWith(dir + '/');
	}

	async exists(path: string, _sensitive?: boolean): Promise<boolean> {
		return (await this.stat(path)) !== null;
	}

	async stat(path: string): Promise<Stat | null> {
		path = normalizePath(path);
		if (this.isConfigPath(path)) return this.config.stat(path);
		const file = this.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) return { type: 'file', ...file.stat };
		if (file instanceof TFolder) return { type: 'folder', ctime: 0, mtime: 0, size: 0 };
		return null;
	}

	async list(path: string): Promise<ListedFiles> {
		path = normalizePath(path);
		if (this.isConfigPath(path)) return this.config.list(path);
		const folder = this.vault.getAbstractFileByPath(path);
		if (!(folder instanceof TFolder)) throw notFound(path);
		const files: string[] = [];
		const folders: string[] = folder.isRoot() ? [this.vault.configDir] : [];
		for (const child of folder.children) (child instanceof TFolder ? folders : files).push(child.path);
		return { files, folders };
	}

	async read(path: string): Promise<string> {
		path = normalizePath(path);
		if (this.isConfigPath(path)) {
			const data = await this.config.read(path);
			if (data === null) throw notFound(path);
			return data;
		}
		const file = this.vault.getFileByPath(path);
		if (!file) throw notFound(path);
		return this.vault.read(file);
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		path = normalizePath(path);
		if (this.isConfigPath(path)) return encoder.encode(await this.read(path)).buffer as ArrayBuffer;
		const file = this.vault.getFileByPath(path);
		if (!file) throw notFound(path);
		return this.vault.readBinary(file);
	}

	async write(path: string, data: string, _options?: DataWriteOptions): Promise<void> {
		path = normalizePath(path);
		if (this.isConfigPath(path)) return this.config.write(path, data);
		const file = this.vault.getFileByPath(path);
		if (file) await this.vault.modify(file, data);
		else await this.vault.create(path, data);
	}

	/** Text only for now: the data is written as UTF-8. */
	async writeBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
		path = normalizePath(path);
		if (this.isConfigPath(path)) return this.write(path, decoder.decode(data), options);
		const file = this.vault.getFileByPath(path);
		if (file) await this.vault.modifyBinary(file, data);
		else await this.vault.createBinary(path, data);
	}

	async append(path: string, data: string, options?: DataWriteOptions): Promise<void> {
		const existing = (await this.exists(path)) ? await this.read(path) : '';
		await this.write(path, existing + data, options);
	}

	async appendBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
		const existing = (await this.exists(path)) ? await this.readBinary(path) : new ArrayBuffer(0);
		await this.writeBinary(path, concatBytes(existing, data), options);
	}

	async process(path: string, fn: (data: string) => string, options?: DataWriteOptions): Promise<string> {
		const result = fn(await this.read(path));
		await this.write(path, result, options);
		return result;
	}

	getResourcePath(path: string): string {
		return this.resourcePath(normalizePath(path));
	}

	async mkdir(path: string): Promise<void> {
		path = normalizePath(path);
		if (this.isConfigPath(path)) return this.config.mkdir(path);
		if (!this.vault.getAbstractFileByPath(path)) await this.vault.createFolder(path);
	}

	async trashSystem(_path: string): Promise<boolean> {
		return false;
	}

	async trashLocal(path: string): Promise<void> {
		path = normalizePath(path);
		if (this.isConfigPath(path)) {
			if (!this.config.trash) throw unsupported('Moving to trash', path);
			return this.config.trash(path);
		}
		const file = this.vault.getAbstractFileByPath(path);
		if (!file) throw notFound(path);
		await this.vault.trash(file);
	}

	/** Moves the folder to the vault's `.trash` (nothing is deleted permanently). */
	async rmdir(path: string, _recursive: boolean): Promise<void> {
		await this.trashLocal(path);
	}

	/** Moves the file to the vault's `.trash` (nothing is deleted permanently). */
	async remove(path: string): Promise<void> {
		await this.trashLocal(path);
	}

	async rename(path: string, newPath: string): Promise<void> {
		path = normalizePath(path);
		if (this.isConfigPath(path) || this.isConfigPath(normalizePath(newPath))) throw unsupported('Renaming', path);
		const file = this.vault.getAbstractFileByPath(path);
		if (!file) throw notFound(path);
		await this.vault.rename(file, newPath);
	}

	async copy(path: string, newPath: string): Promise<void> {
		if (await this.exists(newPath)) throw new Error(`Destination file already exists: ${newPath}`);
		await this.write(newPath, await this.read(path));
	}
}
