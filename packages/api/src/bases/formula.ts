/**
 * The formula language of Bases (filters, formulas, summaries), from
 * Obsidian's public documentation: literals, `note`/`file`/`formula`/`this`
 * properties, arithmetic with dates and durations (`now() - "1 week"`),
 * comparisons, `&&`/`||`/`!`, functions (`if`, `date`, `link`…) and the
 * methods of each type (`file.hasTag("a")`, `list.filter(value > 2)`…).
 *
 * `parseFormula` turns a formula into a tree (cached per text);
 * `evaluate` computes it in a context: the row's file and `this`.
 */

import { normalizePath, type TFile } from '@emeraldmd/core';
import type { App } from '../app';
import { moment } from '../moment';
import { getAllTags } from '../util';
import {
	BooleanValue,
	DateValue,
	displayText,
	DurationValue,
	ErrorValue,
	FileValue,
	HTMLValue,
	IconValue,
	ImageValue,
	LinkValue,
	ListValue,
	NotNullValue,
	NullValue,
	NumberValue,
	ObjectValue,
	RegExpValue,
	RelativeDateValue,
	StringValue,
	TagValue,
	toNumber,
	Value,
	compareValues,
	wrapValue,
} from './values';

export type FormulaNode =
	| { t: 'lit'; v: Value }
	| { t: 'id'; name: string }
	| { t: 'member'; obj: FormulaNode; name: string }
	| { t: 'index'; obj: FormulaNode; index: FormulaNode }
	| { t: 'call'; name: string; args: FormulaNode[] }
	| { t: 'method'; obj: FormulaNode; name: string; args: FormulaNode[] }
	| { t: 'unary'; op: '!' | '-'; arg: FormulaNode }
	| { t: 'binary'; op: string; l: FormulaNode; r: FormulaNode }
	| { t: 'list'; items: FormulaNode[] }
	| { t: 'object'; entries: [string, FormulaNode][] };

export class FormulaError extends Error {}

type Token = { k: 'num' | 'str' | 'id' | 'op' | 'regex' | 'eof'; v: string; flags?: string; pos: number };

const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')', '[', ']', '{', '}', ',', '.', ':'];

function tokenize(src: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	const operandAllowed = () => {
		const prev = out[out.length - 1];
		return !prev || (prev.k === 'op' && ![')', ']', '}'].includes(prev.v));
	};
	while (i < src.length) {
		const c = src[i]!;
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? '') && operandAllowed())) {
			const m = /^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i))!;
			out.push({ k: 'num', v: m[0], pos: i });
			i += m[0].length;
			continue;
		}
		if (c === '"' || c === "'") {
			let j = i + 1;
			let text = '';
			while (j < src.length && src[j] !== c) {
				if (src[j] === '\\' && j + 1 < src.length) {
					const e = src[++j]!;
					text += e === 'n' ? '\n' : e === 't' ? '\t' : e;
				} else text += src[j];
				j++;
			}
			if (j >= src.length) throw new FormulaError(`Unterminated string at ${i + 1}`);
			out.push({ k: 'str', v: text, pos: i });
			i = j + 1;
			continue;
		}
		if (c === '/' && operandAllowed()) {
			let j = i + 1;
			let inClass = false;
			while (j < src.length && (src[j] !== '/' || inClass)) {
				if (src[j] === '\\') j++;
				else if (src[j] === '[') inClass = true;
				else if (src[j] === ']') inClass = false;
				j++;
			}
			if (j >= src.length) throw new FormulaError(`Unterminated regular expression at ${i + 1}`);
			const flags = /^[dgimsuvy]*/.exec(src.slice(j + 1))![0];
			out.push({ k: 'regex', v: src.slice(i + 1, j), flags, pos: i });
			i = j + 1 + flags.length;
			continue;
		}
		const id = /^[\p{L}_$][\p{L}\p{N}_$]*/u.exec(src.slice(i));
		if (id) {
			out.push({ k: 'id', v: id[0], pos: i });
			i += id[0].length;
			continue;
		}
		const op = OPERATORS.find((o) => src.startsWith(o, i));
		if (!op) throw new FormulaError(`Unexpected "${c}" at ${i + 1}`);
		out.push({ k: 'op', v: op, pos: i });
		i += op.length;
	}
	out.push({ k: 'eof', v: '', pos: src.length });
	return out;
}

const BINARY: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

class Parser {
	private i = 0;

	constructor(private readonly tokens: Token[]) {}

	parse(): FormulaNode {
		const node = this.expression(0);
		const rest = this.peek();
		if (rest.k !== 'eof') throw new FormulaError(`Unexpected "${rest.v}" at ${rest.pos + 1}`);
		return node;
	}

