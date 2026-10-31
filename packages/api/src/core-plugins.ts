/**
 * Core plugins, as `app.internalPlugins`: `plugins[id]` is
 * `{ enabled, instance: { options } }`, the shape plugins read (Calendar,
 * Periodic Notes and Natural Language Dates read the daily-notes options,
 * QuickAdd the templates folder).
 *
 * Which core plugins are on is `<configDir>/core-plugins.json` (an object
 * `{ id: boolean }`, or a list of enabled ids in older vaults); each one's
 * options are `<configDir>/<id>.json`.
 *
 * Implemented: Daily notes (`daily-notes`) and Templates (`templates`).
 */

import { normalizePath, parseLinktext, TFile, TFolder, type EventRef } from '@emeraldmd/core';
import type { App } from './app';
import type { Command } from './commands';
import { HoverPopover, type HoverParent } from './hover-popover';
import { Keymap } from './keymap';
import { MarkdownRenderer, sectionText } from './markdown';
import { moment } from './moment';
import { Notice } from './notice';
import { FuzzySuggestModal } from './suggest';

type Moment = ReturnType<typeof moment>;

const VARIABLE = /{{\s*(date|time|title)\s*(?:([+-]\d+)\s*([yQMwdhms]))?\s*(?::\s*(.+?))?\s*}}/g;

export interface TemplateContext {
	/** The note's name, for `{{title}}`. */
	title: string;
	/** The date for `{{date}}`: the daily note's, or now. */
	date: Moment;
	dateFormat: string;
	timeFormat: string;
}

/**
 * Fills `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}`,
 * `{{time:FORMAT}}` and offsets such as `{{date+1d:FORMAT}}` (moment units).
 */
export function applyTemplateVariables(text: string, ctx: TemplateContext): string {
	return text.replace(VARIABLE, (_match, name: string, amount?: string, unit?: string, format?: string) => {
		if (name === 'title') return ctx.title;
		const base = (name === 'date' ? ctx.date : moment()).clone();
		if (amount && unit) base.add(Number(amount), unit as moment.unitOfTime.DurationConstructor);
		return base.format(format?.trim() || (name === 'date' ? ctx.dateFormat : ctx.timeFormat));
	});
}

/** The `.md` file for a path given without extension, as plugin options store templates. */
function noteAt(app: App, path: string): TFile | null {
	const clean = normalizePath(path.trim());
	if (!clean || clean === '/') return null;
	return app.vault.getFileByPath(clean.endsWith('.md') ? clean : `${clean}.md`);
}

export abstract class InternalPluginInstance {
	abstract readonly id: string;
	abstract readonly name: string;
	abstract readonly description: string;
	options: Record<string, unknown> = {};
	protected app!: App;
	private commandIds: string[] = [];
	private ribbonEls: HTMLElement[] = [];
	private eventRefs: EventRef[] = [];

	/** @internal */
	attach(app: App): void {
		this.app = app;
	}

	/** Registers commands and ribbon icons. */
	abstract onEnable(): void;

	/** @internal */
	disable(): void {
		for (const id of this.commandIds.splice(0)) this.app.commands.removeCommand(id);
		for (const el of this.ribbonEls.splice(0)) this.app.workspace.leftRibbon.removeRibbonItem(el);
		for (const ref of this.eventRefs.splice(0)) ref.e.offref(ref);
	}

	protected registerEvent(ref: EventRef): void {
		this.eventRefs.push(ref);
	}

	async saveOptions(): Promise<void> {
		await this.app.vault.adapter.write(`${this.app.vault.configDir}/${this.id}.json`, JSON.stringify(this.options, null, 2));
	}

	protected addCommand(command: Command): void {
		this.app.commands.addCommand(command);
		this.commandIds.push(command.id);
	}

	protected addRibbonIcon(icon: string, title: string, callback: () => unknown): void {
		this.ribbonEls.push(this.app.workspace.leftRibbon.addRibbonItemButton(`${this.id}:${title}`, icon, title, callback));
	}

	protected option(key: string, fallback: string): string {
		const value = this.options[key];
		return typeof value === 'string' && value.trim() ? value.trim() : fallback;
	}
}

/** Daily notes: one note per day, named by a date format, from an optional template. */
export class DailyNotes extends InternalPluginInstance {
	readonly id = 'daily-notes';
	readonly name = 'Daily notes';
	readonly description = "Open today's note, created from a template if you have one.";
	static readonly DEFAULT_FORMAT = 'YYYY-MM-DD';

