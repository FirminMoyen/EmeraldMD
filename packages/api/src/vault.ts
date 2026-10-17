/**
 * The plugin API's `Vault`: the core mirror plus `adapter`, app settings
 * (`getConfig`/`setConfig`, stored in `.obsidian/app.json` and
 * `appearance.json`) and the convenience methods plugins use.
 */

import { normalizePath, TAbstractFile, TFile, TFolder, Vault as CoreVault, type FileEntry, type VaultBackend } from '@emeraldmd/core';
import { VaultAdapter, type ConfigStore, type DataWriteOptions } from './adapter';
import { concatBytes } from './util';

/** Settings kept in `appearance.json` rather than `app.json`. */
const APPEARANCE_KEYS = new Set([
	'accentColor',
	'baseFontSize',
	'baseFontSizeAction',
	'cssTheme',
	'enabledCssSnippets',
	'interfaceFontFamily',
	'monospaceFontFamily',
	'nativeMenus',
	'showRibbon',
	'showViewHeader',
	'textFontFamily',
	'theme',
	'translucency',
]);

/** Values used when a vault's config files do not set a key. */
const DEFAULT_CONFIG: Record<string, unknown> = {
	alwaysUpdateLinks: false,
	attachmentFolderPath: '/',
	baseFontSize: 16,
	defaultViewMode: 'source',
	foldHeading: true,
	foldIndent: true,
	livePreview: true,
	mobileToolbarCommands: [],
	newFileFolderPath: '',
	newFileLocation: 'root',
	newLinkFormat: 'shortest',
	promptDelete: true,
	propertiesInDocument: 'visible',
	readableLineLength: true,
	showLineNumber: false,
	spellcheck: false,
	strictLineBreaks: false,
	tabSize: 4,
	theme: 'system',
	trashOption: 'local',
	useMarkdownLinks: false,
	useTab: true,
	vimMode: false,
};


export class Vault extends CoreVault {
	adapter: VaultAdapter;
	private appConfig: Record<string, unknown> = {};
	private appearanceConfig: Record<string, unknown> = {};

	constructor(backend: VaultBackend, name: string, files: FileEntry[], config: ConfigStore) {
		super(backend, name, files);
		this.adapter = new VaultAdapter(this, config);
	}

	/** @internal Reads `app.json` and `appearance.json`. Missing or invalid files count as empty. */
	async loadConfig(): Promise<void> {
		this.appConfig = await this.readConfigFile('app.json');
		this.appearanceConfig = await this.readConfigFile('appearance.json');
	}

	/** @internal The effective app settings, read directly by some plugins. */
	get config(): Record<string, unknown> {
		return { ...DEFAULT_CONFIG, ...this.appConfig, ...this.appearanceConfig };
	}

	getConfig(key: string): unknown {
		const value = APPEARANCE_KEYS.has(key) ? this.appearanceConfig[key] : this.appConfig[key];
		return value ?? DEFAULT_CONFIG[key] ?? null;
	}

	setConfig(key: string, value: unknown): void {
		const appearance = APPEARANCE_KEYS.has(key);
		const target = appearance ? this.appearanceConfig : this.appConfig;
		if (value === undefined || value === null) delete target[key];
		else target[key] = value;
		const file = `${this.configDir}/${appearance ? 'appearance.json' : 'app.json'}`;
		void this.adapter.write(file, JSON.stringify(target, null, 2)).catch((err: unknown) => console.error(err));
		this.trigger('config-changed', key);
	}

	override async createBinary(path: string, data: ArrayBuffer, _options?: DataWriteOptions): Promise<TFile> {
		return super.createBinary(path, data);
	}

	override async modifyBinary(file: TFile, data: ArrayBuffer, _options?: DataWriteOptions): Promise<void> {
		await super.modifyBinary(file, data);
	}

	async append(file: TFile, data: string, _options?: DataWriteOptions): Promise<void> {
		await this.modify(file, (await this.read(file)) + data);
	}

	async appendBinary(file: TFile, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
		await this.modifyBinary(file, concatBytes(await this.readBinary(file), data), options);
	}

	/** Reads, transforms and writes the file in one step. */
	async process(file: TFile, fn: (data: string) => string, _options?: DataWriteOptions): Promise<string> {
		const result = fn(await this.read(file));
		await this.modify(file, result);
		return result;
	}

	async copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T> {
		newPath = normalizePath(newPath);
		if (file instanceof TFile) return (await this.create(newPath, await this.read(file))) as unknown as T;
		if (file instanceof TFolder) {
			const folder = await this.createFolder(newPath);
			for (const child of file.children) await this.copy(child, `${newPath}/${child.name}`);
			return folder as unknown as T;
		}
		throw new Error(`Cannot copy ${file.path}`);
	}

	getResourcePath(file: TFile): string {
		return `${this.adapter.getResourcePath(file.path)}?${file.stat.mtime}`;
	}

	static recurseChildren(root: TFolder, cb: (file: TAbstractFile) => unknown): void {
		const stack: TAbstractFile[] = [root];
		for (let file = stack.pop(); file; file = stack.pop()) {
			cb(file);
			if (file instanceof TFolder) stack.push(...file.children);
		}
	}

	private async readConfigFile(name: string): Promise<Record<string, unknown>> {
		const path = `${this.configDir}/${name}`;
		try {
			if (!(await this.adapter.exists(path))) return {};
			const data = JSON.parse(await this.adapter.read(path)) as unknown;
			return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
		} catch (err) {
			console.error(`Could not read ${path}`, err);
			return {};
		}
	}
}
