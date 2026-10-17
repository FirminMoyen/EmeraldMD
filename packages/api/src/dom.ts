/**
 * The DOM and built-in helpers that plugins expect on global prototypes
 * (`el.createDiv()`, `el.empty()`, `[].contains()`, `sleep()`…). The
 * behaviour follows the documentation in the public API typings.
 *
 * Everything is defined as non-enumerable, so `for…in` over arrays and
 * objects is unaffected, and existing native methods are never replaced.
 */

// Brings the typings' global declarations (DomElementInfo, createEl, …) into scope.
import type {} from 'obsidian';

type Fn = (this: never, ...args: never[]) => unknown;

function define(target: object, members: Record<string, Fn | unknown>): void {
	for (const [name, value] of Object.entries(members)) {
		if (Object.prototype.hasOwnProperty.call(target, name)) continue;
		Object.defineProperty(target, name, { value, configurable: true, writable: true, enumerable: false });
	}
}

function defineGetters(target: object, getters: Record<string, (this: never) => unknown>): void {
	for (const [name, get] of Object.entries(getters)) {
		if (Object.prototype.hasOwnProperty.call(target, name)) continue;
		Object.defineProperty(target, name, { get, configurable: true, enumerable: false });
	}
}

function splitClasses(cls: string | string[]): string[] {
	return (Array.isArray(cls) ? cls : cls.split(' ')).filter((c) => c !== '');
}

type Attrs = Record<string, string | number | boolean | null>;

function setAttrs(el: Element, attrs: Attrs): void {
	for (const [name, value] of Object.entries(attrs)) {
		if (value === null || value === false) el.removeAttribute(name);
		else el.setAttribute(name, value === true ? '' : String(value));
	}
}

function applyInfo(el: HTMLElement, o: DomElementInfo): void {
	if (o.cls) el.classList.add(...splitClasses(o.cls));
	if (o.text !== undefined) {
		if (typeof o.text === 'string') el.textContent = o.text;
		else el.append(o.text);
	}
	if (o.attr) setAttrs(el, o.attr);
	if (o.title !== undefined) el.title = o.title;
	if (o.value !== undefined && 'value' in el) (el as HTMLInputElement).value = o.value;
	if (o.type !== undefined && 'type' in el) el.setAttribute('type', o.type);
	if (o.placeholder !== undefined) el.setAttribute('placeholder', o.placeholder);
	if (o.href !== undefined) el.setAttribute('href', o.href);
}

function insert(parent: Node | undefined, el: Node, prepend: boolean | undefined): void {
	if (!parent) return;
	if (prepend) parent.insertBefore(el, parent.firstChild);
	else parent.appendChild(el);
}

function makeEl<K extends keyof HTMLElementTagNameMap>(
	doc: Document,
	parent: Node | undefined,
	tag: K,
	o?: DomElementInfo | string,
	callback?: (el: HTMLElementTagNameMap[K]) => void,
): HTMLElementTagNameMap[K] {
	const info: DomElementInfo = typeof o === 'string' ? { cls: o } : (o ?? {});
	const el = doc.createElement(tag);
	applyInfo(el, info);
	callback?.(el);
	insert(info.parent ?? parent, el, info.prepend);
	return el;
}

function makeSvg<K extends keyof SVGElementTagNameMap>(
	doc: Document,
	parent: Node | undefined,
	tag: K,
	o?: SvgElementInfo | string,
	callback?: (el: SVGElementTagNameMap[K]) => void,
): SVGElementTagNameMap[K] {
	const info: SvgElementInfo = typeof o === 'string' ? { cls: o } : (o ?? {});
	const el = doc.createElementNS('http://www.w3.org/2000/svg', tag);
	if (info.cls) el.classList.add(...splitClasses(info.cls));
	if (info.attr) setAttrs(el, info.attr);
	callback?.(el);
	insert(info.parent ?? parent, el, info.prepend);
	return el;
}