	get format(): string {
		return this.option('format', DailyNotes.DEFAULT_FORMAT);
	}

	get folder(): string {
		return normalizePath(this.option('folder', '/')).replace(/^\/$/, '');
	}

	onEnable(): void {
		this.addCommand({ id: 'daily-notes', name: "Daily notes: Open today's daily note", callback: () => this.openDay(moment()) });
		this.addCommand({ id: 'daily-notes:goto-prev', name: 'Daily notes: Open previous daily note', callback: () => this.step(-1) });
		this.addCommand({ id: 'daily-notes:goto-next', name: 'Daily notes: Open next daily note', callback: () => this.step(1) });
		this.addRibbonIcon('calendar-days', "Open today's daily note", () => this.openDay(moment()));
	}

	/** The path of the daily note for `date`. */
	pathFor(date: Moment): string {
		const name = `${date.format(this.format)}.md`;
		return normalizePath(this.folder ? `${this.folder}/${name}` : name);
	}

	/** The note's date if `file` is a daily note. */
	dateOf(file: TFile): Moment | null {
		if (file.extension !== 'md') return null;
		const folder = file.parent && !file.parent.isRoot() ? file.parent.path : '';
		const expected = this.folder;
		// Formats may contain slashes ("YYYY/MM/YYYY-MM-DD"): compare against the path under the folder.
		const relative = file.path.slice(expected ? expected.length + 1 : 0, -'.md'.length);
		if (expected && !file.path.startsWith(`${expected}/`)) return null;
		if (!expected && folder && !this.format.includes('/')) return null;
		const date = moment(relative, this.format, true);
		return date.isValid() ? date : null;
	}

