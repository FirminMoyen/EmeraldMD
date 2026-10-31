/**
 * A base's query: the vault's files that pass its filters (and the view's),
 * with their formulas, sorted, limited and grouped as the view says, and
 * summaries of columns. `QueryController` keeps the result current as the
 * vault changes and hands it to the view; the settings live in the `.base`
 * file (or `base` code block) in Obsidian's format.
 */

import { normalizePath, type TFile } from '@emeraldmd/core';
import type { App } from '../app';
import { Component } from '../component';
import { debounce, parseYaml, stringifyYaml } from '../util';
import { evaluateFormula, FormulaError, parseFormula, type EvalContext, fileProperty, noteProperty, type FormulaNode } from './formula';
import { BooleanValue, compareValues, DateValue, DurationValue, ErrorValue, ListValue, NullValue, NumberValue, StringValue, toNumber, Value } from './values';

export type BasesPropertyType = 'note' | 'formula' | 'file';
export type BasesPropertyId = `${BasesPropertyType}.${string}`;

export type BasesConfigFileFilter = string | { and: BasesConfigFileFilter[] } | { or: BasesConfigFileFilter[] } | { not: BasesConfigFileFilter[] };

export interface BasesConfigFileView {
	type: string;
	name: string;
	filters?: BasesConfigFileFilter;
	groupBy?: { property?: string; direction?: string };
	groupOrder?: unknown[];
	order?: string[];
	sort?: { property: string; direction?: string }[];
	limit?: number;
	summaries?: Record<string, string>;
	[key: string]: unknown;
}

export interface BasesConfigFile {
	filters?: BasesConfigFileFilter;
	properties?: Record<string, Record<string, unknown>>;
	formulas?: Record<string, string>;
	summaries?: Record<string, string>;
	views?: BasesConfigFileView[];
	[key: string]: unknown;
}

export interface BasesSortConfig {
	property: BasesPropertyId;
	direction: 'ASC' | 'DESC';
}

/** `status` and `note.status` are the same property; `file.` and `formula.` ids are kept. */
export function normalizePropertyId(id: string): BasesPropertyId {
	const text = id.trim();
	return /^(note|formula|file)\./.test(text) ? (text as BasesPropertyId) : `note.${text}`;
}

export function parsePropertyId(propertyId: string): { type: BasesPropertyType; name: string } {
	const id = normalizePropertyId(propertyId);
	const dot = id.indexOf('.');
	return { type: id.slice(0, dot) as BasesPropertyType, name: id.slice(dot + 1) };
}

/** The settings in a `.base` file; throws on YAML that is not a base. */
export function parseBaseConfig(text: string): BasesConfigFile {
	const data = text.trim() ? parseYaml(text) : null;
	if (data === null || data === undefined) return {};
	if (typeof data !== 'object' || Array.isArray(data)) throw new Error('A base is YAML with filters, formulas, properties and views.');
	const config = data as BasesConfigFile;
	if (config.views !== undefined && !Array.isArray(config.views)) throw new Error('"views" must be a list.');
	config.views = (config.views ?? []).filter((v): v is BasesConfigFileView => !!v && typeof v === 'object' && !Array.isArray(v));
	for (const [i, view] of config.views.entries()) {
		if (typeof view.type !== 'string' || !view.type) view.type = 'table';
		if (typeof view.name !== 'string' || !view.name) view.name = i ? `${capitalize(view.type)} ${i + 1}` : capitalize(view.type);
	}
	return config;
}

export function serializeBaseConfig(config: BasesConfigFile): string {
	const out: BasesConfigFile = { ...config };
	for (const key of ['filters', 'formulas', 'properties', 'summaries'] as const) {
		const value = out[key];
		if (value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value) && !Object.keys(value).length)) delete out[key];
	}
	return stringifyYaml(out);
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Whether a file passes a filter: an expression, or `and`/`or`/`not` lists of them. */
export function evaluateFilter(filter: BasesConfigFileFilter | undefined | null, ctx: EvalContext): boolean {
	if (filter === undefined || filter === null) return true;
	if (typeof filter === 'string') return filter.trim() ? evaluateFormula(filter, ctx).isTruthy() : true;
	if (typeof filter !== 'object') return Boolean(filter);
	if ('and' in filter && Array.isArray(filter.and)) return filter.and.every((f) => evaluateFilter(f, ctx));
	if ('or' in filter && Array.isArray(filter.or)) return filter.or.length === 0 || filter.or.some((f) => evaluateFilter(f, ctx));
	if ('not' in filter && Array.isArray(filter.not)) return !filter.not.some((f) => evaluateFilter(f, ctx));
	return true;
}

