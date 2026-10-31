/**
 * Bases (core plugin `bases`, on by default as in Obsidian): `.base` files
 * shown as tables, cards or lists of the vault's notes, filtered, sorted
 * and grouped by their properties; embeds (`![[x.base]]`,
 * `![[x.base#View]]`) and `base` code blocks in notes; view types added by
 * plugins (`registerBasesView`). Edits from the toolbar and views are
 * written back to the `.base` file (or the code block) in Obsidian's format.
 */

import { normalizePath, TFolder, type TAbstractFile, type TFile } from '@emeraldmd/core';
import type { App } from '../app';
import { InternalPluginInstance } from '../core-plugins';
import type { Editor } from '../editor';
import { MarkdownPreviewRenderer, MarkdownRenderChild } from '../markdown';
import type { Menu } from '../menu';
import { Component } from '../component';
import { Notice } from '../notice';
import { debounce } from '../util';
import { TextFileView, type ViewStateResult } from '../views';
import type { WorkspaceLeaf } from '../workspace';
import { CARDS_VIEW, LIST_VIEW } from './cards';
import { BasesContainer } from './container';
import { parseBaseConfig, QueryController, serializeBaseConfig, type BasesConfigFile } from './query';
import { TABLE_VIEW } from './table';
import type { BasesViewRegistration } from './view';

export const BASES_VIEW_TYPE = 'bases';
export const DEFAULT_BASE = 'views:\n  - type: table\n    name: Table\n';

/** Reads a base's YAML into the controller, or shows why it could not be read. */
function load(controller: QueryController, text: string): void {
	try {
		controller.setConfig(parseBaseConfig(text));
	} catch (err) {
		controller.setConfig({}, `This base could not be read: ${(err as Error).message}`);
	}
}

export class Bases extends InternalPluginInstance {
	readonly id = 'bases';
	readonly name = 'Bases';
	readonly description = 'Show notes as tables, cards and lists, filtered and sorted by their properties.';
	readonly registrations = new Map<string, BasesViewRegistration>([
		['table', TABLE_VIEW],
		['cards', CARDS_VIEW],
		['list', LIST_VIEW],
	]);
	private readonly containers = new Set<BasesContainer>();
	private cleanups: (() => void)[] = [];

	onEnable(): void {
		const app = this.app;
		const views = app.viewRegistry;
		if (!views.getViewCreatorByType(BASES_VIEW_TYPE)) {
			views.registerView(BASES_VIEW_TYPE, (leaf) => new BasesFileView(leaf, this));
			this.cleanups.push(() => views.unregisterView(BASES_VIEW_TYPE));
		}
		if (!views.isExtensionRegistered('base')) {
			views.registerExtensions(['base'], BASES_VIEW_TYPE);
			this.cleanups.push(() => views.unregisterExtensions(['base']));
		}
		if (!app.embedRegistry.isExtensionRegistered('base')) {
			app.embedRegistry.registerExtension('base', (ctx, file, subpath) => new BaseEmbed(this, app, ctx.containerEl, file, ctx.sourcePath, subpath));
			this.cleanups.push(() => app.embedRegistry.unregisterExtension('base'));
		}
		const processor = MarkdownPreviewRenderer.createCodeBlockPostProcessor('base', (source, el, ctx) => {
			ctx.addChild(new BaseCodeBlock(this, app, el, source, ctx.sourcePath));
		});
		MarkdownPreviewRenderer.registerPostProcessor(processor, -100);
		this.cleanups.push(() => MarkdownPreviewRenderer.unregisterPostProcessor(processor));

		this.addCommand({ id: 'bases:new-file', name: 'Bases: Create new base', callback: () => void this.createBase() });
		this.addCommand({
			id: 'bases:insert',
			name: 'Bases: Insert new base',
			editorCallback: (editor: Editor) => {
				const from = editor.getCursor('from');
				const before = from.ch > 0 ? '\n' : '';
				editor.replaceSelection(`${before}\`\`\`base\n${DEFAULT_BASE}\`\`\`\n`);
			},
		});
		this.addRibbonIcon('table', 'Create new base', () => void this.createBase());
		this.registerEvent(
			app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
				if (!(file instanceof TFolder)) return;
				menu.addItem((item) => item.setTitle('New base').setIcon('table').setSection('new').onClick(() => void this.createBase(file)));
			}),
		);
	}

	override disable(): void {
		super.disable();
		for (const cleanup of this.cleanups.splice(0)) cleanup();
	}

	/** Adds a plugin's view type; false if the id is taken. */
	registerView(id: string, registration: BasesViewRegistration): boolean {
		if (this.registrations.has(id)) return false;
		this.registrations.set(id, registration);
		this.refresh();
		return true;
	}

	unregisterView(id: string): void {
		if ([TABLE_VIEW, CARDS_VIEW, LIST_VIEW].includes(this.registrations.get(id)!)) return;
		this.registrations.delete(id);
		this.refresh();
	}

	/** @internal */
	track(container: BasesContainer): () => void {
		this.containers.add(container);
		return () => this.containers.delete(container);
	}

	private refresh(): void {
		for (const container of this.containers) container.render();
	}

	/** Creates `Untitled.base` (in `folder`, or where new notes go) and opens it. */
	async createBase(folder?: TFolder): Promise<TFile | null> {
		const app = this.app;
		const parent = folder ?? app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? '');
		const path = app.vault.getAvailablePath(normalizePath(parent.isRoot() ? 'Untitled' : `${parent.path}/Untitled`), 'base');
		try {
			const file = await app.vault.create(path, DEFAULT_BASE);
			await app.workspace.getLeaf(false).openFile(file);
			return file;
		} catch (err) {
			new Notice(`Could not create a base: ${err}`);
			return null;
		}
	}
}

