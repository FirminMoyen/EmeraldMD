import type { Extension } from '@codemirror/state';
import { normalizePath } from '@emeraldmd/core';
import type { App } from './app';
import type { BasesViewRegistration } from './bases/view';
import type { Command } from './commands';
import { Component } from './component';
import { MarkdownPreviewRenderer, type MarkdownPostProcessor, type MarkdownPostProcessorContext } from './markdown';
import type { PluginSettingTab } from './setting-tab';
import type { EditorSuggest } from './suggest';
import type { ViewCreator } from './workspace';

export interface PluginManifest {
	/** Vault-relative folder of the plugin, e.g. `.obsidian/plugins/my-plugin`. */
	dir?: string;
	id: string;
	name: string;
	author: string;
	version: string;
	minAppVersion: string;
	description: string;
	authorUrl?: string;
	isDesktopOnly?: boolean;
	fundingUrl?: string | Record<string, string>;
}

export interface ObsidianProtocolData {
	action: string;
	[key: string]: string | 'true';
}

export type ObsidianProtocolHandler = (params: ObsidianProtocolData) => unknown;

export interface HoverLinkSource {
	display: string;
	defaultMod: boolean;
}

export abstract class Plugin extends Component {
	app: App;
	manifest: PluginManifest;
	settings?: unknown;

	constructor(app: App, manifest: PluginManifest) {
		super();
		this.app = app;
		this.manifest = manifest;
	}

	override onload(): Promise<void> | void {}

	addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
		const ribbon = this.app.workspace.leftRibbon;
		const el = ribbon.addRibbonItemButton(`${this.manifest.id}:${title}`, icon, title, callback);
		this.register(() => ribbon.removeRibbonItem(el));
		return el;
	}

	addStatusBarItem(): HTMLElement {
		const el = this.app.statusBar.containerEl.createDiv(`status-bar-item plugin-${this.manifest.id.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`);
		this.register(() => el.detach());
		return el;
	}

	/** Registers a command. Its id and name are prefixed with the plugin's id and name. */
	addCommand(command: Command): Command {
		const prefix = `${this.manifest.id}:`;
		if (!command.id.startsWith(prefix)) command.id = prefix + command.id;
		const namePrefix = `${this.manifest.name}: `;
		if (!command.name.startsWith(namePrefix)) command.name = namePrefix + command.name;
		this.app.commands.addCommand(command);
		this.register(() => this.app.commands.removeCommand(command.id));
		return command;
	}

	removeCommand(commandId: string): void {
		this.app.commands.removeCommand(`${this.manifest.id}:${commandId}`);
	}

	addSettingTab(settingTab: PluginSettingTab): void {
		this.app.setting.addSettingTab(settingTab);
		this.register(() => this.app.setting.removeSettingTab(settingTab));
	}

	registerView(type: string, viewCreator: ViewCreator): void {
		this.app.viewRegistry.registerView(type, viewCreator);
		this.register(() => {
			this.app.workspace.detachLeavesOfType(type);
			this.app.viewRegistry.unregisterView(type);
		});
	}

	registerHoverLinkSource(id: string, info: HoverLinkSource): void {
		this.app.workspace.registerHoverLinkSource(id, info);
		this.register(() => this.app.workspace.unregisterHoverLinkSource(id));
	}

	registerExtensions(extensions: string[], viewType: string): void {
		this.app.viewRegistry.registerExtensions(extensions, viewType);
		this.register(() => this.app.viewRegistry.unregisterExtensions(extensions));
	}

	registerMarkdownPostProcessor(postProcessor: MarkdownPostProcessor, sortOrder?: number): MarkdownPostProcessor {
		MarkdownPreviewRenderer.registerPostProcessor(postProcessor, sortOrder);
		this.register(() => MarkdownPreviewRenderer.unregisterPostProcessor(postProcessor));
		return postProcessor;
	}

	registerMarkdownCodeBlockProcessor(
		language: string,
		handler: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<unknown> | void,
		sortOrder?: number,
	): MarkdownPostProcessor {
		const processor: MarkdownPostProcessor = MarkdownPreviewRenderer.createCodeBlockPostProcessor(language, handler);
		return this.registerMarkdownPostProcessor(processor, sortOrder ?? -100);
	}

	/** Adds a Bases view type; false if Bases is off or the id is taken. */
	registerBasesView(viewId: string, registration: BasesViewRegistration): boolean {
		const bases = this.app.internalPlugins.getEnabledPluginById('bases') as unknown as { registerView?(id: string, r: BasesViewRegistration): boolean; unregisterView?(id: string): void } | null;
		if (!bases?.registerView?.(viewId, registration)) return false;
		this.register(() => bases.unregisterView?.(viewId));
		return true;
	}

	registerEditorExtension(extension: Extension): void {
		this.app.workspace.registerEditorExtension(extension);
		this.register(() => this.app.workspace.unregisterEditorExtension(extension));
	}

	registerObsidianProtocolHandler(action: string, handler: ObsidianProtocolHandler): void {
		this.app.protocolHandlers.set(action, handler);
		this.register(() => {
			if (this.app.protocolHandlers.get(action) === handler) this.app.protocolHandlers.delete(action);
		});
	}

	registerEditorSuggest(editorSuggest: EditorSuggest<unknown>): void {
		this.app.workspace.editorSuggest.addSuggest(editorSuggest);
		this.register(() => this.app.workspace.editorSuggest.removeSuggest(editorSuggest));
	}

	/** EmeraldMD has no command-line interface; registrations are ignored. */
	registerCliHandler(_command: string, _description: string, _flags: unknown, _handler: unknown): void {}

	/** @internal */
	get dataPath(): string {
		return normalizePath(`${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/data.json`);
	}

	/** The plugin's `data.json`, parsed, or null if it does not exist. */
	async loadData(): Promise<unknown> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.dataPath))) return null;
		const text = await adapter.read(this.dataPath);
		try {
			return JSON.parse(text);
		} catch (err) {
			console.error(`${this.manifest.id}: data.json is not valid JSON`, err);
			return null;
		}
	}

	async saveData(data: unknown): Promise<void> {
		await this.app.vault.adapter.write(this.dataPath, JSON.stringify(data, null, 2));
	}

	onUserEnable(): void {}

	onExternalSettingsChange?(): unknown;
}