/** The messages of filter expressions that do not parse. */
export function filterErrors(filter: BasesConfigFileFilter | undefined | null): string[] {
	if (!filter) return [];
	if (typeof filter === 'string') {
		try {
			parseFormula(filter);
			return [];
		} catch (err) {
			return [`${filter}: ${(err as Error).message}`];
		}
	}
	const list = 'and' in filter ? filter.and : 'or' in filter ? filter.or : 'not' in filter ? filter.not : [];
	return Array.isArray(list) ? list.flatMap(filterErrors) : [];
}

function numbers(values: Value[]): number[] {
	return values.filter((v) => !(v instanceof NullValue) && !(v instanceof DateValue)).map(toNumber).filter((n) => !Number.isNaN(n));
}

function dates(values: Value[]): Date[] {
	return values.filter((v): v is DateValue => v instanceof DateValue).map((v) => v.date);
}

const isEmpty = (v: Value) => v instanceof NullValue || (v instanceof StringValue && v.value === '') || (v instanceof ListValue && v.length() === 0);

/** The built-in summaries, by the name stored in the base. */
export const SUMMARIES: Record<string, (values: Value[]) => Value> = {
	Average: (values) => {
		const n = numbers(values);
		return n.length ? new NumberValue(n.reduce((a, b) => a + b, 0) / n.length) : NullValue.value;
	},
	Median: (values) => {
		const n = numbers(values).sort((a, b) => a - b);
		if (!n.length) return NullValue.value;
		const mid = Math.floor(n.length / 2);
		return new NumberValue(n.length % 2 ? n[mid]! : (n[mid - 1]! + n[mid]!) / 2);
	},
	Min: (values) => {
		const n = numbers(values);
		return n.length ? new NumberValue(Math.min(...n)) : NullValue.value;
	},
	Max: (values) => {
		const n = numbers(values);
		return n.length ? new NumberValue(Math.max(...n)) : NullValue.value;
	},
	Sum: (values) => new NumberValue(numbers(values).reduce((a, b) => a + b, 0)),
	Range: (values) => {
		const d = dates(values);
		if (d.length) return DurationValue.fromMilliseconds(Math.max(...d.map(Number)) - Math.min(...d.map(Number)));
		const n = numbers(values);
		return n.length ? new NumberValue(Math.max(...n) - Math.min(...n)) : NullValue.value;
	},
	Stddev: (values) => {
		const n = numbers(values);
		if (!n.length) return NullValue.value;
		const mean = n.reduce((a, b) => a + b, 0) / n.length;
		return new NumberValue(Math.sqrt(n.reduce((a, b) => a + (b - mean) ** 2, 0) / n.length));
	},
	Earliest: (values) => {
		const d = dates(values);
		return d.length ? new DateValue(new Date(Math.min(...d.map(Number)))) : NullValue.value;
	},
	Latest: (values) => {
		const d = dates(values);
		return d.length ? new DateValue(new Date(Math.max(...d.map(Number)))) : NullValue.value;
	},
	Checked: (values) => new NumberValue(values.filter((v) => v instanceof BooleanValue && v.value).length),
	Unchecked: (values) => new NumberValue(values.filter((v) => v instanceof BooleanValue && !v.value).length),
	Empty: (values) => new NumberValue(values.filter(isEmpty).length),
	Filled: (values) => new NumberValue(values.filter((v) => !isEmpty(v)).length),
	Unique: (values) => new NumberValue(values.filter((v, i) => !isEmpty(v) && values.findIndex((o) => Value.looseEquals(o, v)) === i).length),
};

/** A row: a file, with its properties and formulas. */
export class BasesEntry {
	constructor(
		private readonly controller: QueryController,
		readonly file: TFile,
	) {}

