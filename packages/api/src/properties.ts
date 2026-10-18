/**
 * The properties editor: a note's frontmatter as rows of name and value,
 * shown above the note in Live Preview and the reading view.
 *
 * DOM as themes expect it: `.metadata-container > .metadata-properties-heading
 * + .metadata-content > .metadata-properties > .metadata-property
 * [data-property-key][data-property-type] > (.metadata-property-key >
 * .metadata-property-icon + input.metadata-property-key-input) +
 * .metadata-property-value`, then `.metadata-add-button`. Lists are
 * `.multi-select-container > .multi-select-pill`.
 *
 * Value types come from `app.metadataTypeManager` (`.obsidian/types.json`),
 * else from the value. Changes go through `save` with all the properties, in
 * order; the caller writes them to the note.
 */

import { stringify } from 'yaml';
import type { App } from './app';
import { setIcon } from './icons';
import { Keymap } from './keymap';
import { Menu } from './menu';
import { parseYaml } from './util';

export type PropertyType = 'text' | 'multitext' | 'number' | 'checkbox' | 'date' | 'datetime' | 'tags' | 'aliases' | 'unknown';

/** The types offered in a property's menu, with their names and icons. */
const TYPES: { type: PropertyType; name: string; icon: string }[] = [
	{ type: 'text', name: 'Text', icon: 'text' },
	{ type: 'multitext', name: 'List', icon: 'list' },
	{ type: 'number', name: 'Number', icon: 'binary' },
	{ type: 'checkbox', name: 'Checkbox', icon: 'square-check' },
	{ type: 'date', name: 'Date', icon: 'calendar' },
	{ type: 'datetime', name: 'Date & time', icon: 'clock' },
];
const ICONS: Record<string, string> = { ...Object.fromEntries(TYPES.map((t) => [t.type, t.icon])), tags: 'tags', aliases: 'forward', unknown: 'file-question' };
const LIST_TYPES = new Set<string>(['multitext', 'tags', 'aliases']);
const WIKILINK = /^\[\[([^\]]+)\]\]$/;

/** Frontmatter YAML for `data`, as Obsidian writes it: empty values stay empty, long strings on one line. */
export function stringifyFrontmatter(data: Record<string, unknown>): string {
	return Object.keys(data).length ? stringify(data, { nullStr: '', lineWidth: 0 }) : '';
}

let lastChecked: { yaml: string; valid: boolean } | null = null;

/** Whether frontmatter YAML can be shown as properties (a mapping, or nothing). */
export function isPropertiesYaml(yaml: string): boolean {
	if (lastChecked?.yaml === yaml) return lastChecked.valid;
	let valid: boolean;
	try {
		const data = parseYaml(yaml);
		valid = data === null || (typeof data === 'object' && !Array.isArray(data));
	} catch {
		valid = false;
	}
	lastChecked = { yaml, valid };
	return valid;
}

/** A value converted to `type`, when the user changes a property's type. */
function convert(value: unknown, type: string): unknown {
	const empty = value === null || value === undefined || value === '';
	if (LIST_TYPES.has(type)) return empty ? [] : Array.isArray(value) ? value : [String(value)];
	const single = Array.isArray(value) ? value.map(String).join(', ') : value;
	switch (type) {
		case 'number': {
			const n = Number(single);
			return empty || !Number.isFinite(n) ? null : n;
		}
		case 'checkbox':
			return single === true || single === 'true';
		case 'date':
			return typeof single === 'string' && /^\d{4}-\d{2}-\d{2}/.test(single) ? single.slice(0, 10) : null;
		case 'datetime':
			return typeof single === 'string' && /^\d{4}-\d{2}-\d{2}/.test(single) ? (single.length > 10 ? single.slice(0, 16) : `${single}T00:00`) : null;
		default:
			return empty || typeof single === 'object' ? (empty ? null : single) : String(single);
	}
}

export interface PropertiesEditorOptions {
	/** The note the properties belong to (links resolve from it). */
	sourcePath(): string;
	/** Saves all the properties, in order. Without it, the properties are read only. */
	save?(data: Record<string, unknown>): void;
}

export class PropertiesEditor {
	readonly containerEl: HTMLElement;
	private readonly propertiesEl: HTMLElement;
	private data: Record<string, unknown> = {};
	/** The YAML or data shown, so a change that comes back from our own save does not redraw. */
	private shown: string | null = null;
	private rendered = false;
	private readonly onTypesChanged = () => this.render();