/** A `.base` file in a tab. */
export class BasesFileView extends TextFileView {
	private controller: QueryController;
	private container: BasesContainer;
	private untrack: () => void = () => {};
	/** The settings were changed here and are not written yet. */
	private edited = false;
	private sourceEl: HTMLTextAreaElement | null = null;
	private viewName: string | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: Bases,
	) {
		super(leaf);
		this.icon = 'table';
		this.controller = new QueryController(this.app, {
			save: () => {
				this.edited = true;
				this.requestSave();
			},
		});
		this.container = new BasesContainer(this.app, this.controller, this.contentEl, {
			registrations: () => plugin.registrations,
			onViewChange: (name) => {
				this.viewName = name;
				this.app.workspace.requestSaveLayout();
			},
		});
	}

	getViewType(): string {
		return BASES_VIEW_TYPE;
	}

	override canAcceptExtension(extension: string): boolean {
		return extension === 'base';
	}

	override getState(): Record<string, unknown> {
		return { ...super.getState(), ...(this.viewName ? { viewName: this.viewName } : {}) };
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const name = (state as { viewName?: unknown } | null)?.viewName;
		if (typeof name === 'string' && name !== this.viewName) {
			this.viewName = name;
			if (this.file) this.controller.selectView(name);
		}
		await super.setState(state, result);
	}

	protected override async onOpen(): Promise<void> {
		this.contentEl.addClass('bases-view-content');
		this.controller.load();
		this.container.load();
		this.untrack = this.plugin.track(this.container);
		this.addAction('code-xml', 'Edit as YAML', () => this.toggleSource());
		this.registerEvent(
			this.app.vault.on('modify', (file: TAbstractFile) => {
				if (file === this.file && !this.edited && !this.sourceEl) void this.reload();
			}),
		);
	}

	protected override async onClose(): Promise<void> {
		await this.save();
		this.untrack();
		this.container.unload();
		this.controller.unload();
	}

	override async onLoadFile(file: TFile): Promise<void> {
		this.controller.file = file;
		this.controller.thisFile = file;
		await super.onLoadFile(file);
	}

	override async save(): Promise<void> {
		if (!this.file) return;
		const data = this.getViewData();
		this.edited = false;
		if (data === this.data) return;
		this.data = data;
		await this.app.vault.modify(this.file, data);
	}

	getViewData(): string {
		if (this.sourceEl) return this.sourceEl.value;
		return this.edited ? serializeBaseConfig(this.controller.config) : this.data;
	}

	setViewData(data: string, clear: boolean): void {
		if (clear) this.edited = false;
		this.controller.viewName = this.viewName;
		load(this.controller, data);
	}

	clear(): void {
		this.controller.setConfig({});
	}

	/** Shows the file changed on disk (by sync, another app or a plugin). */
	private async reload(): Promise<void> {
		if (!this.file) return;
		const text = await this.app.vault.read(this.file);
		if (text === this.data || this.edited) return;
		this.data = text;
		this.setViewData(text, false);
	}

	/** Swaps between the base and its YAML; leaving the YAML applies and saves it. */
	private toggleSource(): void {
		if (this.sourceEl) {
			const text = this.sourceEl.value;
			this.sourceEl.remove();
			this.sourceEl = null;
			this.container.el.show();
			this.setViewData(text, true);
			if (text !== this.data && this.file) {
				this.data = text;
				void this.app.vault.modify(this.file, text);
			}
			return;
		}
		// Pending edits are written first, so the YAML shows them.
		void this.save();
		this.container.el.hide();
		this.sourceEl = this.contentEl.createEl('textarea', { cls: 'bases-source', attr: { spellcheck: 'false' } });
		this.sourceEl.value = this.data;
		this.sourceEl.focus();
	}
}