	getValue(propertyId: BasesPropertyId): Value | null {
		return this.controller.valueOf(this.file, propertyId);
	}
}

/** The entries with one value of the view's `groupBy` property (`key` is NullValue for those without). */
export class BasesEntryGroup {
	constructor(
		readonly key: Value | undefined,
		readonly entries: BasesEntry[],
	) {}

	hasKey(): boolean {
		return !!this.key && !(this.key instanceof NullValue);
	}
}

export class BasesQueryResult {
	constructor(
		private readonly controller: QueryController,
		readonly data: BasesEntry[],
		private readonly groups: BasesEntryGroup[],
	) {}

	get groupedData(): BasesEntryGroup[] {
		return this.groups;
	}

	get properties(): BasesPropertyId[] {
		return this.controller.viewConfig.getOrder();
	}

	getSummaryValue(queryController: QueryController, entries: BasesEntry[], prop: BasesPropertyId, summaryKey: string): Value {
		return queryController.summarize(entries, prop, summaryKey);
	}
}

const FILE_PROPERTY_NAMES: Record<string, string> = {
	name: 'file name',
	basename: 'file basename',
	path: 'file path',
	folder: 'folder',
	ext: 'file extension',
	size: 'file size',
	ctime: 'created time',
	mtime: 'modified time',
	tags: 'file tags',
	links: 'file links',
	backlinks: 'backlinks',
	embeds: 'embeds',
	properties: 'properties',
};

export const FILE_PROPERTIES = Object.keys(FILE_PROPERTY_NAMES).filter((p) => p !== 'properties').map((p) => `file.${p}` as BasesPropertyId);

/** One entry of `views`, with the accessors plugins' views use. */
export class BasesViewConfig {
	constructor(
		private readonly controller: QueryController,
		/** @internal */ readonly data: BasesConfigFileView,
	) {}

	get name(): string {
		return this.data.name;
	}

	set name(name: string) {
		this.data.name = name;
	}

	get(key: string): unknown {
		return this.data[key];
	}

	getAsPropertyId(key: string): BasesPropertyId | null {
		const value = this.data[key];
		return typeof value === 'string' && value.trim() ? normalizePropertyId(value) : null;
	}

	getEvaluatedFormula(_view: unknown, key: string): Value {
		const value = this.data[key];
		if (typeof value !== 'string' || !value.trim()) return NullValue.value;
		const result = evaluateFormula(value, this.controller.context(this.controller.thisFile));
		return result instanceof ErrorValue ? NullValue.value : result;
	}

	set(key: string, value: unknown): void {
		if (value === null || value === undefined) delete this.data[key];
		else this.data[key] = value;
		this.controller.changed();
	}

	getOrder(): BasesPropertyId[] {
		const order = Array.isArray(this.data.order) ? this.data.order : [];
		return order.filter((id): id is string => typeof id === 'string' && !!id.trim()).map(normalizePropertyId);
	}