	/** Opens the daily note for `date`, creating it from the template first. */
	async openDay(date: Moment): Promise<TFile | null> {
		try {
			const file = this.app.vault.getFileByPath(this.pathFor(date)) ?? (await this.create(date));
			await this.app.workspace.getLeaf().openFile(file);
			return file;
		} catch (err) {
			new Notice(`Could not open the daily note: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	private async create(date: Moment): Promise<TFile> {
		const path = this.pathFor(date);
		const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		if (parent && !this.app.vault.getAbstractFileByPath(parent)) await this.app.vault.createFolder(parent);
		let content = '';
		const templatePath = this.option('template', '');
		if (templatePath) {
			const template = noteAt(this.app, templatePath);
			if (template) {
				content = applyTemplateVariables(await this.app.vault.read(template), {
					title: path.slice(path.lastIndexOf('/') + 1, -'.md'.length),
					date,
					dateFormat: this.format,
					timeFormat: 'HH:mm',
				});
			} else new Notice(`The daily note template "${templatePath}" was not found.`);
		}
		return this.app.vault.create(path, content);
	}

	/** Opens the existing daily note before (-1) or after (1) the open one, or today. */
	private async step(direction: 1 | -1): Promise<void> {
		const active = this.app.workspace.getActiveFile();
		const current = (active && this.dateOf(active)) ?? moment().startOf('day');
		const notes = this.app.vault
			.getMarkdownFiles()
			.map((file) => ({ file, date: this.dateOf(file) }))
			.filter((n): n is { file: TFile; date: Moment } => n.date !== null)
			.sort((a, b) => a.date.valueOf() - b.date.valueOf());
		const next = direction > 0 ? notes.find((n) => n.date.isAfter(current, 'day')) : [...notes].reverse().find((n) => n.date.isBefore(current, 'day'));
		if (!next) {
			new Notice(direction > 0 ? 'No later daily note.' : 'No earlier daily note.');
			return;
		}
		await this.app.workspace.getLeaf().openFile(next.file);
	}
}

/** Templates: insert a note from the templates folder, with its variables filled in. */
export class Templates extends InternalPluginInstance {
	readonly id = 'templates';
	readonly name = 'Templates';
	readonly description = 'Insert a note from your templates folder, with the date and title filled in.';

	get dateFormat(): string {
		return this.option('dateFormat', 'YYYY-MM-DD');
	}

	get timeFormat(): string {
		return this.option('timeFormat', 'HH:mm');
	}

	onEnable(): void {
		this.addCommand({
			id: 'insert-template',
			name: 'Templates: Insert template',
			editorCallback: () => this.chooseTemplate(),
		});
		this.addCommand({
			id: 'insert-current-date',
			name: 'Templates: Insert current date',
			editorCallback: (editor) => editor.replaceSelection(moment().format(this.dateFormat)),
		});
		this.addCommand({
			id: 'insert-current-time',
			name: 'Templates: Insert current time',
			editorCallback: (editor) => editor.replaceSelection(moment().format(this.timeFormat)),
		});
		this.addRibbonIcon('files', 'Insert template', () => this.chooseTemplate());
	}

	/** The notes in the templates folder (and its subfolders). */
	templateFiles(): TFile[] {
		const folderPath = normalizePath(this.option('folder', ''));
		const folder = folderPath && folderPath !== '/' ? this.app.vault.getFolderByPath(folderPath) : null;
		if (!folder) return [];
		const files: TFile[] = [];
		const walk = (f: TFolder) => {
			for (const child of f.children) {
				if (child instanceof TFolder) walk(child);
				else if (child instanceof TFile && child.extension === 'md') files.push(child);
			}
		};
		walk(folder);
		return files.sort((a, b) => a.path.localeCompare(b.path));
	}

	private chooseTemplate(): void {
		const files = this.templateFiles();
		if (!files.length) {
			new Notice(this.option('folder', '') ? 'No templates in the templates folder.' : 'Choose a templates folder in Settings → Templates first.');
			return;
		}
		new TemplatePicker(this.app, files, (file) => void this.insert(file)).open();
	}

	/** Inserts the template at the cursor of the active editor. */
	async insert(template: TFile): Promise<void> {
		const editor = this.app.workspace.activeEditor?.editor;
		if (!editor) return;
		const title = this.app.workspace.getActiveFile()?.basename ?? '';
		const text = applyTemplateVariables(await this.app.vault.read(template), {
			title,
			date: moment(),
			dateFormat: this.dateFormat,
			timeFormat: this.timeFormat,
		});
		editor.replaceSelection(text);
	}
}

class TemplatePicker extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly files: TFile[],
		private readonly choose: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder('Type to search templates…');
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(file: TFile): string {
		return file.basename;
	}

	onChooseItem(file: TFile): void {
		this.choose(file);
	}
}

/** An entry of `.obsidian/bookmarks.json`, in Obsidian's format. */
export interface BookmarkItem {
	type: 'file' | 'folder' | 'search' | 'heading' | 'block' | 'graph' | 'url' | 'group';
	ctime?: number;
	title?: string;
	path?: string;
	/** `#Heading` or `#^block`, for headings and blocks. */
	subpath?: string;
	query?: string;
	url?: string;
	/** Group members. */
	items?: BookmarkItem[];
}

/**
 * Bookmarks: notes, folders, headings, searches and links kept at hand,
 * stored in `.obsidian/bookmarks.json` as `{ "items": [...] }` (the plugin's
 * options file, as in Obsidian). Paths follow renames.
 */
export class Bookmarks extends InternalPluginInstance {
	readonly id = 'bookmarks';
	readonly name = 'Bookmarks';
	readonly description = 'Keep notes, folders, headings and searches at hand in the left sidebar.';
	private readonly listeners = new Set<() => void>();

	get items(): BookmarkItem[] {
		const items = this.options.items;
		if (!Array.isArray(items)) this.options.items = [];
		return this.options.items as BookmarkItem[];
	}

	onEnable(): void {
		this.addCommand({
			id: 'bookmarks:bookmark-current-view',
			name: 'Bookmarks: Bookmark current file',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) this.toggle(file);
				return true;
			},
		});
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: { addItem: (cb: (item: MenuItemLike) => unknown) => unknown }, file: TFile | TFolder) => {
				const marked = this.find(file.path) !== null;
				menu.addItem((item) =>
					item
						.setTitle(marked ? 'Remove bookmark' : 'Bookmark')
						.setIcon('bookmark')
						.setSection('action')
						.onClick(() => this.toggle(file)),
				);
			}),
		);
		this.registerEvent(this.app.vault.on('rename', (file: TFile | TFolder, oldPath: string) => this.followRename(oldPath, file.path)));
	}

	/** The bookmark of a file or folder (not of a heading in it), anywhere in groups. */
	find(path: string, items = this.items): BookmarkItem | null {
		for (const item of items) {
			if ((item.type === 'file' || item.type === 'folder') && item.path === path) return item;
			if (item.type === 'group') {
				const found = this.find(path, item.items ?? []);
				if (found) return found;
			}
		}
		return null;
	}

	/** Bookmarks the file or folder, or removes its bookmark. */
	toggle(file: TFile | TFolder): void {
		const existing = this.find(file.path);
		if (existing) this.remove(existing);
		else this.add({ type: file instanceof TFolder ? 'folder' : 'file', ctime: Date.now(), path: file.path });
	}

	add(item: BookmarkItem, group?: BookmarkItem): void {
		(group ? (group.items ??= []) : this.items).push(item);
		this.changed();
	}

	remove(item: BookmarkItem, items = this.items): boolean {
		const i = items.indexOf(item);
		if (i !== -1) {
			items.splice(i, 1);
			this.changed();
			return true;
		}
		return items.some((other) => other.type === 'group' && this.remove(item, other.items ?? []));
	}

	/** @internal Called when bookmarks change; returns an unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private followRename(oldPath: string, newPath: string): void {
		let moved = false;
		const walk = (items: BookmarkItem[]) => {
			for (const item of items) {
				if (item.path && (item.path === oldPath || item.path.startsWith(`${oldPath}/`))) {
					item.path = newPath + item.path.slice(oldPath.length);
					moved = true;
				}
				if (item.items) walk(item.items);
			}
		};
		walk(this.items);
		if (moved) this.changed();
	}

	private changed(): void {
		void this.saveOptions().catch((err: unknown) => console.error(err));
		for (const listener of this.listeners) listener();
	}
}

interface MenuItemLike {
	setTitle(title: string): MenuItemLike;
	setIcon(icon: string): MenuItemLike;
	setSection(section: string): MenuItemLike;
	onClick(cb: () => unknown): MenuItemLike;
}

/** What `hover-link` events carry (plugin API). */
export interface HoverLinkEvent {
	event: MouseEvent;
	/** Which kind of place the link is in: `preview`, `editor`, or a plugin's registered source. */
	source: string;
	hoverParent: HoverParent;
	targetEl: HTMLElement | null;
	linktext: string;
	sourcePath?: string;
}