	private peek(): Token {
		return this.tokens[this.i]!;
	}

	private next(): Token {
		return this.tokens[this.i++]!;
	}

	private isOp(v: string): boolean {
		const t = this.peek();
		return t.k === 'op' && t.v === v;
	}

	private expect(v: string): void {
		const t = this.next();
		if (t.k !== 'op' || t.v !== v) throw new FormulaError(t.k === 'eof' ? `Expected "${v}" at the end` : `Expected "${v}" at ${t.pos + 1}`);
	}

	private expression(minPrecedence: number): FormulaNode {
		let left = this.unary();
		for (;;) {
			const t = this.peek();
			const precedence = t.k === 'op' ? BINARY[t.v] : undefined;
			if (precedence === undefined || precedence <= minPrecedence) return left;
			this.next();
			left = { t: 'binary', op: t.v, l: left, r: this.expression(precedence) };
		}
	}

	private unary(): FormulaNode {
		if (this.isOp('!') || this.isOp('-')) {
			const op = this.next().v as '!' | '-';
			return { t: 'unary', op, arg: this.unary() };
		}
		if (this.isOp('+')) {
			this.next();
			return this.unary();
		}
		return this.postfix(this.primary());
	}

	private args(close: string): FormulaNode[] {
		const args: FormulaNode[] = [];
		if (this.isOp(close)) {
			this.next();
			return args;
		}
		for (;;) {
			args.push(this.expression(0));
			if (this.isOp(',')) {
				this.next();
				if (this.isOp(close)) break;
				continue;
			}
			break;
		}
		this.expect(close);
		return args;
	}

	private postfix(node: FormulaNode): FormulaNode {
		for (;;) {
			if (this.isOp('.')) {
				this.next();
				const name = this.next();
				if (name.k !== 'id') throw new FormulaError(`Expected a name after "." at ${name.pos + 1}`);
				if (this.isOp('(')) {
					this.next();
					node = { t: 'method', obj: node, name: name.v, args: this.args(')') };
				} else node = { t: 'member', obj: node, name: name.v };
			} else if (this.isOp('[')) {
				this.next();
				const index = this.expression(0);
				this.expect(']');
				node = { t: 'index', obj: node, index };
			} else return node;
		}
	}

	private primary(): FormulaNode {
		const t = this.next();
		switch (t.k) {
			case 'num':
				return { t: 'lit', v: new NumberValue(Number(t.v)) };
			case 'str':
				return { t: 'lit', v: new StringValue(t.v) };
			case 'regex':
				try {
					return { t: 'lit', v: new RegExpValue(new RegExp(t.v, t.flags)) };
				} catch (err) {
					throw new FormulaError(`Invalid regular expression: ${(err as Error).message}`);
				}
			case 'id':
				if (t.v === 'true' || t.v === 'false') return { t: 'lit', v: new BooleanValue(t.v === 'true') };
				if (t.v === 'null') return { t: 'lit', v: NullValue.value };
				if (this.isOp('(')) {
					this.next();
					return { t: 'call', name: t.v, args: this.args(')') };
				}
				return { t: 'id', name: t.v };
			case 'op':
				if (t.v === '(') {
					const inner = this.expression(0);
					this.expect(')');
					return inner;
				}
				if (t.v === '[') return { t: 'list', items: this.args(']') };
				if (t.v === '{') return this.object();
				break;
			case 'eof':
				throw new FormulaError('The formula ends too early');
		}
		throw new FormulaError(`Unexpected "${t.v}" at ${t.pos + 1}`);
	}

	private object(): FormulaNode {
		const entries: [string, FormulaNode][] = [];
		while (!this.isOp('}')) {
			const key = this.next();
			if (key.k !== 'str' && key.k !== 'id') throw new FormulaError(`Expected a key at ${key.pos + 1}`);
			this.expect(':');
			entries.push([key.v, this.expression(0)]);
			if (!this.isOp(',')) break;
			this.next();
		}
		this.expect('}');
		return { t: 'object', entries };
	}
}

const parsed = new Map<string, FormulaNode | FormulaError>();

/** The formula's tree; throws a FormulaError if it is not valid. */
export function parseFormula(source: string): FormulaNode {
	let result = parsed.get(source);
	if (!result) {
		try {
			result = new Parser(tokenize(source)).parse();
		} catch (err) {
			result = err instanceof FormulaError ? err : new FormulaError(String(err));
		}
		if (parsed.size > 2000) parsed.clear();
		parsed.set(source, result);
	}
	if (result instanceof FormulaError) throw result;
	return result;
}