function docOf(node: Node): Document {
	return node.ownerDocument ?? (node as Document);
}

function setCssProps(el: ElementCSSInlineStyle, props: Record<string, string>): void {
	for (const [name, value] of Object.entries(props)) el.style.setProperty(name, value);
}

function setCssStyles(el: ElementCSSInlineStyle, styles: Partial<CSSStyleDeclaration>): void {
	Object.assign(el.style, styles);
}

/** Elements waiting for `onNodeInserted`, checked whenever the document changes. */
const insertionWatchers = new Map<HTMLElement, Set<() => void>>();
const wasConnected = new WeakMap<HTMLElement, boolean>();
let insertionObserver: MutationObserver | null = null;

function watchInsertion(win: Window & typeof globalThis, el: HTMLElement, fire: () => void): () => void {
	let set = insertionWatchers.get(el);
	if (!set) insertionWatchers.set(el, (set = new Set()));
	set.add(fire);
	wasConnected.set(el, el.isConnected);
	if (!insertionObserver) {
		insertionObserver = new win.MutationObserver(() => {
			for (const [target, fns] of insertionWatchers) {
				const connected = target.isConnected;
				if (connected && !wasConnected.get(target)) for (const fn of [...fns]) fn();
				wasConnected.set(target, connected);
			}
		});
		insertionObserver.observe(win.document, { childList: true, subtree: true });
	}
	return () => {
		set.delete(fire);
		if (set.size === 0) insertionWatchers.delete(el);
	};
}

interface DelegatedListener {
	selector: string;
	listener: Function;
	options?: boolean | AddEventListenerOptions;
	callback: EventListener;
}

type Delegating = (HTMLElement | Document) & { _EVENTS?: Record<string, DelegatedListener[]> };

function delegateOn(
	this: Delegating,
	type: string,
	selector: string,
	listener: (ev: Event, delegateTarget: HTMLElement) => unknown,
	options?: boolean | AddEventListenerOptions,
): void {
	const host = this;
	const callback = (ev: Event) => {
		const target = ev.target;
		if (!(target instanceof Element)) return;
		const match = target.closest(selector);
		if (match && (host === match || host.contains(match))) listener.call(host, ev, match as HTMLElement);
	};
	const events = (this._EVENTS ??= {});
	(events[type] ??= []).push({ selector, listener, options, callback });
	this.addEventListener(type, callback, options);
}

function delegateOff(
	this: Delegating,
	type: string,
	selector: string,
	listener: Function,
	options?: boolean | AddEventListenerOptions,
): void {
	const list = this._EVENTS?.[type];
	if (!list) return;
	const i = list.findIndex((l) => l.selector === selector && l.listener === listener && l.options === options);
	if (i === -1) return;
	this.removeEventListener(type, list[i]!.callback, options);
	list.splice(i, 1);
}

let installed = false;

