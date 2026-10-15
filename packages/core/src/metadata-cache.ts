/**
 * Mirror of the Rust index's metadata and links, with the plugin API's
 * `MetadataCache` shape. Events: `changed` (file, data, cache) and `resolved`.
 */

import { Events } from './events';
import { LinkResolver } from './link-resolver';
import type { CachedMetadata, LinkSets, VaultSnapshot, VaultUpdate } from './types';
import { TFile, type Vault } from './vault';

export class MetadataCache extends Events {
	/** source path -> target path -> link count */
	resolvedLinks: Record<string, Record<string, number>> = {};
	/** source path -> unresolved linkpath -> link count */
	unresolvedLinks: Record<string, Record<string, number>> = {};

	private readonly vault: Vault;
	private readonly caches = new Map<string, CachedMetadata>();
	private resolver: LinkResolver | null = null;
	private resolverVersion = -1;

	constructor(vault: Vault, snapshot: Pick<VaultSnapshot, 'metadata' | 'links'>) {
		super();
		this.vault = vault;
		for (const [path, metadata] of Object.entries(snapshot.metadata)) this.caches.set(path, metadata);
		for (const [path, sets] of Object.entries(snapshot.links)) this.setLinks(path, sets);
		vault.on('emerald:update', (update: VaultUpdate) => this.applyUpdate(update));
	}

	getFileCache(file: TFile): CachedMetadata | null {
		return this.caches.get(file.path) ?? null;
	}

	getCache(path: string): CachedMetadata | null {
		return this.caches.get(path) ?? null;
	}

	getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
		const target = this.getResolver().resolve(linkpath, sourcePath);
		return target === null ? null : this.vault.getFileByPath(target);
	}

	/** The shortest link text that resolves to `file` from `sourcePath`. */
	fileToLinktext(file: TFile, sourcePath: string, omitMdExtension = true): string {
		const omit = omitMdExtension && file.extension === 'md';
		const name = omit ? file.basename : file.name;
		if (this.getFirstLinkpathDest(name, sourcePath) === file) return name;
		return omit ? file.path.slice(0, -'.md'.length) : file.path;
	}

	/** Notes that link to `file`, sorted by path. */
	getBacklinks(file: TFile): string[] {
		return Object.keys(this.resolvedLinks)
			.filter((source) => this.resolvedLinks[source]![file.path] !== undefined)
			.sort();
	}

	private getResolver(): LinkResolver {
		if (!this.resolver || this.resolverVersion !== this.vault.structureVersion) {
			this.resolver = new LinkResolver(this.vault.getFiles().map((f) => f.path));
			this.resolverVersion = this.vault.structureVersion;
		}
		return this.resolver;
	}

	private setLinks(path: string, sets: LinkSets): void {
		this.resolvedLinks[path] = sets.resolved;
		this.unresolvedLinks[path] = sets.unresolved;
	}

	private forget(path: string): void {
		this.caches.delete(path);
		delete this.resolvedLinks[path];
		delete this.unresolvedLinks[path];
	}

	private applyUpdate(update: VaultUpdate): void {
		for (const [from, to] of update.renamed) {
			const prefix = from + '/';
			for (const path of [...this.caches.keys(), ...Object.keys(this.resolvedLinks)]) {
				if (path !== from && !path.startsWith(prefix)) continue;
				const newPath = to + path.slice(from.length);
				const cache = this.caches.get(path);
				const resolved = this.resolvedLinks[path];
				const unresolved = this.unresolvedLinks[path];
				this.forget(path);
				if (cache) this.caches.set(newPath, cache);
				if (resolved && unresolved) this.setLinks(newPath, { resolved, unresolved });
			}
		}
		for (const path of update.removed) this.forget(path);
		for (const [path, sets] of Object.entries(update.links)) this.setLinks(path, sets);
		for (const [path, metadata] of Object.entries(update.metadata)) {
			this.caches.set(path, metadata);
			const file = this.vault.getFileByPath(path);
			if (file) this.trigger('changed', file, this.vault.peekContent(path) ?? '', metadata);
		}
		this.trigger('resolved');
	}
}