/**
 * Page preview: hovering a link shows the note it points to (the heading's
 * section or the block for `#…` links). In the editor the ⌘/Ctrl key must be
 * held, as in Obsidian; sources registered by plugins say for themselves.
 */
export class PagePreview extends InternalPluginInstance {
	readonly id = 'page-preview';
	readonly name = 'Page preview';
	readonly description = 'See a note by hovering a link to it. In the editor, hold ⌘ (Ctrl) while hovering.';

	onEnable(): void {
		this.app.workspace.registerHoverLinkSource('preview', { display: 'Reading view', defaultMod: false });
		this.app.workspace.registerHoverLinkSource('editor', { display: 'Editor', defaultMod: true });
		this.registerEvent(this.app.workspace.on('hover-link', (info: HoverLinkEvent) => void this.onHoverLink(info)));
	}

	/** Whether `source` needs the ⌘/Ctrl key held. */
	requiresModifier(source: string): boolean {
		return this.app.workspace.hoverLinkSources[source]?.defaultMod ?? false;
	}

	async onHoverLink({ event, source, hoverParent, targetEl, linktext, sourcePath = '' }: HoverLinkEvent): Promise<void> {
		if (!hoverParent || !linktext) return;
		if (this.requiresModifier(source) && !(event && Keymap.isModifier(event, 'Mod'))) return;
		// Moving over the parts of the same link fires again: keep its popover.
		if (targetEl && hoverParent.hoverPopover?.targetEl === targetEl) return;
		const { path, subpath } = parseLinktext(linktext);
		const file = path ? this.app.metadataCache.getFirstLinkpathDest(path, sourcePath) : this.app.vault.getFileByPath(sourcePath);
		if (!file) return;
		const popover = new HoverPopover(hoverParent, targetEl);
		const embed = popover.hoverEl.createDiv({ cls: 'markdown-embed is-loaded', attr: { 'data-path': file.path } });
		const content = embed.createDiv('markdown-embed-content').createDiv('markdown-preview-view markdown-rendered');
		if (file.extension === 'md') {
			const text = sectionText(this.app, file, await this.app.vault.cachedRead(file), subpath);
			await MarkdownRenderer.render(this.app, text, content, file.path, popover);
		} else if (/^(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(file.extension)) {
			content.createEl('img', { attr: { src: this.app.vault.getResourcePath(file), alt: file.name } });
		} else {
			content.createDiv({ cls: 'file-embed-title', text: file.name });
		}
	}
}

/** A core plugin as plugins see it: `plugins[id].enabled` and `.instance`. */
export interface InternalPlugin {
	enabled: boolean;
	instance: InternalPluginInstance;
}

/** Core plugins that are on in a new vault. */
const ENABLED_BY_DEFAULT = new Set(['daily-notes', 'templates', 'page-preview', 'bookmarks', 'file-recovery', 'note-composer', 'bases']);

/** The core plugins defined here (app.ts adds those in their own modules). */
export function defaultCorePlugins(): InternalPluginInstance[] {
	return [new DailyNotes(), new Templates(), new PagePreview(), new Bookmarks()];
}

export class InternalPlugins {
	plugins: Record<string, InternalPlugin> = {};
	/** core-plugins.json as read, by id. */
	config: Record<string, boolean> = {};
	private app: App | null = null;