	constructor(
		private readonly app: App,
		parentEl: HTMLElement,
		private readonly options: PropertiesEditorOptions,
	) {
		this.containerEl = parentEl.createDiv({ cls: 'metadata-container', attr: { tabindex: '-1' } });
		const heading = this.containerEl.createDiv({ cls: 'metadata-properties-heading', attr: { tabindex: '0' } });
		heading.createDiv({ cls: 'metadata-properties-title', text: 'Properties' });
		heading.addEventListener('click', () => this.containerEl.toggleClass('is-collapsed', !this.containerEl.hasClass('is-collapsed')));
		const content = this.containerEl.createDiv('metadata-content');
		this.propertiesEl = content.createDiv('metadata-properties');
		if (options.save) {
			const add = content.createDiv({ cls: 'metadata-add-button text-icon-button', attr: { tabindex: '0' } });
			setIcon(add.createSpan('text-button-icon'), 'plus');
			add.createSpan({ cls: 'text-button-label', text: 'Add property' });
			add.addEventListener('click', () => this.addProperty());
			add.addEventListener('keydown', (event) => {
				if (event.key === 'Enter') this.addProperty();
			});
		}
		this.containerEl.toggleClass('is-read-only', !options.save);
		app.metadataTypeManager.on('changed', this.onTypesChanged);
	}

	/** Shows the properties in `yaml` (a frontmatter's text); false if it is not valid YAML. */
	setYaml(yaml: string): boolean {
		if (yaml === this.shown) return true;
		let data: unknown;
		try {
			data = parseYaml(yaml);
		} catch {
			return false;
		}
		if (data !== null && (typeof data !== 'object' || Array.isArray(data))) return false;
		this.setData((data ?? {}) as Record<string, unknown>);
		this.shown = yaml;
		return true;
	}

	setData(data: Record<string, unknown>): void {
		if (this.rendered && JSON.stringify(data) === JSON.stringify(this.data)) return;
		this.rendered = true;
		this.data = { ...data };
		this.shown = null;
		this.render();
	}

	destroy(): void {
		this.app.metadataTypeManager.off('changed', this.onTypesChanged);
		this.containerEl.detach();
	}

