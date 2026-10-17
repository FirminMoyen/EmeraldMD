/**
 * In-memory vault and config storage, for headless tests (unit tests, the
 * compat harness). Metadata is not parsed: updates carry no metadata.
 */

import { MetadataCache, normalizePath, parentPath, type FileEntry, type VaultBackend, type VaultUpdate } from '@emeraldmd/core';
import type { ConfigStore, ListedFiles, Stat } from './adapter';
import { App } from './app';
import { Vault } from './vault';

function emptyUpdate(): VaultUpdate {
	return { renamed: [], removed: [], upserted: [], metadata: {}, links: {} };
}

export class MemoryBackend implements VaultBackend {
	readonly files = new Map<string, string>();
	readonly folders = new Set<string>();
	/** Bytes of files written with `writeBinary` (`files` holds their UTF-8 reading). */
	readonly binaries = new Map<string, Uint8Array>();
	private clock = 1;

	constructor(files: Record<string, string> = {}) {
		for (const [path, data] of Object.entries(files)) this.files.set(normalizePath(path), data);
	}

	entries(): FileEntry[] {
		const folders = new Set(this.folders);
		for (const path of this.files.keys()) {
			for (let p = parentPath(path); p !== '/'; p = parentPath(p)) folders.add(p);
		}
		const out: FileEntry[] = [...folders].map((path) => ({ path, kind: 'folder', ctime: 0, mtime: 0, size: 0 }));
		for (const [path, data] of this.files) out.push(this.entry(path, data));
		return out.sort((a, b) => a.path.localeCompare(b.path));
	}

	async read(path: string): Promise<string> {
		const data = this.files.get(normalizePath(path));
		if (data === undefined) throw new Error(`not found: ${path}`);
		return data;
	}

	async write(path: string, data: string): Promise<VaultUpdate> {
		path = normalizePath(path);
		this.binaries.delete(path);
		this.files.set(path, data);
		return { ...emptyUpdate(), upserted: [this.entry(path, data)] };
	}

	async create(path: string, data: string): Promise<VaultUpdate> {
		path = normalizePath(path);
		if (this.files.has(path) || this.folders.has(path)) throw new Error(`already exists: ${path}`);
		return this.write(path, data);
	}

	async createFolder(path: string): Promise<VaultUpdate> {
		path = normalizePath(path);
		if (this.files.has(path) || this.folders.has(path)) throw new Error(`already exists: ${path}`);
		this.folders.add(path);
		return { ...emptyUpdate(), upserted: [{ path, kind: 'folder', ctime: 0, mtime: 0, size: 0 }] };
	}

	async rename(from: string, to: string): Promise<VaultUpdate> {
		from = normalizePath(from);
		to = normalizePath(to);
		const moved = (p: string) => (p === from || p.startsWith(from + '/') ? to + p.slice(from.length) : p);
		for (const [path, data] of [...this.files]) {
			if (moved(path) !== path) {
				this.files.delete(path);
				this.files.set(moved(path), data);
			}
		}
		for (const path of [...this.folders]) {
			if (moved(path) !== path) {
				this.folders.delete(path);
				this.folders.add(moved(path));
			}
		}
		return { ...emptyUpdate(), renamed: [[from, to]] };
	}

	async trash(path: string): Promise<VaultUpdate> {
		path = normalizePath(path);
		const removed = [...this.files.keys(), ...this.folders].filter((p) => p === path || p.startsWith(path + '/'));
		for (const p of removed) {
			this.files.delete(p);
			this.folders.delete(p);
		}
		return { ...emptyUpdate(), removed: removed.sort().reverse() };
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		path = normalizePath(path);
		const bytes = this.binaries.get(path) ?? new TextEncoder().encode(await this.read(path));
		return bytes.slice().buffer as ArrayBuffer;
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<VaultUpdate> {
		path = normalizePath(path);
		const update = await this.write(path, new TextDecoder().decode(data));
		this.binaries.set(path, new Uint8Array(data.slice(0)));
		return update;
	}

	private entry(path: string, data: string): FileEntry {
		const now = this.clock++;
		return { path, kind: 'file', ctime: now, mtime: now, size: data.length };
	}
}

export class MemoryConfigStore implements ConfigStore {
	readonly files = new Map<string, string>();
	readonly folders = new Set<string>();

	constructor(files: Record<string, string> = {}) {
		for (const [path, data] of Object.entries(files)) this.files.set(normalizePath(path), data);
	}

	async read(path: string): Promise<string | null> {
		return this.files.get(normalizePath(path)) ?? null;
	}

	async write(path: string, data: string): Promise<void> {
		this.files.set(normalizePath(path), data);
	}

	async list(path: string): Promise<ListedFiles> {
		const prefix = normalizePath(path) + '/';
		const files = new Set<string>();
		const folders = new Set<string>();
		for (const p of [...this.files.keys(), ...this.folders]) {
			if (!p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length);
			const slash = rest.indexOf('/');
			if (slash === -1) (this.files.has(p) ? files : folders).add(p);
			else folders.add(prefix + rest.slice(0, slash));
		}
		return { files: [...files].sort(), folders: [...folders].sort() };
	}

	async stat(path: string): Promise<Stat | null> {
		path = normalizePath(path);
		const data = this.files.get(path);
		if (data !== undefined) return { type: 'file', ctime: 0, mtime: 0, size: data.length };
		const prefix = path + '/';
		const isFolder = this.folders.has(path) || [...this.files.keys()].some((p) => p.startsWith(prefix));
		return isFolder ? { type: 'folder', ctime: 0, mtime: 0, size: 0 } : null;
	}

	async mkdir(path: string): Promise<void> {
		this.folders.add(normalizePath(path));
	}

	/** Forgets the folder (the app moves it to the vault's trash). */
	async trash(path: string): Promise<void> {
		const prefix = normalizePath(path);
		for (const key of [...this.files.keys()]) if (key === prefix || key.startsWith(`${prefix}/`)) this.files.delete(key);
		for (const key of [...this.folders]) if (key === prefix || key.startsWith(`${prefix}/`)) this.folders.delete(key);
	}
}

export interface TestApp {
	app: App;
	backend: MemoryBackend;
	config: MemoryConfigStore;
}

/** An `App` over in-memory storage. `config` keys are vault paths like `.obsidian/app.json`. */
export async function createTestApp(files: Record<string, string> = {}, config: Record<string, string> = {}): Promise<TestApp> {
	const backend = new MemoryBackend(files);
	const store = new MemoryConfigStore(config);
	const vault = new Vault(backend, 'Test vault', backend.entries(), store);
	await vault.loadConfig();
	const metadataCache = new MetadataCache(vault, { metadata: {}, links: {} });
	const app = new App({ vault, metadataCache, appId: 'test' });
	await app.metadataTypeManager.load();
	return { app, backend, config: store };
}