/** Where a formula is evaluated: the row's file, `this`, formulas, and lambda variables. */
export interface EvalContext {
	app: App;
	/** The row's file; null for formulas that are not about a row (view options). */
	file: TFile | null;
	/** `this`: the base file, the note embedding the base, or the active note. */
	thisFile: TFile | null;
	/** `formula.<name>` for `file`. */
	formula(name: string, file: TFile | null): Value;
	/** `value`, `index`, `acc`, `values`. */
	locals?: Record<string, Value>;
}

/** A namespace (`formula`, `this`) whose members are looked up by name. */
class ScopeValue extends NotNullValue {
	constructor(readonly lookup: (name: string) => Value) {
		super();
	}

	toString(): string {
		return '';
	}

	isTruthy(): boolean {
		return true;
	}
}

/** A note's frontmatter as an object, its values typed as in the properties (dates, tags, links). */
class PropertiesValue extends ObjectValue {
	constructor(
		private readonly app: App,
		private readonly file: TFile,
		frontmatter: Record<string, unknown>,
	) {
		super(frontmatter);
	}

	override get(key: string): Value {
		return noteProperty(this.app, this.file, key);
	}
}

const ISO_DATE_TEXT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

function frontmatterOf(app: App, file: TFile): Record<string, unknown> {
	return (app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined) ?? {};
}

/** The raw frontmatter value of `name` (matched without case if not exact), or undefined. */
export function rawProperty(app: App, file: TFile, name: string): unknown {
	const fm = frontmatterOf(app, file);
	if (name in fm) return fm[name];
	const key = Object.keys(fm).find((k) => k.toLowerCase() === name.toLowerCase());
	return key === undefined ? undefined : fm[key];
}

/** A note property as a Value, typed as its property type says (dates, tags) or as it looks (links, URLs). */
export function noteProperty(app: App, file: TFile, name: string): Value {
	const raw = rawProperty(app, file, name);
	if (raw === undefined || raw === null) return NullValue.value;
	const type = app.metadataTypeManager.getAssignedType(name);
	if (type === 'tags' || name.toLowerCase() === 'tags') {
		const list = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
		return new ListValue(list.filter((t) => t !== null && String(t).trim()).map((t) => new TagValue(String(t).trim())));
	}
	const asDate = (text: unknown): Value | null => {
		if (typeof text !== 'string') return null;
		if (type !== 'date' && type !== 'datetime' && (type || !ISO_DATE_TEXT.test(text.trim()))) return null;
		const date = DateValue.parseFromString(text);
		return date && type === 'date' ? date.dateOnly() : date;
	};
	if (Array.isArray(raw)) return new ListValue(raw.map((item) => asDate(item) ?? wrapValue(item, app, file.path)));
	return asDate(raw) ?? wrapValue(raw, app, file.path);
}

/** `file.<name>`. */
export function fileProperty(app: App, file: TFile, name: string): Value {
	const cache = app.metadataCache.getFileCache(file);
	switch (name) {
		case 'name':
			return new StringValue(file.name);
		case 'basename':
			return new StringValue(file.basename);
		case 'path':
			return new StringValue(file.path);
		case 'folder':
			return new StringValue(file.parent?.path ?? '/');
		case 'ext':
			return new StringValue(file.extension);
		case 'size':
			return new NumberValue(file.stat.size);
		case 'ctime':
			return new DateValue(new Date(file.stat.ctime));
		case 'mtime':
			return new DateValue(new Date(file.stat.mtime));
		case 'tags':
			return new ListValue(fileTags(app, file).map((t) => new TagValue(t)));
		case 'links':
			return new ListValue([...(cache?.links ?? []), ...(cache?.frontmatterLinks ?? [])].map((l) => new LinkValue(app, l.link, file.path, l.displayText && l.displayText !== l.link ? l.displayText : null)));
		case 'embeds':
			return new ListValue((cache?.embeds ?? []).map((l) => new LinkValue(app, l.link, file.path)));
		case 'backlinks':
			return new ListValue(app.metadataCache.getBacklinks(file).map((path) => new LinkValue(app, path, '')));
		case 'properties':
			return new PropertiesValue(app, file, frontmatterOf(app, file));
		case 'file':
			return new FileValue(file);
		default:
			return NullValue.value;
	}
}

/** The note's tags (frontmatter and text), with `#`, each once. */
function fileTags(app: App, file: TFile): string[] {
	const cache = app.metadataCache.getFileCache(file);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const tag of (cache && getAllTags(cache)) ?? []) {
		const key = tag.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(tag);
	}
	return out;
}

