/**
 * Property (frontmatter) types, as `app.metadataTypeManager`. Not in the
 * public typings; the shape follows what open-source plugins call
 * (`getAllProperties`, `getTypeInfo`, `setType`). Assigned types are stored
 * in `.obsidian/types.json` as `{ "types": { "<property>": "<type>" } }`.
 */

import { Events } from '@emeraldmd/core';
import type { App } from './app';

export interface PropertyInfo {
	name: string;
	type: string;
	count: number;
}

export interface PropertyTypeInfo {
	expected?: { type: string };
	inferred?: { type: string };
}

/** Types Obsidian assigns to these properties out of the box. */
const BUILT_IN: Record<string, string> = { aliases: 'aliases', cssclasses: 'multitext', tags: 'tags' };

function inferType(value: unknown): string {
	if (typeof value === 'boolean') return 'checkbox';
	if (typeof value === 'number') return 'number';
	if (Array.isArray(value)) return 'multitext';
	if (typeof value === 'string') {
		if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return 'datetime';
		if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
	}
	return 'text';
}

export class MetadataTypeManager extends Events {
	/** Types assigned by the user or plugins, by property name. */
	types: Record<string, string> = {};
	private readonly app: App;

	constructor(app: App) {
		super();
		this.app = app;
	}

	private get path(): string {
		return `${this.app.vault.configDir}/types.json`;
	}

	/** @internal Reads `types.json`. */
	async load(): Promise<void> {
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(this.path))) return;
			const data = JSON.parse(await adapter.read(this.path)) as { types?: Record<string, string> };
			this.types = data.types && typeof data.types === 'object' ? data.types : {};
		} catch (err) {
			console.error(`Could not read ${this.path}`, err);
		}
	}

	/** Every property used in the vault's frontmatter, plus those with an assigned type. */
	getAllProperties(): Record<string, PropertyInfo> {
		const out: Record<string, PropertyInfo> = {};
		for (const file of this.app.vault.getMarkdownFiles()) {
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			for (const [name, value] of Object.entries(frontmatter ?? {})) {
				const key = name.toLowerCase();
				const info = (out[key] ??= { name, type: this.getAssignedType(name) ?? inferType(value), count: 0 });
				info.count++;
			}
		}
		for (const [name, type] of Object.entries({ ...BUILT_IN, ...this.types })) {
			out[name.toLowerCase()] ??= { name, type, count: 0 };
		}
		return out;
	}

	getAssignedType(name: string): string | null {
		const key = name.toLowerCase();
		const assigned = Object.entries(this.types).find(([k]) => k.toLowerCase() === key)?.[1];
		return assigned ?? BUILT_IN[key] ?? null;
	}

	getPropertyInfo(name: string): PropertyInfo | null {
		return this.getAllProperties()[name.toLowerCase()] ?? null;
	}

	getTypeInfo(name: string, value?: unknown): PropertyTypeInfo {
		const assigned = this.getAssignedType(name);
		const inferred = value !== undefined ? inferType(value) : (this.getPropertyInfo(name)?.type ?? 'text');
		return { expected: assigned ? { type: assigned } : undefined, inferred: { type: inferred } };
	}

	setType(name: string, type: string): void {
		this.types[name] = type;
		this.save();
		this.trigger('changed', name);
	}

	unsetType(name: string): void {
		delete this.types[name];
		this.save();
		this.trigger('changed', name);
	}

	private save(): void {
		void this.app.vault.adapter.write(this.path, JSON.stringify({ types: this.types }, null, 2)).catch((err: unknown) => console.error(err));
	}
}