/** Adds the helpers to `win`'s prototypes and globals. Safe to call more than once. */
export function installDomHelpers(win: Window & typeof globalThis = window): void {
	if (installed && win === window) return;
	if (win === window) installed = true;

	define(win.Object, {
		isEmpty(object: Record<string, unknown>) {
			for (const key in object) if (Object.prototype.hasOwnProperty.call(object, key)) return false;
			return true;
		},
		each<T>(object: Record<string, T>, callback: (value: T, key?: string) => boolean | void, context?: unknown) {
			for (const key of Object.keys(object)) if (callback.call(context, object[key]!, key) === false) return false;
			return true;
		},
	});
	define(win.Array, {
		combine<T>(arrays: T[][]) {
			return ([] as T[]).concat(...arrays);
		},
	});
	define(win.Array.prototype, {
		first(this: unknown[]) {
			return this[0];
		},
		last(this: unknown[]) {
			return this[this.length - 1];
		},
		contains(this: unknown[], target: unknown) {
			return this.includes(target);
		},
		remove(this: unknown[], target: unknown) {
			for (let i = this.length - 1; i >= 0; i--) if (this[i] === target) this.splice(i, 1);
		},
		shuffle(this: unknown[]) {
			for (let i = this.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[this[i], this[j]] = [this[j], this[i]];
			}
			return this;
		},
		unique(this: unknown[]) {
			return [...new Set(this)];
		},
	});
	define(win.Math, {
		clamp(value: number, min: number, max: number) {
			return Math.min(max, Math.max(min, value));
		},
		square(value: number) {
			return value * value;
		},
	});
	define(win.String, {
		isString(obj: unknown) {
			return typeof obj === 'string' || obj instanceof String;
		},
	});
	define(win.String.prototype, {
		contains(this: string, target: string) {
			return this.includes(target);
		},
		format(this: string, ...args: string[]) {
			return this.replace(/\{(\d+)\}/g, (match, i: string) => args[Number(i)] ?? match);
		},
	});
	define(win.Number, {
		isNumber(obj: unknown) {
			return typeof obj === 'number';
		},
	});

	const nodeProto = win.Node.prototype;
	define(nodeProto, {
		detach(this: Node) {
			this.parentNode?.removeChild(this);
		},
		empty(this: Node) {
			while (this.lastChild) this.removeChild(this.lastChild);
		},
		insertAfter<T extends Node>(this: Node, node: T, child: Node | null): T {
			this.insertBefore(node, child ? child.nextSibling : this.firstChild);
			return node;
		},
		indexOf(this: Node, other: Node) {
			return Array.prototype.indexOf.call(this.childNodes, other);
		},
		setChildrenInPlace(this: Node, children: Node[]) {
			const keep = new Set(children);
			for (const child of [...this.childNodes]) if (!keep.has(child)) this.removeChild(child);
			let ref: ChildNode | null = this.firstChild;
			for (const child of children) {
				if (child === ref) ref = ref.nextSibling;
				else this.insertBefore(child, ref);
			}
		},
		appendText(this: Node, val: string) {
			this.appendChild(docOf(this).createTextNode(val));
		},
		instanceOf(this: Node, type: { new (): unknown }) {
			if (this instanceof type) return true;
			// Same constructor name from another window.
			const proto = Object.getPrototypeOf(this) as { constructor?: { name?: string } } | null;
			for (let p = proto; p; p = Object.getPrototypeOf(p) as typeof p) {
				if (p.constructor?.name === (type as { name?: string }).name) return true;
			}
			return false;
		},
		createEl(this: Node, tag: keyof HTMLElementTagNameMap, o?: DomElementInfo | string, cb?: (el: HTMLElement) => void) {
			return makeEl(docOf(this), this, tag, o, cb);
		},
		createDiv(this: Node, o?: DomElementInfo | string, cb?: (el: HTMLDivElement) => void) {
			return makeEl(docOf(this), this, 'div', o, cb);
		},
		createSpan(this: Node, o?: DomElementInfo | string, cb?: (el: HTMLSpanElement) => void) {
			return makeEl(docOf(this), this, 'span', o, cb);
		},
		createSvg(this: Node, tag: keyof SVGElementTagNameMap, o?: SvgElementInfo | string, cb?: (el: SVGElement) => void) {
			return makeSvg(docOf(this), this, tag, o, cb);
		},
	});
	defineGetters(nodeProto, {
		doc(this: Node) {
			return docOf(this);
		},
		win(this: Node) {
			return docOf(this).defaultView ?? win;
		},
		constructorWin(this: Node) {
			return docOf(this).defaultView ?? win;
		},
	});

	define(win.Element.prototype, {
		getText(this: Element) {
			return this.textContent ?? '';
		},
		setText(this: Element, val: string | DocumentFragment) {
			if (typeof val === 'string') this.textContent = val;
			else this.replaceChildren(val);
		},
		addClass(this: Element, ...classes: string[]) {
			this.classList.add(...classes.flatMap(splitClasses));
		},
		addClasses(this: Element, classes: string[]) {
			this.classList.add(...classes.flatMap(splitClasses));
		},
		removeClass(this: Element, ...classes: string[]) {
			this.classList.remove(...classes.flatMap(splitClasses));
		},
		removeClasses(this: Element, classes: string[]) {
			this.classList.remove(...classes.flatMap(splitClasses));
		},
		toggleClass(this: Element, classes: string | string[], value: boolean) {
			for (const cls of splitClasses(classes)) this.classList.toggle(cls, value);
		},
		hasClass(this: Element, cls: string) {
			return this.classList.contains(cls);
		},
		setAttr(this: Element, name: string, value: string | number | boolean | null) {
			setAttrs(this, { [name]: value });
		},
		setAttrs(this: Element, obj: Attrs) {
			setAttrs(this, obj);
		},
		getAttr(this: Element, name: string) {
			return this.getAttribute(name);
		},
		matchParent(this: Element, selector: string, lastParent?: Element) {
			for (let el: Element | null = this; el; el = el.parentElement) {
				if (el.matches(selector)) return el;
				if (el === lastParent) break;
			}
			return null;
		},
		getCssPropertyValue(this: Element, property: string, pseudoElement?: string) {
			return (docOf(this).defaultView ?? win).getComputedStyle(this, pseudoElement).getPropertyValue(property);
		},
		isActiveElement(this: Element) {
			return docOf(this).activeElement === this;
		},
		find(this: Element, selector: string) {
			return this.querySelector(selector);
		},
		findAll(this: Element, selector: string) {
			return [...this.querySelectorAll(selector)];
		},
		findAllSelf(this: Element, selector: string) {
			const all = [...this.querySelectorAll(selector)];
			return this.matches(selector) ? [this, ...all] : all;
		},
	});

	define(win.DocumentFragment.prototype, {
		find(this: DocumentFragment, selector: string) {
			return this.querySelector(selector);
		},
		findAll(this: DocumentFragment, selector: string) {
			return [...this.querySelectorAll(selector)];
		},
	});

	const htmlProto = win.HTMLElement.prototype;
	define(htmlProto, {
		show(this: HTMLElement) {
			this.style.removeProperty('display');
		},
		hide(this: HTMLElement) {
			this.style.display = 'none';
		},
		toggle(this: HTMLElement, show: boolean) {
			if (show) this.style.removeProperty('display');
			else this.style.display = 'none';
		},
		toggleVisibility(this: HTMLElement, visible: boolean) {
			this.style.visibility = visible ? '' : 'hidden';
		},
		isShown(this: HTMLElement) {
			return this.isConnected && this.offsetParent !== null;
		},
		setCssStyles(this: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
			setCssStyles(this, styles);
		},
		setCssProps(this: HTMLElement, props: Record<string, string>) {
			setCssProps(this, props);
		},
		on: delegateOn,
		off: delegateOff,
		onClickEvent(this: HTMLElement, listener: (ev: MouseEvent) => unknown, options?: boolean | AddEventListenerOptions) {
			this.addEventListener('click', listener, options);
			this.addEventListener('auxclick', listener, options);
		},
		onNodeInserted(this: HTMLElement, listener: () => unknown, once?: boolean) {
			const stop = watchInsertion(win, this, () => {
				if (once) stop();
				listener();
			});
			return stop;
		},
		onWindowMigrated(this: HTMLElement) {
			// EmeraldMD has no popout windows yet, so nodes never migrate.
			return () => {};
		},
		trigger(this: HTMLElement, eventType: string) {
			this.dispatchEvent(new win.Event(eventType, { bubbles: true, cancelable: true }));
		},
	});
	defineGetters(htmlProto, {
		innerWidth(this: HTMLElement) {
			const style = (docOf(this).defaultView ?? win).getComputedStyle(this);
			return this.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
		},
		innerHeight(this: HTMLElement) {
			const style = (docOf(this).defaultView ?? win).getComputedStyle(this);
			return this.clientHeight - parseFloat(style.paddingTop || '0') - parseFloat(style.paddingBottom || '0');
		},
	});

	define(win.SVGElement.prototype, {
		setCssStyles(this: SVGElement, styles: Partial<CSSStyleDeclaration>) {
			setCssStyles(this, styles);
		},
		setCssProps(this: SVGElement, props: Record<string, string>) {
			setCssProps(this, props);
		},
	});

	define(win.Document.prototype, { on: delegateOn, off: delegateOff });

	defineGetters(win.UIEvent.prototype, {
		targetNode(this: UIEvent) {
			return this.target instanceof win.Node ? this.target : null;
		},
		win(this: UIEvent) {
			return this.view ?? win;
		},
		doc(this: UIEvent) {
			return (this.view ?? win).document;
		},
	});
	define(win.UIEvent.prototype, {
		instanceOf(this: UIEvent, type: { new (...data: never[]): unknown }) {
			return this instanceof type || Object.getPrototypeOf(this)?.constructor?.name === type.name;
		},
	});

	const globals: Record<string, unknown> = {
		isBoolean: (obj: unknown) => typeof obj === 'boolean',
		fish: (selector: string) => win.document.querySelector(selector),
		fishAll: (selector: string) => [...win.document.querySelectorAll(selector)],
		createEl: (tag: keyof HTMLElementTagNameMap, o?: DomElementInfo | string, cb?: (el: HTMLElement) => void) =>
			makeEl(win.document, undefined, tag, o, cb),
		createDiv: (o?: DomElementInfo | string, cb?: (el: HTMLDivElement) => void) => makeEl(win.document, undefined, 'div', o, cb),
		createSpan: (o?: DomElementInfo | string, cb?: (el: HTMLSpanElement) => void) =>
			makeEl(win.document, undefined, 'span', o, cb),
		createSvg: (tag: keyof SVGElementTagNameMap, o?: SvgElementInfo | string, cb?: (el: SVGElement) => void) =>
			makeSvg(win.document, undefined, tag, o, cb),
		createFragment: (cb?: (el: DocumentFragment) => void) => {
			const fragment = win.document.createDocumentFragment();
			cb?.(fragment);
			return fragment;
		},
		ajax: (options: AjaxOptions) => void ajaxPromise(win, options).catch(() => {}),
		ajaxPromise: (options: AjaxOptions) => ajaxPromise(win, options),
		ready: (fn: () => unknown) => {
			if (win.document.readyState === 'loading') win.document.addEventListener('DOMContentLoaded', () => fn(), { once: true });
			else fn();
		},
		sleep: (ms: number) => new Promise<void>((resolve) => win.setTimeout(resolve, ms)),
		nextFrame: () => new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve())),
		activeWindow: win,
		activeDocument: win.document,
	};
	for (const [name, value] of Object.entries(globals)) {
		if (name in win && name !== 'activeWindow' && name !== 'activeDocument') continue;
		Object.defineProperty(win, name, { value, configurable: true, writable: true, enumerable: false });
	}
}

function ajaxPromise(win: Window & typeof globalThis, options: AjaxOptions): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const req = new win.XMLHttpRequest();
		options.req = req;
		req.open(options.method ?? 'GET', options.url, true);
		req.withCredentials = options.withCredentials ?? options.data !== undefined;
		for (const [name, value] of Object.entries(options.headers ?? {})) req.setRequestHeader(name, value);
		req.onload = () => {
			if (req.status >= 200 && req.status < 400) {
				options.success?.(req.response, req);
				resolve(req.response);
			} else {
				options.error?.(req.statusText, req);
				reject(req);
			}
		};
		req.onerror = (err) => {
			options.error?.(err, req);
			reject(req);
		};
		const data = options.data;
		if (data === undefined) req.send();
		else if (typeof data === 'string' || data instanceof ArrayBuffer) req.send(data);
		else {
			req.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
			req.send(JSON.stringify(data));
		}
	});
}