/** The file a value points at: a file, a link, or a path. */
function fileOf(app: App, value: Value, sourcePath: string): TFile | null {
	if (value instanceof FileValue) return value.file;
	if (value instanceof LinkValue) return value.resolve();
	if (value instanceof StringValue) {
		const link = LinkValue.parseFromString(app, value.value, sourcePath);
		if (link) return link.resolve();
		return app.vault.getFileByPath(value.value) ?? app.metadataCache.getFirstLinkpathDest(value.value, sourcePath);
	}
	return null;
}

export function evaluate(node: FormulaNode, ctx: EvalContext): Value {
	switch (node.t) {
		case 'lit':
			return node.v;
		case 'id':
			return identifier(node.name, ctx);
		case 'member':
			return member(evaluate(node.obj, ctx), node.name, ctx);
		case 'index': {
			const obj = evaluate(node.obj, ctx);
			const index = evaluate(node.index, ctx);
			if (obj instanceof ListValue) return obj.get(Math.trunc(toNumber(index)));
			if (obj instanceof StringValue && index instanceof NumberValue) {
				const ch = obj.value[index.value < 0 ? obj.value.length + index.value : index.value];
				return ch === undefined ? NullValue.value : new StringValue(ch);
			}
			return member(obj, index.toString(), ctx);
		}
		case 'list':
			return new ListValue(node.items.map((item) => evaluate(item, ctx)));
		case 'object':
			return new ObjectValue(Object.fromEntries(node.entries.map(([k, v]) => [k, evaluate(v, ctx)])));
		case 'unary': {
			const value = evaluate(node.arg, ctx);
			if (node.op === '!') return new BooleanValue(!value.isTruthy());
			if (value instanceof DurationValue) return new DurationValue(-value.milliseconds, -value.months);
			return numberOrNull(-toNumber(value));
		}
		case 'binary':
			return binary(node.op, node.l, node.r, ctx);
		case 'call':
			return call(node.name, node.args, ctx);
		case 'method':
			return method(evaluate(node.obj, ctx), node.name, node.args, ctx);
	}
}

/** Evaluates `source` (parsed once), returning an ErrorValue rather than throwing. */
export function evaluateFormula(source: string, ctx: EvalContext): Value {
	try {
		return evaluate(parseFormula(source), ctx);
	} catch (err) {
		return new ErrorValue(err instanceof Error ? err.message : String(err));
	}
}

function numberOrNull(n: number): Value {
	return Number.isNaN(n) ? NullValue.value : new NumberValue(n);
}

function identifier(name: string, ctx: EvalContext): Value {
	const local = ctx.locals?.[name];
	if (local) return local;
	const { app, file } = ctx;
	switch (name) {
		case 'file':
			return file ? new FileValue(file) : NullValue.value;
		case 'note':
			return file ? new PropertiesValue(app, file, frontmatterOf(app, file)) : NullValue.value;
		case 'formula':
			return new ScopeValue((formula) => ctx.formula(formula, file));
		case 'this': {
			const self = ctx.thisFile;
			if (!self) return NullValue.value;
			return new ScopeValue((prop) => {
				if (prop === 'file') return new FileValue(self);
				if (prop === 'note') return new PropertiesValue(app, self, frontmatterOf(app, self));
				if (prop === 'formula') return new ScopeValue((formula) => ctx.formula(formula, self));
				return noteProperty(app, self, prop);
			});
		}
		default:
			return file ? noteProperty(app, file, name) : NullValue.value;
	}
}

function member(obj: Value, name: string, ctx: EvalContext): Value {
	if (obj instanceof ScopeValue) return obj.lookup(name);
	if (obj instanceof FileValue) return fileProperty(ctx.app, obj.file, name);
	if (obj instanceof ObjectValue) return obj.get(name);
	if (obj instanceof LinkValue && name !== 'length') {
		const file = obj.resolve();
		return file ? fileProperty(ctx.app, file, name) : NullValue.value;
	}
	if (name === 'length') {
		if (obj instanceof ListValue) return new NumberValue(obj.length());
		if (obj instanceof StringValue) return new NumberValue(obj.value.length);
	}
	if (obj instanceof DateValue) {
		const d = obj.date;
		const field: Record<string, () => number> = {
			year: () => d.getFullYear(),
			month: () => d.getMonth() + 1,
			day: () => d.getDate(),
			hour: () => d.getHours(),
			minute: () => d.getMinutes(),
			second: () => d.getSeconds(),
			millisecond: () => d.getMilliseconds(),
		};
		const get = field[name];
		if (get) return new NumberValue(get());
	}
	if (obj instanceof DurationValue) {
		const per: Record<string, number> = { days: 86_400_000, hours: 3_600_000, minutes: 60_000, seconds: 1000, milliseconds: 1, weeks: 7 * 86_400_000 };
		const unit = per[name];
		if (unit) return new NumberValue(obj.getMilliseconds() / unit);
	}
	return NullValue.value;
}