/** `![[x.base]]` or `![[x.base#View]]` in a note: `this` is the note. */
class BaseEmbed extends Component {
	private readonly controller: QueryController;
	/** What this embed last wrote, so its own write is not read back as a change. */
	private written: string | null = null;
	private readonly writeSoon = debounce((config: BasesConfigFile) => void this.write(config), 1000, true);

	constructor(
		private readonly plugin: Bases,
		app: App,
		private readonly containerEl: HTMLElement,
		private readonly file: TFile,
		sourcePath: string,
		subpath: string,
	) {
		super();
		const note = app.vault.getFileByPath(sourcePath);
		this.controller = new QueryController(app, { file, thisFile: note ?? file, viewName: subpath.replace(/^#/, '').trim() || null, save: (config) => this.writeSoon(config) });
	}

	override onload(): void {
		const app = this.controller.app;
		this.containerEl.addClass('bases-embed');
		this.addChild(this.controller);
		const container = new BasesContainer(app, this.controller, this.containerEl, { registrations: () => this.plugin.registrations });
		this.addChild(container);
		this.register(this.plugin.track(container));
		this.registerEvent(
			app.vault.on('modify', (file: TAbstractFile) => {
				if (file === this.file) void this.read();
			}),
		);
		void this.read();
	}

	private async read(): Promise<void> {
		const text = await this.controller.app.vault.cachedRead(this.file);
		if (text === this.written) return;
		load(this.controller, text);
	}

	private async write(config: BasesConfigFile): Promise<void> {
		const text = serializeBaseConfig(config);
		this.written = text;
		await this.controller.app.vault.modify(this.file, text);
	}
}

/** A `base` code block: the base's YAML is the block; edits rewrite it in the note. */
class BaseCodeBlock extends MarkdownRenderChild {
	private readonly controller: QueryController;
	private readonly writeSoon = debounce((config: BasesConfigFile) => void this.write(config), 1000, true);

	constructor(
		private readonly plugin: Bases,
		app: App,
		containerEl: HTMLElement,
		private source: string,
		private readonly sourcePath: string,
	) {
		super(containerEl);
		this.controller = new QueryController(app, { thisFile: app.vault.getFileByPath(sourcePath), save: (config) => this.writeSoon(config) });
	}

	override onload(): void {
		this.containerEl.addClass('bases-codeblock');
		this.addChild(this.controller);
		const container = new BasesContainer(this.controller.app, this.controller, this.containerEl, { registrations: () => this.plugin.registrations });
		this.addChild(container);
		this.register(this.plugin.track(container));
		load(this.controller, this.source);
	}

	private async write(config: BasesConfigFile): Promise<void> {
		const note = this.controller.app.vault.getFileByPath(this.sourcePath);
		if (!note) return;
		const next = serializeBaseConfig(config).replace(/\n$/, '');
		const previous = this.source;
		let found = false;
		await this.controller.app.vault.process(note, (text) => {
			const replaced = replaceCodeBlock(text, previous, next);
			found = replaced !== null;
			return replaced ?? text;
		});
		if (found) this.source = next;
		else new Notice('The base was changed in the note meanwhile; its new settings were not saved.');
	}
}

/** `text` with the `base` code block whose content is `previous` given `next` instead, or null if there is none. */
export function replaceCodeBlock(text: string, previous: string, next: string): string | null {
	const fence = /^([ \t]*)(`{3,}|~{3,})[ \t]*base[ \t]*\r?\n([\s\S]*?)\r?\n\1\2[ \t]*$/gm;
	for (let m = fence.exec(text); m; m = fence.exec(text)) {
		const indent = m[1]!;
		const content = m[3]!
			.split('\n')
			.map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
			.join('\n');
		if (content.replace(/\s+$/, '') !== previous.replace(/\s+$/, '')) continue;
		const start = m.index + m[0].indexOf('\n') + 1;
		const end = start + m[3]!.length;
		return text.slice(0, start) + next.split('\n').map((line) => (line ? indent + line : line)).join('\n') + text.slice(end);
	}
	return null;
}

