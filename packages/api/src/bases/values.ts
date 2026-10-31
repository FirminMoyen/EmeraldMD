/**
 * Values of Bases, as in the typings: what properties and formulas evaluate
 * to, how they compare and how they render. `wrapValue` turns plain data
 * (frontmatter, plugin values) into them.
 */

import type { TFile } from '@emeraldmd/core';
import type { App } from '../app';
import { setIcon } from '../icons';
import { Keymap } from '../keymap';
import { moment } from '../moment';
import { isDangerousUrl, sanitizeHTMLToDom } from '../util';

/** What `renderTo` gets: the app, for links that open notes. */
export interface ValueRenderContext {
	hoverPopover?: unknown;
	app?: App | null;
}

export abstract class Value {
	static type = 'value';

	static equals(a: Value | null, b: Value | null): boolean {
		if (!a || a instanceof NullValue) return !b || b instanceof NullValue;
		return !!b && a.constructor === b.constructor && a.equals(b as never);
	}

	static looseEquals(a: Value | null, b: Value | null): boolean {
		if (!a || a instanceof NullValue) return !b || b instanceof NullValue;
		return !!b && !(b instanceof NullValue) && (a.looseEquals(b) || b.looseEquals(a));
	}

	abstract toString(): string;
	abstract isTruthy(): boolean;

	equals(other: this): boolean {
		return this.toString() === other.toString();
	}

	looseEquals(other: Value): boolean {
		return this.constructor === other.constructor && this.equals(other as this);
	}

	/** Whether this value is of `type` (`string`, `number`, `date`, `list`, `link`…), counting the types it extends. */
	isType(type: string): boolean {
		for (let c = this.constructor as typeof Value | null; c; c = Object.getPrototypeOf(c) as typeof Value | null) {
			if (Object.prototype.hasOwnProperty.call(c, 'type') && c.type === type.toLowerCase()) return true;
		}
		return false;
	}

	renderTo(el: HTMLElement, _ctx: ValueRenderContext): void {
		el.appendText(this.toString());
	}
}

export abstract class NotNullValue extends Value {}

export class NullValue extends Value {
	static override type = 'null';
	static value: NullValue = new NullValue();

	toString(): string {
		return '';
	}

	isTruthy(): boolean {
		return false;
	}

	override equals(other: Value): boolean {
		return other instanceof NullValue;
	}

	override looseEquals(other: Value): boolean {
		return other instanceof NullValue;
	}

	override renderTo(): void {}
}

/** A formula that could not be evaluated: shows its message. */
export class ErrorValue extends NotNullValue {
	static override type = 'error';

	constructor(readonly message: string) {
		super();
	}

	toString(): string {
		return this.message;
	}

	isTruthy(): boolean {
		return false;
	}

	override renderTo(el: HTMLElement): void {
		el.createSpan({ cls: 'bases-error-value', text: '⚠', attr: { 'aria-label': this.message, title: this.message } });
	}
}

export abstract class PrimitiveValue<T> extends NotNullValue {
	constructor(readonly value: T) {
		super();
	}

	toString(): string {
		return String(this.value);
	}

	isTruthy(): boolean {
		return Boolean(this.value);
	}

	override equals(other: Value): boolean {
		return other instanceof PrimitiveValue && other.value === this.value;
	}
}

export class StringValue extends PrimitiveValue<string> {
	static override type = 'string';

	override looseEquals(other: Value): boolean {
		if (other instanceof StringValue) return other.toString() === this.toString();
		if (other instanceof NumberValue || other instanceof BooleanValue) return String(other.value) === this.value.trim();
		return false;
	}
}

export class NumberValue extends PrimitiveValue<number> {
	static override type = 'number';

	override toString(): string {
		if (!Number.isFinite(this.value) || Number.isInteger(this.value)) return String(this.value);
		return String(Number(this.value.toPrecision(12)));
	}
}

export class BooleanValue extends PrimitiveValue<boolean> {
	static override type = 'boolean';

	override renderTo(el: HTMLElement): void {
		const box = el.createEl('input', { cls: 'metadata-input-checkbox', attr: { type: 'checkbox', disabled: 'true' } });
		box.checked = this.value;
	}
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

export class DateValue extends NotNullValue {
	static override type = 'date';

	/** `time`: whether the time of day is part of the value (a date property has none). */
	constructor(
		readonly date: Date,
		readonly time = true,
	) {
		super();
	}