/** A value as a duration: a duration, a string such as `"1 week"`, or a number of milliseconds. */
function asDuration(value: Value): DurationValue | null {
	if (value instanceof DurationValue) return value;
	if (value instanceof StringValue) return DurationValue.parseHuman(value.value);
	return null;
}

function asDate(value: Value): DateValue | null {
	if (value instanceof DateValue) return value;
	if (value instanceof StringValue && !(value instanceof LinkValue)) return DateValue.parseFromString(value.value);
	return null;
}

function binary(op: string, ln: FormulaNode, rn: FormulaNode, ctx: EvalContext): Value {
	if (op === '&&') {
		const l = evaluate(ln, ctx);
		return new BooleanValue(l.isTruthy() && evaluate(rn, ctx).isTruthy());
	}
	if (op === '||') {
		const l = evaluate(ln, ctx);
		return new BooleanValue(l.isTruthy() || evaluate(rn, ctx).isTruthy());
	}
	const l = evaluate(ln, ctx);
	const r = evaluate(rn, ctx);
	if (l instanceof ErrorValue) return l;
	if (r instanceof ErrorValue) return r;
	switch (op) {
		case '==':
			return new BooleanValue(Value.looseEquals(l, r) || datesEqual(l, r));
		case '!=':
			return new BooleanValue(!(Value.looseEquals(l, r) || datesEqual(l, r)));
		case '<':
		case '>':
		case '<=':
		case '>=': {
			const order = compareForOperator(l, r);
			if (order === null) return new BooleanValue(false);
			return new BooleanValue(op === '<' ? order < 0 : op === '>' ? order > 0 : op === '<=' ? order <= 0 : order >= 0);
		}
		case '+':
			return add(l, r);
		case '-':
			return subtract(l, r);
		case '*':
			return numberOrNull(toNumber(l) * toNumber(r));
		case '/':
			return numberOrNull(toNumber(l) / toNumber(r));
		case '%':
			return numberOrNull(toNumber(l) % toNumber(r));
	}
	throw new FormulaError(`Unknown operator ${op}`);
}

/** `date == "2025-01-01"`: a date against a date written as text. */
function datesEqual(l: Value, r: Value): boolean {
	if (!(l instanceof DateValue) && !(r instanceof DateValue)) return false;
	const a = asDate(l);
	const b = asDate(r);
	return !!a && !!b && (a.time && b.time ? a.date.getTime() === b.date.getTime() : a.dateOnly().date.getTime() === b.dateOnly().date.getTime());
}

/** Order for `<` and friends, or null when the values cannot be compared (one is empty). */
function compareForOperator(l: Value, r: Value): number | null {
	if (l instanceof NullValue || r instanceof NullValue) return null;
	if (l instanceof DateValue || r instanceof DateValue) {
		const a = asDate(l);
		const b = asDate(r);
		return a && b ? a.date.getTime() - b.date.getTime() : null;
	}
	if (l instanceof DurationValue || r instanceof DurationValue) {
		const a = asDuration(l) ?? (l instanceof NumberValue ? DurationValue.fromMilliseconds(l.value) : null);
		const b = asDuration(r) ?? (r instanceof NumberValue ? DurationValue.fromMilliseconds(r.value) : null);
		return a && b ? a.getMilliseconds() - b.getMilliseconds() : null;
	}
	const a = toNumber(l);
	const b = toNumber(r);
	if (!Number.isNaN(a) && !Number.isNaN(b)) return a - b;
	return compareValues(l, r);
}

function add(l: Value, r: Value): Value {
	if (l instanceof DateValue) {
		const d = asDuration(r);
		if (d) return d.addToDate(l);
	}
	if (r instanceof DateValue) {
		const d = asDuration(l);
		if (d) return d.addToDate(r);
	}
	if (l instanceof DurationValue && r instanceof DurationValue) return new DurationValue(l.milliseconds + r.milliseconds, l.months + r.months);
	if (l instanceof ListValue && r instanceof ListValue) return l.concat(r);
	if (l instanceof NumberValue && r instanceof NumberValue) return new NumberValue(l.value + r.value);
	if (l instanceof StringValue || r instanceof StringValue || l instanceof ListValue || r instanceof ListValue) return new StringValue(displayText(l) + displayText(r));
	return numberOrNull(toNumber(l) + toNumber(r));
}

