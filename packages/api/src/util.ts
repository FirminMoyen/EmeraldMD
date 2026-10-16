/** Standalone helpers from the plugin API: debounce, YAML, frontmatter, binary, versions. */

import type { CachedMetadata, ReferenceCache } from '@emeraldmd/core';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

/**
 * The plugin API version implemented, matching the pinned `obsidian` typings
 * and `packages/api/API_VERSION` (a test keeps the three in sync).
 */
export const apiVersion = '1.14.4';

export interface Debouncer<T extends unknown[], V> {
	(...args: [...T]): this;
	cancel(): this;
	run(): V | void;
}

/**
 * Calls `cb` once calls stop for `timeout` ms. With `resetTimer` false (the
 * default), the first call schedules the run and later calls only update
 * its arguments.
 */
export function debounce<T extends unknown[], V>(cb: (...args: [...T]) => V, timeout = 0, resetTimer = false): Debouncer<T, V> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: T | null = null;
	const run = (): V | void => {
		clearTimeout(timer);
		timer = undefined;
		if (!pending) return;
		const args = pending;
		pending = null;
		return cb(...args);
	};
	const debouncer = function (this: unknown, ...args: [...T]) {
		pending = args as T;
		if (timer === undefined || resetTimer) {
			clearTimeout(timer);
			timer = setTimeout(run, timeout);
		}
		return debouncer;
	} as Debouncer<T, V>;
	debouncer.cancel = () => {
		clearTimeout(timer);
		timer = undefined;
		pending = null;
		return debouncer;
	};
	debouncer.run = run;
	return debouncer;
}