	toString(): string {
		return moment(this.date).format(this.time ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD');
	}

	/** @returns a new DateValue with any time portion in this DateValue removed. */
	dateOnly(): DateValue {
		const d = new Date(this.date);
		d.setHours(0, 0, 0, 0);
		return new DateValue(d, false);
	}

	relative(): string {
		return moment(this.date).fromNow();
	}

	isTruthy(): boolean {
		return !Number.isNaN(this.date.getTime());
	}

	override equals(other: Value): boolean {
		return other instanceof DateValue && other.date.getTime() === this.date.getTime();
	}

	override looseEquals(other: Value): boolean {
		if (other instanceof DateValue) return this.equals(other);
		if (other instanceof StringValue) {
			const parsed = DateValue.parseFromString(other.value);
			return !!parsed && (this.time && parsed.time ? parsed.date.getTime() === this.date.getTime() : parsed.dateOnly().equals(this.dateOnly()));
		}
		return false;
	}

	/** Parses `2025-12-31`, `2025-12-31T23:59`, `2025-12-31T23:59:59`, `2025-12-31T23:59:59Z-07`. */
	static parseFromString(input: string): DateValue | null {
		const m = ISO_DATE.exec(input.trim());
		if (!m) return null;
		const [, y, mo, d, h, mi, s, ms, zone] = m;
		const time = h !== undefined;
		let date: Date;
		if (zone) {
			const offset = zone === 'Z' ? 'Z' : zone.length === 3 ? `${zone}:00` : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
			date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}${ms ? `.${ms.slice(0, 3)}` : ''}${offset}`);
		} else {
			date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0), Number((ms ?? '0').slice(0, 3).padEnd(3, '0')));
		}
		if (Number.isNaN(date.getTime()) || date.getMonth() !== (zone ? date.getMonth() : Number(mo) - 1)) return null;
		return new DateValue(date, time);
	}
}

/** A date shown relative to now ("3 days ago"). */
export class RelativeDateValue extends DateValue {
	override toString(): string {
		return this.relative();
	}
}

const DURATION_UNITS: Record<string, { ms?: number; months?: number }> = {
	y: { months: 12 },
	year: { months: 12 },
	M: { months: 1 },
	month: { months: 1 },
	w: { ms: 7 * 86_400_000 },
	week: { ms: 7 * 86_400_000 },
	d: { ms: 86_400_000 },
	day: { ms: 86_400_000 },
	h: { ms: 3_600_000 },
	hour: { ms: 3_600_000 },
	m: { ms: 60_000 },
	minute: { ms: 60_000 },
	s: { ms: 1000 },
	second: { ms: 1000 },
	ms: { ms: 1 },
	millisecond: { ms: 1 },
};

export class DurationValue extends NotNullValue {
	static override type = 'duration';

	/** Months (and years) are calendar units, applied to dates with the calendar; the rest is milliseconds. */
	constructor(
		readonly milliseconds: number,
		readonly months = 0,
	) {
		super();
	}

	toString(): string {
		return moment.duration(this.getMilliseconds()).humanize();
	}

	isTruthy(): boolean {
		return this.getMilliseconds() !== 0;
	}

	override equals(other: Value): boolean {
		return other instanceof DurationValue && other.getMilliseconds() === this.getMilliseconds();
	}

	addToDate(value: DateValue, subtract = false): DateValue {
		const sign = subtract ? -1 : 1;
		const m = moment(value.date);
		if (this.months) m.add(sign * this.months, 'months');
		m.add(sign * this.milliseconds, 'milliseconds');
		return new DateValue(m.toDate(), value.time || this.milliseconds % 86_400_000 !== 0);
	}

	getMilliseconds(): number {
		return this.milliseconds + this.months * 30.436875 * 86_400_000;
	}

	/** An ISO 8601 duration: `P1Y2M3DT4H5M6S`, `P2W`. */
	static parseFromString(input: string): DurationValue | null {
		const m = /^([+-])?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(input.trim());
		if (!m || input.trim().length <= 1 + (m[1] ? 1 : 0)) return null;
		const n = (i: number) => Number(m[i] ?? 0);
		const sign = m[1] === '-' ? -1 : 1;
		const ms = ((n(4) * 7 + n(5)) * 86_400 + n(6) * 3600 + n(7) * 60 + n(8)) * 1000;
		return new DurationValue(sign * ms, sign * (n(2) * 12 + n(3)));
	}

	/** Durations as written in formulas: `1d`, `2 weeks`, `-3h`, `1 year 2 months`, or ISO 8601. */
	static parseHuman(input: string): DurationValue | null {
		const text = input.trim();
		if (/^[+-]?P/i.test(text)) return DurationValue.parseFromString(text);
		const sign = text.startsWith('-') ? -1 : 1;
		const body = text.replace(/^[+-]\s*/, '');
		const part = /(\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s*,?\s*/y;
		let ms = 0;
		let months = 0;
		let pos = 0;
		while (pos < body.length) {
			part.lastIndex = pos;
			const m = part.exec(body);
			if (!m) return null;
			const word = m[2]!;
			const unit = DURATION_UNITS[word] ?? DURATION_UNITS[word.toLowerCase().replace(/s$/, '')] ?? (word.length > 1 ? DURATION_UNITS[word.toLowerCase()] : undefined);
			if (!unit) return null;
			ms += Number(m[1]) * (unit.ms ?? 0);
			months += Number(m[1]) * (unit.months ?? 0);
			pos = part.lastIndex;
		}
		return pos ? new DurationValue(sign * ms, sign * months) : null;
	}

	static fromMilliseconds(milliseconds: number): DurationValue {
		return new DurationValue(milliseconds);
	}
}

export class ListValue extends NotNullValue {
	static override type = 'list';
	readonly value: Value[];

	/** The array passed in is modified: its items are wrapped in Values. */
	constructor(value: (unknown | Value)[]) {
		super();
		for (let i = 0; i < value.length; i++) value[i] = wrapValue(value[i]);
		this.value = value as Value[];
	}

	toString(): string {
		return this.value.map((v) => v.toString()).join(', ');
	}

	isTruthy(): boolean {
		return this.value.length > 0;
	}

	includes(value: Value): boolean {
		return this.value.some((item) => Value.looseEquals(item, value));
	}

	length(): number {
		return this.value.length;
	}

	get(index: number): Value {
		return this.value[index < 0 ? this.value.length + index : index] ?? NullValue.value;
	}

	concat(other: ListValue): ListValue {
		return new ListValue([...this.value, ...other.value]);
	}

	override equals(other: Value): boolean {
		return other instanceof ListValue && other.value.length === this.value.length && this.value.every((v, i) => Value.equals(v, other.value[i]!));
	}

	override looseEquals(other: Value): boolean {
		return other instanceof ListValue && other.value.length === this.value.length && this.value.every((v, i) => Value.looseEquals(v, other.value[i]!));
	}

	override renderTo(el: HTMLElement, ctx: ValueRenderContext): void {
		for (const item of this.value) {
			if (item instanceof NullValue) continue;
			item.renderTo(el.createSpan('value-list-element'), ctx);
		}
	}
}

export class ObjectValue extends NotNullValue {
	static override type = 'object';

	constructor(readonly value: Record<string, unknown>) {
		super();
	}

	toString(): string {
		return JSON.stringify(this.value);
	}

	isTruthy(): boolean {
		return !this.isEmpty();
	}

	isEmpty(): boolean {
		return Object.keys(this.value).length === 0;
	}

	/** The value at `key`, wrapped in a Value. */
	get(key: string): Value {
		return wrapValue(this.value[key]);
	}

	keys(): string[] {
		return Object.keys(this.value);
	}
}

export class FileValue extends NotNullValue {
	static override type = 'file';

	constructor(readonly file: TFile) {
		super();
	}

	toString(): string {
		return this.file.path;
	}

	isTruthy(): boolean {
		return true;
	}

	override equals(other: Value): boolean {
		return other instanceof FileValue && other.file === this.file;
	}

	override looseEquals(other: Value): boolean {
		if (other instanceof FileValue) return other.file === this.file;
		if (other instanceof LinkValue) return other.resolve() === this.file;
		if (other instanceof StringValue) return [this.file.path, this.file.name, this.file.basename].includes(other.value);
		return false;
	}

	override renderTo(el: HTMLElement, ctx: ValueRenderContext): void {
		renderInternalLink(el, ctx, this.file.extension === 'md' ? this.file.basename : this.file.name, this.file.path, '', true);
	}
}

/** Renders `text` as a link to `linktext` that opens it (⌘-click: in a new tab). */
function renderInternalLink(el: HTMLElement, ctx: ValueRenderContext, text: string, linktext: string, sourcePath: string, resolved: boolean): void {
	const a = el.createEl('a', { cls: resolved ? 'internal-link' : 'internal-link is-unresolved', text, attr: { href: linktext, 'data-href': linktext } });
	a.addEventListener('click', (evt) => {
		evt.preventDefault();
		evt.stopPropagation();
		void ctx.app?.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(evt));
	});
	a.addEventListener('mouseover', (event) => {
		ctx.app?.workspace.trigger('hover-link', { event, source: 'bases', hoverParent: ctx, targetEl: a, linktext, sourcePath });
	});
}

const WIKILINK = /^!?\[\[([^[\]|]*?)(?:\|([^[\]]*))?\]\]$/;
const MD_INTERNAL_LINK = /^\[([^\]]*)\]\((?!(?:[a-z][a-z0-9+.-]*:|#))([^)\s]+)\)$/i;

export class LinkValue extends StringValue {
	static override type = 'link';

	/** `value` is the link text (path and subpath); `display` what it shows, if not that. */
	constructor(
		private readonly app: App | null,
		linktext: string,
		readonly sourcePath = '',
		readonly display: string | null = null,
	) {
		super(linktext);
	}

	/** A link from wikilink (`[[Welcome|Example Link]]`) or internal Markdown link syntax. */
	static parseFromString(app: App, input: string, sourcePath: string): LinkValue | null {
		const text = input.trim();
		const wiki = WIKILINK.exec(text);
		if (wiki) return new LinkValue(app, wiki[1]!.trim(), sourcePath, wiki[2]?.trim() || null);
		const md = MD_INTERNAL_LINK.exec(text);
		if (md) return new LinkValue(app, decodeURI(md[2]!), sourcePath, md[1] || null);
		return null;
	}

	/** The file the link points at, if it exists. */
	resolve(): TFile | null {
		if (!this.app) return null;
		const path = this.value.split('#')[0]!;
		return path ? this.app.metadataCache.getFirstLinkpathDest(path, this.sourcePath) : null;
	}

	override toString(): string {
		return this.display ?? this.value;
	}

	override equals(other: Value): boolean {
		return other instanceof LinkValue && other.value === this.value && other.sourcePath === this.sourcePath;
	}

	override looseEquals(other: Value): boolean {
		const file = this.resolve();
		if (other instanceof LinkValue) {
			const target = other.resolve();
			return file && target ? file === target : other.value.toLowerCase() === this.value.toLowerCase();
		}
		if (other instanceof FileValue) return file === other.file;
		if (other instanceof StringValue) {
			const s = other.value;
			return s === this.value || s === this.display || (!!file && [file.path, file.basename, file.name].includes(s));
		}
		return false;
	}

	override renderTo(el: HTMLElement, ctx: ValueRenderContext): void {
		const file = this.resolve();
		const shown = this.display ?? (file && !this.value.includes('#') ? (file.extension === 'md' ? file.basename : file.name) : this.value);
		renderInternalLink(el, { ...ctx, app: ctx.app ?? this.app }, shown, this.value, this.sourcePath, !!file);
	}
}

export class UrlValue extends StringValue {
	static override type = 'url';

	override renderTo(el: HTMLElement): void {
		if (isDangerousUrl(this.value)) {
			el.appendText(this.value);
			return;
		}
		el.createEl('a', { cls: 'external-link', text: this.value, attr: { href: this.value, target: '_blank', rel: 'noopener nofollow' } });
	}
}

export class TagValue extends StringValue {
	static override type = 'tag';

	constructor(value: string) {
		super(value.startsWith('#') ? value : `#${value}`);
	}

	override looseEquals(other: Value): boolean {
		return other instanceof StringValue && other.value.replace(/^#/, '').toLowerCase() === this.value.slice(1).toLowerCase();
	}

	override renderTo(el: HTMLElement): void {
		el.createEl('a', { cls: 'tag', text: this.value, attr: { href: this.value } });
	}
}

/** A path to an image in the vault, or a URL. */
export class ImageValue extends StringValue {
	static override type = 'image';

	override renderTo(el: HTMLElement, ctx: ValueRenderContext): void {
		const src = imageSource(ctx.app ?? null, this.value, '');
		if (src) el.createEl('img', { cls: 'bases-image', attr: { src, alt: '' } });
	}
}

export class IconValue extends StringValue {
	static override type = 'icon';

	override renderTo(el: HTMLElement): void {
		setIcon(el.createSpan('bases-icon'), this.value);
	}
}

export class HTMLValue extends StringValue {
	static override type = 'html';

	override renderTo(el: HTMLElement): void {
		el.append(sanitizeHTMLToDom(this.value));
	}
}

export class RegExpValue extends NotNullValue {
	static override type = 'regexp';

	constructor(readonly regexp: RegExp) {
		super();
	}

	toString(): string {
		return String(this.regexp);
	}

	isTruthy(): boolean {
		return true;
	}

	matches(text: string): boolean {
		this.regexp.lastIndex = 0;
		return this.regexp.test(text);
	}
}

const URL_TEXT = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/** The `src` for an image: a vault file (by link or path) or a URL. */
export function imageSource(app: App | null, value: string, sourcePath: string): string | null {
	const text = value.trim();
	if (!text) return null;
	if (URL_TEXT.test(text)) return isDangerousUrl(text) ? null : text;
	if (!app) return null;
	const link = LinkValue.parseFromString(app, text, sourcePath);
	const path = link ? link.value.split('#')[0]! : text;
	const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath) ?? app.vault.getFileByPath(path);
	return file && IMAGE_FILE.test(file.path) ? app.vault.getResourcePath(file) : null;
}

/** Plain data as a Value: strings that are links or URLs become LinkValue and UrlValue (given the app). */
export function wrapValue(raw: unknown, app: App | null = null, sourcePath = ''): Value {
	if (raw instanceof Value) return raw;
	if (raw === null || raw === undefined) return NullValue.value;
	if (typeof raw === 'boolean') return new BooleanValue(raw);
	if (typeof raw === 'number') return new NumberValue(raw);
	if (typeof raw === 'bigint') return new NumberValue(Number(raw));
	if (typeof raw === 'string') {
		if (app) {
			const link = LinkValue.parseFromString(app, raw, sourcePath);
			if (link) return link;
		}
		return URL_TEXT.test(raw.trim()) ? new UrlValue(raw.trim()) : new StringValue(raw);
	}
	if (raw instanceof Date) return new DateValue(raw);
	if (Array.isArray(raw)) return new ListValue(raw.map((item) => wrapValue(item, app, sourcePath)));
	if (typeof raw === 'object') return new ObjectValue(raw as Record<string, unknown>);
	return new StringValue(String(raw));
}

/** A number for arithmetic and comparisons, or NaN. */
export function toNumber(value: Value): number {
	if (value instanceof NumberValue) return value.value;
	if (value instanceof BooleanValue) return value.value ? 1 : 0;
	if (value instanceof DateValue) return value.date.getTime();
	if (value instanceof DurationValue) return value.getMilliseconds();
	if (value instanceof StringValue && !(value instanceof LinkValue)) {
		const text = value.value.trim();
		return text === '' ? Number.NaN : Number(text);
	}
	return Number.NaN;
}

/** Sort order of two values: nulls last, then numbers, dates and durations by size, text in natural order. */
export function compareValues(a: Value, b: Value): number {
	const aNull = a instanceof NullValue || a instanceof ErrorValue;
	const bNull = b instanceof NullValue || b instanceof ErrorValue;
	if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1;
	const numeric = (v: Value) => v instanceof NumberValue || v instanceof DateValue || v instanceof DurationValue || v instanceof BooleanValue;
	if (numeric(a) && numeric(b)) return toNumber(a) - toNumber(b);
	if (numeric(a) !== numeric(b)) {
		const x = toNumber(a);
		const y = toNumber(b);
		if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
	}
	return displayText(a).localeCompare(displayText(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** The text a value shows: link names rather than paths. */
export function displayText(value: Value): string {
	if (value instanceof FileValue) return value.file.extension === 'md' ? value.file.basename : value.file.name;
	if (value instanceof LinkValue) {
		const file = value.resolve();
		return value.display ?? (file ? (file.extension === 'md' ? file.basename : file.name) : value.value);
	}
	if (value instanceof ListValue) return value.value.map(displayText).join(', ');
	return value.toString();
}