function subtract(l: Value, r: Value): Value {
	if (l instanceof DateValue) {
		const other = asDate(r);
		if (other && !(r instanceof StringValue && DurationValue.parseHuman(r.value))) return DurationValue.fromMilliseconds(l.date.getTime() - other.date.getTime());
		const d = asDuration(r);
		if (d) return d.addToDate(l, true);
	}
	if (l instanceof DurationValue && r instanceof DurationValue) return new DurationValue(l.milliseconds - r.milliseconds, l.months - r.months);
	return numberOrNull(toNumber(l) - toNumber(r));
}

function args(nodes: FormulaNode[], ctx: EvalContext): Value[] {
	return nodes.map((n) => evaluate(n, ctx));
}

function text(value: Value | undefined): string {
	return value ? displayText(value) : '';
}

function call(name: string, nodes: FormulaNode[], ctx: EvalContext): Value {
	const sourcePath = ctx.file?.path ?? ctx.thisFile?.path ?? '';
	switch (name) {
		case 'if': {
			const cond = nodes[0] ? evaluate(nodes[0], ctx) : NullValue.value;
			const branch = cond.isTruthy() ? nodes[1] : nodes[2];
			return branch ? evaluate(branch, ctx) : NullValue.value;
		}
		case 'now':
			return new DateValue(new Date());
		case 'today': {
			const d = new Date();
			d.setHours(0, 0, 0, 0);
			return new DateValue(d, false);
		}
		case 'date': {
			const [v] = args(nodes, ctx);
			if (!v) return NullValue.value;
			return asDate(v) ?? (v instanceof NumberValue ? new DateValue(new Date(v.value)) : NullValue.value);
		}
		case 'duration': {
			const [v] = args(nodes, ctx);
			return (v && asDuration(v)) ?? (v instanceof NumberValue ? DurationValue.fromMilliseconds(v.value) : NullValue.value);
		}
		case 'number': {
			const [v] = args(nodes, ctx);
			return v ? numberOrNull(toNumber(v)) : NullValue.value;
		}
		case 'list': {
			const [v] = args(nodes, ctx);
			if (!v || v instanceof NullValue) return new ListValue([]);
			return v instanceof ListValue ? v : new ListValue([v]);
		}
		case 'max':
		case 'min': {
			const values = args(nodes, ctx).flatMap((v) => (v instanceof ListValue ? v.value : [v])).filter((v) => !(v instanceof NullValue));
			if (!values.length) return NullValue.value;
			return values.reduce((best, v) => ((name === 'max' ? compareValues(v, best) > 0 : compareValues(v, best) < 0) ? v : best));
		}
		case 'link': {
			const [target, display] = args(nodes, ctx);
			if (!target || target instanceof NullValue) return NullValue.value;
			const file = target instanceof FileValue ? target.file : null;
			const linktext = file ? ctx.app.metadataCache.fileToLinktext(file, sourcePath) : target instanceof LinkValue ? target.value : target.toString();
			return new LinkValue(ctx.app, linktext, sourcePath, display && !(display instanceof NullValue) ? text(display) : null);
		}
		case 'file': {
			const [v] = args(nodes, ctx);
			const file = v ? fileOf(ctx.app, v, sourcePath) : null;
			return file ? new FileValue(file) : NullValue.value;
		}
		case 'image': {
			const [v] = args(nodes, ctx);
			if (!v || v instanceof NullValue) return NullValue.value;
			const file = v instanceof FileValue ? v.file : v instanceof LinkValue ? v.resolve() : null;
			return new ImageValue(file ? file.path : v.toString());
		}
		case 'icon': {
			const [v] = args(nodes, ctx);
			return v && !(v instanceof NullValue) ? new IconValue(v.toString()) : NullValue.value;
		}
		case 'html': {
			const [v] = args(nodes, ctx);
			return v && !(v instanceof NullValue) ? new HTMLValue(v.toString()) : NullValue.value;
		}
		case 'escapeHTML': {
			const [v] = args(nodes, ctx);
			const div = document.createElement('div');
			div.textContent = text(v);
			return new StringValue(div.innerHTML);
		}
	}
	throw new FormulaError(`Unknown function ${name}()`);
}