	constructor(instances: InternalPluginInstance[] = defaultCorePlugins()) {
		for (const instance of instances) this.plugins[instance.id] = { enabled: false, instance };
	}

	getPluginById(id: string): InternalPlugin | null {
		return this.plugins[id] ?? null;
	}

	/** The plugin's instance, if it is on. */
	getEnabledPluginById(id: string): InternalPluginInstance | null {
		const plugin = this.plugins[id];
		return plugin?.enabled ? plugin.instance : null;
	}

	getEnabledPlugins(): InternalPluginInstance[] {
		return Object.values(this.plugins)
			.filter((p) => p.enabled)
			.map((p) => p.instance);
	}

	/** @internal Reads which core plugins are on and their options, and turns them on. */
	async load(app: App): Promise<void> {
		this.app = app;
		const adapter = app.vault.adapter;
		const read = async (name: string): Promise<unknown> => {
			const path = `${app.vault.configDir}/${name}`;
			try {
				return (await adapter.exists(path)) ? (JSON.parse(await adapter.read(path)) as unknown) : null;
			} catch (err) {
				console.error(`Could not read ${path}`, err);
				return null;
			}
		};
		const saved = await read('core-plugins.json');
		if (Array.isArray(saved)) this.config = Object.fromEntries(saved.filter((id): id is string => typeof id === 'string').map((id) => [id, true]));
		else if (saved && typeof saved === 'object') this.config = Object.fromEntries(Object.entries(saved).filter(([, on]) => typeof on === 'boolean')) as Record<string, boolean>;
		for (const [id, plugin] of Object.entries(this.plugins)) {
			plugin.instance.attach(app);
			const options = await read(`${id}.json`);
			if (options && typeof options === 'object' && !Array.isArray(options)) plugin.instance.options = options as Record<string, unknown>;
			// Core plugins newer than the vault's core-plugins.json start as they do in a new vault.
			const unlisted = saved === null || (!Array.isArray(saved) && !(id in this.config));
			const on = unlisted ? ENABLED_BY_DEFAULT.has(id) : this.config[id] === true;
			if (on) this.enable(id);
		}
	}

	/** Turns a core plugin on or off and saves the choice in core-plugins.json. */
	async setEnabled(id: string, on: boolean): Promise<void> {
		if (!this.plugins[id] || !this.app) return;
		if (on) this.enable(id);
		else this.disable(id);
		this.config[id] = on;
		for (const [other, plugin] of Object.entries(this.plugins)) this.config[other] = plugin.enabled;
		await this.app.vault.adapter.write(`${this.app.vault.configDir}/core-plugins.json`, JSON.stringify(this.config, null, 2));
	}

	private enable(id: string): void {
		const plugin = this.plugins[id]!;
		if (plugin.enabled) return;
		plugin.enabled = true;
		try {
			plugin.instance.onEnable();
		} catch (err) {
			console.error(`Core plugin ${id} failed to start`, err);
		}
	}

	private disable(id: string): void {
		const plugin = this.plugins[id]!;
		if (!plugin.enabled) return;
		plugin.enabled = false;
		plugin.instance.disable();
	}
}