function compareVersions(a: string, b: string): number {
	const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
	const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** True if the implemented API version is at least `version`. */
export function requireApiVersion(version: string): boolean {
	return compareVersions(apiVersion, version) >= 0;
}

export { compareVersions };

export function getLanguage(): string {
	return 'en';
}

export function parseYaml(yaml: string): unknown {
	return yamlParse(yaml) ?? null;
}

export function stringifyYaml(obj: unknown): string {
	return yamlStringify(obj);
}

export interface FrontMatterInfo {
	exists: boolean;
	frontmatter: string;
	from: number;
	to: number;
	contentStart: number;
}

export function getFrontMatterInfo(content: string): FrontMatterInfo {
	const match = /^---\r?\n([\s\S]*?)(?:\r?\n)?^---[ \t]*(?:\r?\n|$)/m.exec(content);
	if (!match || match.index !== 0) return { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 };
	const from = content.indexOf('\n') + 1;
	const frontmatter = match[1] ?? '';
	return { exists: true, frontmatter, from, to: from + frontmatter.length, contentStart: match[0].length };
}

export function parseFrontMatterEntry(frontmatter: Record<string, unknown> | null, key: string | RegExp): unknown {
	if (!frontmatter) return null;
	if (typeof key === 'string') return frontmatter[key] ?? null;
	for (const [k, v] of Object.entries(frontmatter)) if (key.test(k)) return v;
	return null;
}

export function parseFrontMatterStringArray(frontmatter: Record<string, unknown> | null, key: string | RegExp): string[] | null {
	const value = parseFrontMatterEntry(frontmatter, key);
	if (value === null || value === undefined) return null;
	const list = Array.isArray(value) ? value : String(value).split(/[,\n]/);
	const out = list.map((v) => String(v).trim()).filter((v) => v !== '');
	return out.length ? out : null;
}

export function parseFrontMatterAliases(frontmatter: Record<string, unknown> | null): string[] | null {
	return parseFrontMatterStringArray(frontmatter, /^alias(es)?$/i);
}

export function parseFrontMatterTags(frontmatter: Record<string, unknown> | null): string[] | null {
	const value = parseFrontMatterEntry(frontmatter, /^tags?$/i);
	if (value === null || value === undefined) return null;
	const list = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
	const tags = list
		.map((t) => String(t).trim())
		.filter((t) => t !== '')
		.map((t) => (t.startsWith('#') ? t : '#' + t));
	return tags.length ? tags : null;
}

export function getAllTags(cache: CachedMetadata): string[] | null {
	const tags = [...(parseFrontMatterTags(cache.frontmatter ?? null) ?? []), ...(cache.tags ?? []).map((t) => t.tag)];
	return tags.length ? tags : null;
}

export function iterateRefs<T extends { link: string }>(refs: T[], cb: (ref: T) => boolean | void): boolean {
	for (const ref of refs) if (cb(ref)) return true;
	return false;
}

export function iterateCacheRefs(cache: CachedMetadata, cb: (ref: ReferenceCache) => boolean | void): boolean {
	return iterateRefs(cache.links ?? [], cb) || iterateRefs(cache.embeds ?? [], cb);
}

/** Heading text with characters that cannot appear in links removed. */
export function stripHeading(heading: string): string {
	return heading.replace(/[!"#$%&()*+,.:;<=>?@^`{|}~/[\]\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function stripHeadingForLink(heading: string): string {
	return heading.replace(/[#|^\\[\]:]/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface SubpathResult {
	start: { line: number; col: number; offset: number };
	end: { line: number; col: number; offset: number } | null;
}

export function resolveSubpath(cache: CachedMetadata, subpath: string): (SubpathResult & { type: string; [key: string]: unknown }) | null {
	const parts = subpath.split('#').filter((p) => p !== '');
	if (parts.length === 0) return null;
	const last = parts[parts.length - 1]!;
	if (last.startsWith('^')) {
		const block = cache.blocks?.[last.slice(1).toLowerCase()];
		if (!block) return null;
		return { type: 'block', block, start: block.position.start, end: block.position.end, list: undefined };
	}
	const headings = cache.headings ?? [];
	let index = -1;
	let from = 0;
	for (const part of parts) {
		const wanted = stripHeading(part).toLowerCase();
		index = headings.findIndex((h, i) => i >= from && stripHeading(h.heading).toLowerCase() === wanted);
		if (index === -1) return null;
		from = index + 1;
	}
	const heading = headings[index]!;
	const next = headings.slice(index + 1).find((h) => h.level <= heading.level);
	return { type: 'heading', current: heading, next: next ?? null, start: heading.position.start, end: next ? next.position.start : null };
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

export function arrayBufferToHex(data: ArrayBuffer): string {
	return [...new Uint8Array(data)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToArrayBuffer(hex: string): ArrayBuffer {
	const bytes = new Uint8Array(Math.floor(hex.length / 2));
	for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return bytes.buffer;
}

export async function getBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
	return blob.arrayBuffer();
}

const ALLOWED_TAGS = new Set(
	'a abbr b blockquote br code del details div em h1 h2 h3 h4 h5 h6 hr i img kbd li mark ol p pre s small span strong sub summary sup table tbody td th thead tr u ul'.split(' '),
);
const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'title', 'class', 'colspan', 'rowspan', 'width', 'height', 'open']);

/** Parses HTML into a fragment, keeping only inert elements and attributes. */
export function sanitizeHTMLToDom(html: string): DocumentFragment {
	const template = document.createElement('template');
	template.innerHTML = html;
	const clean = (node: Node) => {
		for (const child of [...node.childNodes]) {
			if (child.nodeType === Node.ELEMENT_NODE) {
				const el = child as Element;
				if (!ALLOWED_TAGS.has(el.tagName.toLowerCase())) {
					if (/^(script|style|iframe|object|embed|template)$/i.test(el.tagName)) el.remove();
					else el.replaceWith(...el.childNodes);
					clean(node);
					return;
				}
				for (const attr of [...el.attributes]) {
					const unsafeUrl = (attr.name === 'href' || attr.name === 'src') && /^\s*javascript:/i.test(attr.value);
					if (!ALLOWED_ATTRS.has(attr.name) || unsafeUrl) el.removeAttribute(attr.name);
				}
				clean(el);
			} else if (child.nodeType !== Node.TEXT_NODE) {
				child.remove();
			}
		}
	};
	clean(template.content);
	return template.content;
}

/** Converts simple HTML to Markdown: headings, emphasis, code, links, images, lists and paragraphs. */
export function htmlToMarkdown(html: string | HTMLElement | Document | DocumentFragment): string {
	let root: Node;
	if (typeof html === 'string') {
		const template = document.createElement('template');
		template.innerHTML = html;
		root = template.content;
	} else root = html instanceof Document ? html.body : html;
	const walk = (node: Node, listDepth: number): string => {
		if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\s+/g, ' ');
		if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';
		const el = node as Element;
		const inner = () => [...node.childNodes].map((c) => walk(c, listDepth)).join('');
		const tag = el.tagName?.toLowerCase() ?? '';
		switch (tag) {
			case 'h1':
			case 'h2':
			case 'h3':
			case 'h4':
			case 'h5':
			case 'h6':
				return `\n\n${'#'.repeat(Number(tag[1]))} ${inner().trim()}\n\n`;
			case 'p':
			case 'div':
				return `\n\n${inner().trim()}\n\n`;
			case 'br':
				return '\n';
			case 'strong':
			case 'b':
				return `**${inner()}**`;
			case 'em':
			case 'i':
				return `*${inner()}*`;
			case 'del':
			case 's':
				return `~~${inner()}~~`;
			case 'code':
				return el.parentElement?.tagName.toLowerCase() === 'pre' ? inner() : `\`${inner()}\``;
			case 'pre':
				return `\n\n\`\`\`\n${el.textContent ?? ''}\n\`\`\`\n\n`;
			case 'a':
				return `[${inner()}](${el.getAttribute('href') ?? ''})`;
			case 'img':
				return `![${el.getAttribute('alt') ?? ''}](${el.getAttribute('src') ?? ''})`;
			case 'blockquote':
				return '\n\n' + inner().trim().split('\n').map((l) => `> ${l}`).join('\n') + '\n\n';
			case 'hr':
				return '\n\n---\n\n';
			case 'ul':
			case 'ol': {
				let n = 0;
				const items = [...el.children]
					.filter((c) => c.tagName.toLowerCase() === 'li')
					.map((li) => {
						const marker = tag === 'ol' ? `${++n}.` : '-';
						return `${'\t'.repeat(listDepth)}${marker} ${[...li.childNodes].map((c) => walk(c, listDepth + 1)).join('').trim()}`;
					});
				return `\n${items.join('\n')}\n`;
			}
			default:
				return inner();
		}
	};
	return walk(root, 0).replace(/\n{3,}/g, '\n\n').trim();
}