/** `.filter(…)`, `.map(…)`, `.reduce(…)`: the argument is evaluated per item, with `value`, `index` (and `acc`). */
function eachItem(list: ListValue, node: FormulaNode | undefined, ctx: EvalContext, extra: (i: number) => Record<string, Value> = () => ({})): Value[] {
	if (!node) throw new FormulaError('Missing the expression to apply');
	return list.value.map((value, index) => evaluate(node, { ...ctx, locals: { ...ctx.locals, value, index: new NumberValue(index), ...extra(index) } }));
}

function method(obj: Value, name: string, nodes: FormulaNode[], ctx: EvalContext): Value {
	const { app } = ctx;
	// Methods of any value.
	switch (name) {
		case 'isTruthy':
			return new BooleanValue(obj.isTruthy());
		case 'isType': {
			const [type] = args(nodes, ctx);
			return new BooleanValue(obj.isType(text(type)));
		}
		case 'toString':
			return new StringValue(displayText(obj));
		case 'isEmpty':
			if (obj instanceof NullValue) return new BooleanValue(true);
			if (obj instanceof ListValue) return new BooleanValue(obj.length() === 0);
			if (obj instanceof ObjectValue) return new BooleanValue(obj.isEmpty());
			if (obj instanceof StringValue) return new BooleanValue(obj.value === '');
			return new BooleanValue(false);
	}
	if (obj instanceof NullValue || obj instanceof ErrorValue) return obj;

	if (obj instanceof FileValue || (obj instanceof LinkValue && ['asFile', 'linksTo'].includes(name))) {
		const file = obj instanceof FileValue ? obj.file : obj.resolve();
		if (name === 'asFile') return file ? new FileValue(file) : NullValue.value;
		if (!file) return new BooleanValue(false);
		switch (name) {
			case 'asLink': {
				const [display] = args(nodes, ctx);
				return new LinkValue(app, app.metadataCache.fileToLinktext(file, ''), '', display && !(display instanceof NullValue) ? text(display) : null);
			}
			case 'hasTag': {
				const wanted = args(nodes, ctx)
					.flatMap((v) => (v instanceof ListValue ? v.value : [v]))
					.map((v) => text(v).replace(/^#/, '').toLowerCase());
				const tags = fileTags(app, file).map((t) => t.slice(1).toLowerCase());
				return new BooleanValue(wanted.some((w) => tags.some((t) => t === w || t.startsWith(`${w}/`))));
			}
			case 'hasLink':
			case 'linksTo': {
				const [other] = args(nodes, ctx);
				const target = other ? fileOf(app, other, file.path) : null;
				if (target) return new BooleanValue((app.metadataCache.resolvedLinks[file.path]?.[target.path] ?? 0) > 0);
				const linkpath = other ? text(other).toLowerCase() : '';
				return new BooleanValue(Object.keys(app.metadataCache.unresolvedLinks[file.path] ?? {}).some((l) => l.toLowerCase() === linkpath));
			}
			case 'hasProperty': {
				const [prop] = args(nodes, ctx);
				return new BooleanValue(rawProperty(app, file, text(prop)) !== undefined);
			}
			case 'inFolder': {
				const [folder] = args(nodes, ctx);
				const path = normalizePath(text(folder)).replace(/^\/+|\/+$/g, '');
				if (!path) return new BooleanValue(true);
				const parent = file.parent?.path ?? '';
				return new BooleanValue(parent.toLowerCase() === path.toLowerCase() || parent.toLowerCase().startsWith(`${path.toLowerCase()}/`));
			}
		}
	}

	if (obj instanceof ListValue) {
		switch (name) {
			case 'contains': {
				const [v] = args(nodes, ctx);
				return new BooleanValue(!!v && obj.includes(v));
			}
			case 'containsAll':
				return new BooleanValue(args(nodes, ctx).every((v) => obj.includes(v)));
			case 'containsAny':
				return new BooleanValue(args(nodes, ctx).some((v) => obj.includes(v)));
			case 'filter': {
				const keep = eachItem(obj, nodes[0], ctx);
				return new ListValue(obj.value.filter((_v, i) => keep[i]!.isTruthy()));
			}
			case 'map':
				return new ListValue(eachItem(obj, nodes[0], ctx));
			case 'reduce': {
				let acc = nodes[1] ? evaluate(nodes[1], ctx) : NullValue.value;
				const node = nodes[0];
				if (!node) throw new FormulaError('Missing the expression to apply');
				obj.value.forEach((value, index) => {
					acc = evaluate(node, { ...ctx, locals: { ...ctx.locals, value, index: new NumberValue(index), acc } });
				});
				return acc;
			}
			case 'flat':
				return new ListValue(obj.value.flatMap((v) => (v instanceof ListValue ? v.value : [v])));
			case 'join': {
				const [sep] = args(nodes, ctx);
				return new StringValue(obj.value.map(displayText).join(sep ? text(sep) : ', '));
			}
			case 'reverse':
				return new ListValue([...obj.value].reverse());
			case 'sort':
				return new ListValue([...obj.value].sort(compareValues));
			case 'unique':
				return new ListValue(obj.value.filter((v, i) => obj.value.findIndex((o) => Value.looseEquals(o, v)) === i));
			case 'slice': {
				const [start, end] = args(nodes, ctx);
				return new ListValue(obj.value.slice(start ? toNumber(start) : 0, end && !(end instanceof NullValue) ? toNumber(end) : undefined));
			}
			case 'length':
				return new NumberValue(obj.length());
		}
	}

	if (obj instanceof DateValue) {
		switch (name) {
			case 'date':
				return obj.dateOnly();
			case 'format': {
				const [format] = args(nodes, ctx);
				return new StringValue(moment(obj.date).format(format ? text(format) : undefined));
			}
			case 'time':
				return new StringValue(moment(obj.date).format('HH:mm:ss'));
			case 'relative':
				return new RelativeDateValue(obj.date, obj.time);
		}
	}

	if (obj instanceof NumberValue) {
		switch (name) {
			case 'abs':
				return new NumberValue(Math.abs(obj.value));
			case 'ceil':
				return new NumberValue(Math.ceil(obj.value));
			case 'floor':
				return new NumberValue(Math.floor(obj.value));
			case 'round': {
				const [digits] = args(nodes, ctx);
				const factor = 10 ** (digits ? toNumber(digits) : 0);
				return new NumberValue(Math.round(obj.value * factor) / factor);
			}
			case 'toFixed': {
				const [digits] = args(nodes, ctx);
				return new StringValue(obj.value.toFixed(Math.max(0, Math.min(100, digits ? toNumber(digits) : 0))));
			}
		}
	}

	if (obj instanceof RegExpValue && name === 'matches') {
		const [v] = args(nodes, ctx);
		return new BooleanValue(obj.matches(text(v)));
	}

	if (obj instanceof ObjectValue) {
		if (name === 'keys') return new ListValue(obj.keys());
		if (name === 'values') return new ListValue(obj.keys().map((k) => obj.get(k)));
	}

	if (obj instanceof StringValue) {
		const s = obj instanceof LinkValue ? displayText(obj) : obj.value;
		const strs = () => args(nodes, ctx).map(text);
		switch (name) {
			case 'contains':
				return new BooleanValue(s.includes(strs()[0] ?? ''));
			case 'containsAll':
				return new BooleanValue(strs().every((t) => s.includes(t)));
			case 'containsAny':
				return new BooleanValue(strs().some((t) => s.includes(t)));
			case 'startsWith':
				return new BooleanValue(s.startsWith(strs()[0] ?? ''));
			case 'endsWith':
				return new BooleanValue(s.endsWith(strs()[0] ?? ''));
			case 'lower':
				return new StringValue(s.toLowerCase());
			case 'upper':
				return new StringValue(s.toUpperCase());
			case 'title':
				return new StringValue(s.replace(/(^|\s)(\p{L})/gu, (_m, space: string, ch: string) => space + ch.toUpperCase()));
			case 'trim':
				return new StringValue(s.trim());
			case 'reverse':
				return new StringValue([...s].reverse().join(''));
			case 'repeat': {
				const [n] = args(nodes, ctx);
				return new StringValue(s.repeat(Math.max(0, Math.min(10_000, n ? toNumber(n) : 0))));
			}
			case 'slice': {
				const [start, end] = args(nodes, ctx);
				return new StringValue(s.slice(start ? toNumber(start) : 0, end && !(end instanceof NullValue) ? toNumber(end) : undefined));
			}
			case 'split': {
				const [sep, limit] = args(nodes, ctx);
				const parts = sep instanceof RegExpValue ? s.split(sep.regexp) : s.split(text(sep));
				return new ListValue(limit ? parts.slice(0, toNumber(limit)) : parts);
			}
			case 'replace': {
				const [pattern, replacement] = args(nodes, ctx);
				const by = text(replacement);
				return new StringValue(pattern instanceof RegExpValue ? s.replace(pattern.regexp, by) : s.split(text(pattern)).join(by));
			}
		}
	}
	throw new FormulaError(`Unknown method ${name}() for ${obj.constructor.name.replace(/Value$/, '').toLowerCase() || 'value'}`);
}