	/** A new property: a row whose name is typed first. */
	addProperty(): void {
		if (!this.options.save) return;
		this.containerEl.removeClass('is-collapsed');
		this.propertiesEl.querySelector('.metadata-property.is-new')?.remove();
		const row = this.propertiesEl.createDiv({ cls: 'metadata-property is-new', attr: { 'data-property-key': '', 'data-property-type': 'text' } });
		const keyEl = row.createDiv('metadata-property-key');
		setIcon(keyEl.createSpan('metadata-property-icon'), ICONS.text!);
		const input = this.keyInput(keyEl, '');
		row.createDiv('metadata-property-value');
		let done = false;
		const finish = (accept: boolean) => {
			if (done) return;
			done = true;
			const name = input.value.trim();
			if (!accept || !name || this.has(name)) {
				row.remove();
				if (accept && name) this.focusValue(name);
				return;
			}
			const type = this.app.metadataTypeManager.getAssignedType(name) ?? this.app.metadataTypeManager.getPropertyInfo(name)?.type ?? 'text';
			this.data[name] = LIST_TYPES.has(type) ? [] : type === 'checkbox' ? false : null;
			this.commit();
			this.render();
			this.focusValue(name);
		};
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === 'Tab') {
				event.preventDefault();
				finish(true);
			} else if (event.key === 'Escape') {
				finish(false);
			}
		});
		input.addEventListener('blur', () => finish(true));
		input.focus();
	}

	private has(name: string): boolean {
		return Object.keys(this.data).some((key) => key.toLowerCase() === name.toLowerCase());
	}

	private commit(): void {
		this.containerEl.dataset.propertyCount = String(Object.keys(this.data).length);
		this.options.save?.({ ...this.data });
	}

	private render(): void {
		this.propertiesEl.empty();
		const keys = Object.keys(this.data);
		this.containerEl.dataset.propertyCount = String(keys.length);
		for (const key of keys) this.renderRow(key);
	}

	private typeOf(key: string, value: unknown): string {
		const types = this.app.metadataTypeManager;
		const assigned = types.getAssignedType(key);
		if (assigned) return assigned;
		if (value !== null && typeof value === 'object' && !Array.isArray(value)) return 'unknown';
		return types.getTypeInfo(key, value === null ? undefined : value).inferred?.type ?? 'text';
	}

	private renderRow(key: string): void {
		const value = this.data[key];
		const type = this.typeOf(key, value);
		const row = this.propertiesEl.createDiv({ cls: 'metadata-property', attr: { tabindex: '0', 'data-property-key': key, 'data-property-type': type } });
		const keyEl = row.createDiv('metadata-property-key');
		const icon = keyEl.createSpan({ cls: 'metadata-property-icon', attr: { 'aria-label': TYPES.find((t) => t.type === type)?.name ?? type } });
		setIcon(icon, ICONS[type] ?? 'text');
		if (this.options.save) icon.addEventListener('click', (event) => this.showMenu(event, key, type));
		const input = this.keyInput(keyEl, key);
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') input.blur();
			if (event.key === 'Escape') {
				input.value = key;
				input.blur();
			}
		});
		input.addEventListener('change', () => this.rename(key, input.value));
		this.renderValue(row.createDiv('metadata-property-value'), key, type, value);
	}

	private keyInput(parent: HTMLElement, key: string): HTMLInputElement {
		const input = parent.createEl('input', { cls: 'metadata-property-key-input', attr: { type: 'text', autocapitalize: 'none', enterkeyhint: 'next', 'aria-label': key || 'Property name' } });
		input.value = key;
		input.readOnly = !this.options.save;
		if (this.options.save) {
			// Names already used in the vault, as suggestions.
			const list = parent.createEl('datalist');
			list.id = `metadata-names-${Math.random().toString(36).slice(2)}`;
			input.setAttribute('list', list.id);
			input.addEventListener('focus', () => {
				if (list.hasChildNodes()) return;
				for (const info of Object.values(this.app.metadataTypeManager.getAllProperties())) list.createEl('option', { attr: { value: info.name } });
			});
		}
		return input;
	}

	private rename(key: string, name: string): void {
		name = name.trim();
		if (name === key) return;
		if (!name) return this.remove(key);
		if (name.toLowerCase() !== key.toLowerCase() && this.has(name)) {
			this.render();
			return;
		}
		this.data = Object.fromEntries(Object.entries(this.data).map(([k, v]) => [k === key ? name : k, v]));
		this.commit();
		this.render();
	}

	private remove(key: string): void {
		delete this.data[key];
		this.commit();
		this.render();
	}

	private set(key: string, value: unknown): void {
		if (JSON.stringify(this.data[key]) === JSON.stringify(value)) return;
		this.data[key] = value;
		this.commit();
	}

	private showMenu(event: MouseEvent, key: string, type: string): void {
		const menu = new Menu();
		for (const t of TYPES) {
			menu.addItem((item) =>
				item
					.setTitle(t.name)
					.setIcon(t.icon)
					.setSection('type')
					.setChecked(t.type === type)
					.onClick(() => {
						if (t.type === type) return;
						this.data[key] = convert(this.data[key], t.type);
						this.app.metadataTypeManager.setType(key, t.type);
						this.commit();
						this.render();
					}),
			);
		}
		menu.addItem((item) => item.setTitle('Remove').setIcon('trash-2').setSection('danger').setWarning(true).onClick(() => this.remove(key)));
		menu.showAtMouseEvent(event);
	}

	private focusValue(key: string): void {
		const row = [...this.propertiesEl.querySelectorAll<HTMLElement>('.metadata-property')].find((el) => el.dataset.propertyKey === key);
		row?.querySelector<HTMLElement>('.metadata-property-value input, .metadata-property-value [contenteditable="true"]')?.focus();
	}

	private renderValue(el: HTMLElement, key: string, type: string, value: unknown): void {
		const readOnly = !this.options.save;
		if (LIST_TYPES.has(type)) return this.renderList(el, key, type, value);
		if (type === 'checkbox') {
			const box = el.createEl('input', { cls: 'metadata-input-checkbox', attr: { type: 'checkbox', 'data-indeterminate': String(value === null || value === undefined) } });
			box.checked = value === true;
			box.disabled = readOnly;
			box.addEventListener('change', () => this.set(key, box.checked));
			return;
		}
		if (type === 'number' || type === 'date' || type === 'datetime') {
			const input = el.createEl('input', {
				cls: `metadata-input metadata-input-${type === 'number' ? 'number' : 'text'}${type === 'number' ? '' : ' mod-date'}`,
				attr: { type: type === 'number' ? 'number' : type === 'date' ? 'date' : 'datetime-local', placeholder: 'Empty' },
			});
			input.value = value === null || value === undefined ? '' : String(value).slice(0, type === 'date' ? 10 : 16);
			input.readOnly = readOnly;
			input.addEventListener('change', () => {
				if (type === 'number') this.set(key, input.value === '' ? null : Number(input.value));
				else this.set(key, input.value || null);
			});
			return;
		}
		if (type === 'unknown') {
			el.createDiv({ cls: 'metadata-input-longtext mod-unknown', text: JSON.stringify(value) });
			return;
		}
		this.renderText(el, key, value);
	}

	/** Text: editable in place; a lone `[[link]]` shows as a link until it is edited. */
	private renderText(el: HTMLElement, key: string, value: unknown): void {
		const text = value === null || value === undefined ? '' : String(value);
		const field = el.createDiv({ cls: 'metadata-input-longtext mod-truncate', attr: { 'data-placeholder': 'Empty' } });
		const show = (current: string) => {
			field.empty();
			const link = WIKILINK.exec(current);
			if (!link) {
				field.textContent = current;
				return;
			}
			const linktext = link[1]!.split('|')[0]!;
			const resolved = this.app.metadataCache.getFirstLinkpathDest(linktext.split('#')[0]!, this.options.sourcePath());
			const a = field.createEl('a', { cls: ['internal-link', ...(resolved ? [] : ['is-unresolved'])], text: link[1]!.split('|')[1] ?? linktext, attr: { href: linktext, 'data-href': linktext } });
			a.addEventListener('mousedown', (event) => event.preventDefault());
			a.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				void this.app.workspace.openLinkText(linktext, this.options.sourcePath(), Keymap.isModEvent(event));
			});
		};
		show(text);
		if (!this.options.save) return;
		field.contentEditable = 'true';
		field.spellcheck = false;
		let current = text;
		field.addEventListener('focus', () => {
			if (field.textContent !== current) field.textContent = current;
		});
		field.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				field.blur();
			} else if (event.key === 'Escape') {
				field.textContent = current;
				field.blur();
			}
		});
		field.addEventListener('blur', () => {
			const next = (field.textContent ?? '').trim();
			if (next !== current) {
				current = next;
				this.set(key, next === '' ? null : next);
			}
			show(current);
		});
	}

	/** Lists (List, tags, aliases): pills, and a field to add one (Enter or comma). */
	private renderList(el: HTMLElement, key: string, type: string, value: unknown): void {
		const items = (Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value]).map((v) => String(v));
		const container = el.createDiv('multi-select-container');
		const save = (next: string[], refocus: boolean) => {
			this.set(key, next);
			this.render();
			if (refocus) this.focusValue(key);
		};
		items.forEach((item, i) => {
			const pill = container.createDiv({ cls: 'multi-select-pill', attr: { tabindex: '0', 'data-value': item } });
			pill.createDiv({ cls: 'multi-select-pill-content', text: type === 'tags' ? item.replace(/^#/, '') : item });
			if (!this.options.save) return;
			const removeEl = pill.createDiv({ cls: 'multi-select-pill-remove-button', attr: { 'aria-label': 'Remove' } });
			setIcon(removeEl, 'x');
			removeEl.addEventListener('click', () => save(items.filter((_, j) => j !== i), false));
			pill.addEventListener('keydown', (event) => {
				if (event.key === 'Backspace' || event.key === 'Delete') save(items.filter((_, j) => j !== i), true);
			});
		});
		if (!this.options.save) return;
		const input = container.createDiv({ cls: 'multi-select-input', attr: { contenteditable: 'true', tabindex: '0', 'data-placeholder': items.length ? '' : 'Empty' } });
		input.spellcheck = false;
		const add = (refocus: boolean) => {
			const added = (input.textContent ?? '')
				.split(',')
				.map((s) => (type === 'tags' ? s.trim().replace(/^#/, '') : s.trim()))
				.filter((s) => s && !items.includes(s));
			input.textContent = '';
			if (added.length) save([...items, ...added], refocus);
		};
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ',') {
				event.preventDefault();
				add(true);
			} else if (event.key === 'Backspace' && !input.textContent && items.length) {
				event.preventDefault();
				save(items.slice(0, -1), true);
			} else if (event.key === 'Escape') {
				input.textContent = '';
				input.blur();
			}
		});
		input.addEventListener('blur', () => add(false));
	}
}