	getSort(): BasesSortConfig[] {
		const sort = Array.isArray(this.data.sort) ? this.data.sort : [];
		return sort
			.filter((s) => s && typeof s === 'object' && typeof s.property === 'string' && s.property.trim())
			.map((s) => ({ property: normalizePropertyId(s.property), direction: String(s.direction ?? 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC' }));
	}

	getDisplayName(propertyId: BasesPropertyId): string {
		const id = normalizePropertyId(propertyId);
		const { type, name } = parsePropertyId(id);
		const properties = this.controller.config.properties ?? {};
		const configured = properties[id]?.displayName ?? (type === 'note' ? properties[name]?.displayName : undefined);
		if (typeof configured === 'string' && configured.trim()) return configured;
		return type === 'file' ? (FILE_PROPERTY_NAMES[name] ?? name) : name;
	}
}

export interface QueryControllerOptions {
	/** The `.base` file, when the base is one. */
	file?: TFile | null;
	/** `this` in formulas. */
	thisFile?: TFile | null;
	/** The view to show first, by name. */
	viewName?: string | null;
	/** Writes the settings after an edit from the toolbar or a view. */
	save?: (config: BasesConfigFile) => void;
}

const DEFAULT_VIEW: BasesConfigFileView = { type: 'table', name: 'Table' };

/** Runs the base's query and tells its view when the result changes. */
export class QueryController extends Component {
	config: BasesConfigFile = {};
	/** Why the settings could not be read, if they could not. */
	error: string | null = null;
	file: TFile | null;
	thisFile: TFile | null;
	viewName: string | null;
	result: BasesQueryResult;
	allProperties: BasesPropertyId[] = [];
	private readonly save: ((config: BasesConfigFile) => void) | null;
	private readonly listeners = new Set<() => void>();
	private readonly viewConfigs = new WeakMap<BasesConfigFileView, BasesViewConfig>();
	private formulaCache = new Map<string, Value>();
	private readonly evaluating = new Set<string>();
	private readonly requestRun = debounce(() => this.run(), 250, true);

	constructor(
		readonly app: App,
		options: QueryControllerOptions = {},
	) {
		super();
		this.file = options.file ?? null;
		this.thisFile = options.thisFile ?? options.file ?? null;
		this.viewName = options.viewName ?? null;
		this.save = options.save ?? null;
		this.result = new BasesQueryResult(this, [], [new BasesEntryGroup(undefined, [])]);
	}

	override onload(): void {
		const { vault, metadataCache } = this.app;
		this.registerEvent(metadataCache.on('resolved', () => this.requestRun()));
		for (const name of ['create', 'delete', 'rename'] as const) this.registerEvent(vault.on(name, () => this.requestRun()));
		this.registerEvent(this.app.metadataTypeManager.on('changed', () => this.requestRun()));
	}

	/** Shows new settings (`error`: why they could not be read). */
	setConfig(config: BasesConfigFile, error: string | null = null): void {
		this.config = config;
		this.error = error;
		this.run();
	}

	setThisFile(file: TFile | null): void {
		if (file === this.thisFile) return;
		this.thisFile = file;
		this.run();
	}

	get views(): BasesConfigFileView[] {
		if (!Array.isArray(this.config.views) || !this.config.views.length) this.config.views = [{ ...DEFAULT_VIEW }];
		return this.config.views;
	}

	/** The view shown: the one named `viewName`, or the first. */
	get view(): BasesConfigFileView {
		const views = this.views;
		return views.find((v) => v.name === this.viewName) ?? views[0]!;
	}

	get viewConfig(): BasesViewConfig {
		const data = this.view;
		let config = this.viewConfigs.get(data);
		if (!config) this.viewConfigs.set(data, (config = new BasesViewConfig(this, data)));
		return config;
	}

	selectView(name: string): void {
		this.viewName = name;
		this.run();
	}

	onUpdate(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** The settings were edited: run again and save them. */
	changed(): void {
		this.run();
		this.save?.(this.config);
	}

	/** The context formulas are evaluated in, for `file`'s row. */
	context(file: TFile | null): EvalContext {
		return { app: this.app, file, thisFile: this.thisFile, formula: (name, f) => this.formulaValue(name, f) };
	}

	valueOf(file: TFile, propertyId: BasesPropertyId): Value {
		const { type, name } = parsePropertyId(propertyId);
		if (type === 'file') return fileProperty(this.app, file, name);
		if (type === 'formula') return this.formulaValue(name, file);
		return noteProperty(this.app, file, name);
	}

	private formulaValue(name: string, file: TFile | null): Value {
		const source = this.config.formulas?.[name];
		if (typeof source !== 'string') return NullValue.value;
		const key = `${file?.path ?? ''}\0${name}`;
		const cached = this.formulaCache.get(key);
		if (cached) return cached;
		if (this.evaluating.has(key)) return new ErrorValue(`The formula "${name}" uses itself`);
		this.evaluating.add(key);
		try {
			const value = evaluateFormula(source, this.context(file));
			this.formulaCache.set(key, value);
			return value;
		} finally {
			this.evaluating.delete(key);
		}
	}

	summarize(entries: BasesEntry[], prop: BasesPropertyId, summaryKey: string): Value {
		const values = entries.map((e) => e.getValue(prop) ?? NullValue.value);
		const custom = this.config.summaries?.[summaryKey];
		if (typeof custom === 'string') return evaluateFormula(custom, { ...this.context(null), locals: { values: new ListValue([...values]) } });
		const builtIn = SUMMARIES[summaryKey] ?? Object.entries(SUMMARIES).find(([k]) => k.toLowerCase() === summaryKey.toLowerCase())?.[1];
		return builtIn ? builtIn(values) : NullValue.value;
	}

	/** Runs the query now. */
	run(): void {
		this.formulaCache = new Map();
		const view = this.view;
		const viewConfig = this.viewConfig;
		let entries: BasesEntry[] = [];
		if (!this.error) {
			for (const file of this.app.vault.getFiles()) {
				const ctx = this.context(file);
				if (evaluateFilter(this.config.filters, ctx) && evaluateFilter(view.filters, ctx)) entries.push(new BasesEntry(this, file));
			}
		}
		const sort = viewConfig.getSort();
		if (sort.length) {
			const keys = new Map(entries.map((e) => [e, sort.map((s) => e.getValue(s.property) ?? NullValue.value)]));
			entries.sort((a, b) => {
				for (const [i, s] of sort.entries()) {
					const x = keys.get(a)![i]!;
					const y = keys.get(b)![i]!;
					const empty = (v: Value) => v instanceof NullValue || v instanceof ErrorValue;
					// Empty values go last whichever the direction.
					if (empty(x) || empty(y)) {
						if (empty(x) !== empty(y)) return empty(x) ? 1 : -1;
						continue;
					}
					const order = compareValues(x, y);
					if (order) return s.direction === 'DESC' ? -order : order;
				}
				return a.file.path.localeCompare(b.file.path);
			});
		} else entries.sort((a, b) => a.file.path.localeCompare(b.file.path));
		const limit = Number(view.limit);
		if (Number.isFinite(limit) && limit > 0) entries = entries.slice(0, Math.floor(limit));
		this.result = new BasesQueryResult(this, entries, this.group(entries, view));
		this.allProperties = this.propertiesOf(entries);
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch (err) {
				console.error(err);
			}
		}
	}

	private group(entries: BasesEntry[], view: BasesConfigFileView): BasesEntryGroup[] {
		const property = typeof view.groupBy?.property === 'string' && view.groupBy.property.trim() ? normalizePropertyId(view.groupBy.property) : null;
		if (!property) return [new BasesEntryGroup(undefined, entries)];
		const groups: { key: Value; entries: BasesEntry[] }[] = [];
		for (const entry of entries) {
			const key = entry.getValue(property) ?? NullValue.value;
			const group = groups.find((g) => Value.looseEquals(g.key, key));
			if (group) group.entries.push(entry);
			else groups.push({ key, entries: [entry] });
		}
		const desc = String(view.groupBy?.direction ?? 'ASC').toUpperCase() === 'DESC';
		groups.sort((a, b) => {
			if (a.key instanceof NullValue || b.key instanceof NullValue) return a.key instanceof NullValue ? 1 : -1;
			const order = compareValues(a.key, b.key);
			return desc ? -order : order;
		});
		let shown = groups;
		if (Array.isArray(view.groupOrder)) {
			shown = [];
			for (const wanted of view.groupOrder) {
				const key = wanted === null ? NullValue.value : noteKey(wanted);
				const group = groups.find((g) => (key instanceof NullValue ? g.key instanceof NullValue : Value.looseEquals(g.key, key)));
				if (group && !shown.includes(group)) shown.push(group);
			}
		}
		return shown.map((g) => new BasesEntryGroup(g.key, g.entries));
	}

	/** Properties to offer in menus: the file's, the notes' (in these entries), formulas, and those shown. */
	private propertiesOf(entries: BasesEntry[]): BasesPropertyId[] {
		const ids = new Set<BasesPropertyId>(FILE_PROPERTIES);
		const notes = new Map<string, BasesPropertyId>();
		for (const entry of entries) {
			const fm = this.app.metadataCache.getFileCache(entry.file)?.frontmatter;
			for (const key of Object.keys(fm ?? {})) if (!notes.has(key.toLowerCase())) notes.set(key.toLowerCase(), `note.${key}`);
		}
		for (const id of [...notes.values()].sort((a, b) => a.localeCompare(b))) ids.add(id);
		for (const name of Object.keys(this.config.formulas ?? {})) ids.add(`formula.${name}`);
		for (const id of this.viewConfig.getOrder()) ids.add(id);
		return [...ids];
	}

	/**
	 * Creates a note for the view and opens it: in the folder the filters ask
	 * for, with the properties and tags their `==` and `hasTag` require.
	 */
	async createFile(baseFileName?: string, frontmatterProcessor?: (frontmatter: Record<string, unknown>, file: TFile) => void): Promise<TFile | null> {
		const app = this.app;
		const wanted = requiredByFilters([this.config.filters, this.view.filters]);
		const folder = wanted.folder !== null ? normalizePath(wanted.folder) : app.fileManager.getNewFileParent(this.file?.path ?? this.thisFile?.path ?? '').path;
		const name = (baseFileName ?? 'Untitled').replace(/[\\/:]/g, '-').trim() || 'Untitled';
		const path = app.vault.getAvailablePath(folder && folder !== '/' ? `${folder}/${name}` : name, 'md');
		if (folder && folder !== '/' && !app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
		const file = await app.vault.create(path, '');
		if (Object.keys(wanted.properties).length || wanted.tags.length || frontmatterProcessor) {
			await app.fileManager.processFrontMatter(file, (fm) => {
				Object.assign(fm, wanted.properties);
				if (wanted.tags.length) fm.tags = wanted.tags;
				frontmatterProcessor?.(fm, file);
			});
		}
		await app.workspace.getLeaf('tab').openFile(file);
		return file;
	}
}

function noteKey(value: unknown): Value {
	if (typeof value === 'string') {
		const date = DateValue.parseFromString(value);
		if (date) return date;
	}
	if (value === null || value === undefined) return NullValue.value;
	return value instanceof Value ? value : new StringValue(String(value));
}

/** What a new note needs to pass the filters: `prop == value`, `file.hasTag(…)`, `file.inFolder(…)` among `and`ed filters. */
function requiredByFilters(filters: (BasesConfigFileFilter | undefined)[]): { properties: Record<string, unknown>; tags: string[]; folder: string | null } {
	const out = { properties: {} as Record<string, unknown>, tags: [] as string[], folder: null as string | null };
	const literal = (node: FormulaNode): unknown => {
		if (node.t !== 'lit') return undefined;
		const v = node.v;
		if (v instanceof NumberValue || v instanceof BooleanValue || v instanceof StringValue) return v.value;
		return undefined;
	};
	const propertyName = (node: FormulaNode): string | null => {
		if (node.t === 'id' && !['file', 'note', 'formula', 'this'].includes(node.name)) return node.name;
		if (node.t === 'member' && node.obj.t === 'id' && node.obj.name === 'note') return node.name;
		return null;
	};
	const visit = (filter: BasesConfigFileFilter | undefined) => {
		if (!filter) return;
		if (typeof filter === 'object') {
			if ('and' in filter && Array.isArray(filter.and)) filter.and.forEach(visit);
			return;
		}
		let node: FormulaNode;
		try {
			node = parseFormula(filter);
		} catch (err) {
			if (err instanceof FormulaError) return;
			throw err;
		}
		if (node.t === 'binary' && node.op === '==' && node.l.t === 'member' && node.l.obj.t === 'id' && node.l.obj.name === 'file' && node.l.name === 'folder') {
			const folder = literal(node.r);
			if (typeof folder === 'string') out.folder = folder;
		} else if (node.t === 'binary' && node.op === '==') {
			const [prop, value] = propertyName(node.l) ? [propertyName(node.l), literal(node.r)] : [propertyName(node.r), literal(node.l)];
			if (prop && value !== undefined) out.properties[prop] = value;
		} else if (node.t === 'method' && node.obj.t === 'id' && node.obj.name === 'file') {
			const args = node.args.map(literal).filter((a): a is string => typeof a === 'string');
			if (node.name === 'hasTag') out.tags.push(...args.map((t) => t.replace(/^#/, '')));
			if (node.name === 'inFolder' && args[0]) out.folder = args[0];
		}
	};
	filters.forEach(visit);
	return out;
}
