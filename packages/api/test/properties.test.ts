// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src';
import { isPropertiesYaml, PropertiesEditor, stringifyFrontmatter } from '../src';
import { createTestApp } from '../src/testing';

afterEach(() => document.body.replaceChildren());

async function setup(yaml: string, options: { readOnly?: boolean } = {}) {
	const { app } = await createTestApp({ 'Note.md': '', 'Plan.md': '' }, {});
	const saved: Record<string, unknown>[] = [];
	const editor = new PropertiesEditor(app, document.body, {
		sourcePath: () => 'Note.md',
		save: options.readOnly ? undefined : (data) => saved.push(data),
	});
	expect(editor.setYaml(yaml)).toBe(true);
	const row = (key: string) => document.querySelector<HTMLElement>(`.metadata-property[data-property-key="${key}"]`)!;
	return { app, editor, saved, row };
}

const keydown = (el: Element, key: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('PropertiesEditor', () => {
	it('shows each property with the widget for its type, in the DOM themes style', async () => {
		const { row } = await setup('title: Plan\ntags: [work, "#urgent"]\ncount: 3\ndone: true\ndue: 2026-10-18\nat: 2026-10-18T09:30\nup: "[[Plan]]"\nempty:\nnested: { a: 1 }\n');
		const types = [...document.querySelectorAll<HTMLElement>('.metadata-container .metadata-property')].map((el) => `${el.dataset.propertyKey}:${el.dataset.propertyType}`);
		expect(types).toEqual(['title:text', 'tags:tags', 'count:number', 'done:checkbox', 'due:date', 'at:datetime', 'up:text', 'empty:text', 'nested:unknown']);
		expect(row('title').querySelector<HTMLInputElement>('input.metadata-property-key-input')!.value).toBe('title');
		expect(row('title').querySelector('.metadata-property-icon svg')).not.toBeNull();
		expect(row('title').querySelector('.metadata-input-longtext')!.textContent).toBe('Plan');
		expect([...row('tags').querySelectorAll('.multi-select-pill-content')].map((el) => el.textContent)).toEqual(['work', 'urgent']);
		expect(row('count').querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('3');
		expect(row('done').querySelector<HTMLInputElement>('input.metadata-input-checkbox')!.checked).toBe(true);
		expect(row('due').querySelector<HTMLInputElement>('input[type="date"]')!.value).toBe('2026-10-18');
		expect(row('at').querySelector<HTMLInputElement>('input[type="datetime-local"]')!.value).toBe('2026-10-18T09:30');
		// A lone link shows as a link, resolved against the note.
		const link = row('up').querySelector('a.internal-link')!;
		expect(link.textContent).toBe('Plan');
		expect(link.classList.contains('is-unresolved')).toBe(false);
		expect(document.querySelector('.metadata-add-button')).not.toBeNull();
	});

	it('saves edited values, all properties in order', async () => {
		const { saved, row } = await setup('title: Plan\ncount: 3\ndone: false\n');
		const title = row('title').querySelector<HTMLElement>('.metadata-input-longtext')!;
		title.dispatchEvent(new FocusEvent('focus'));
		title.textContent = 'Roadmap';
		title.dispatchEvent(new FocusEvent('blur'));
		const count = row('count').querySelector<HTMLInputElement>('.metadata-property-value input')!;
		count.value = '7';
		count.dispatchEvent(new Event('change'));
		const done = row('done').querySelector<HTMLInputElement>('.metadata-property-value input')!;
		done.checked = true;
		done.dispatchEvent(new Event('change'));
		expect(saved).toEqual([
			{ title: 'Roadmap', count: 3, done: false },
			{ title: 'Roadmap', count: 7, done: false },
			{ title: 'Roadmap', count: 7, done: true },
		]);
	});

	it('adds and removes list items as pills', async () => {
		const { saved, row } = await setup('tags:\n  - work\n');
		const input = row('tags').querySelector<HTMLElement>('.multi-select-input')!;
		input.textContent = '#home, later';
		keydown(input, 'Enter');
		expect(saved.at(-1)).toEqual({ tags: ['work', 'home', 'later'] });
		expect([...row('tags').querySelectorAll('.multi-select-pill')].map((el) => el.textContent)).toEqual(['work', 'home', 'later']);
		row('tags').querySelector<HTMLElement>('.multi-select-pill-remove-button')!.click();
		expect(saved.at(-1)).toEqual({ tags: ['home', 'later'] });
		keydown(row('tags').querySelector('.multi-select-input')!, 'Backspace');
		expect(saved.at(-1)).toEqual({ tags: ['home'] });
	});

	it('renames, adds and removes properties', async () => {
		const { saved, row } = await setup('a: 1\nb: two\n');
		const key = row('a').querySelector<HTMLInputElement>('.metadata-property-key-input')!;
		key.value = 'first';
		key.dispatchEvent(new Event('change'));
		expect(saved.at(-1)).toEqual({ first: 1, b: 'two' });

		document.querySelector<HTMLElement>('.metadata-add-button')!.click();
		const name = document.querySelector<HTMLInputElement>('.metadata-property.is-new .metadata-property-key-input')!;
		expect(document.activeElement).toBe(name);
		name.value = 'status';
		keydown(name, 'Enter');
		expect(saved.at(-1)).toEqual({ first: 1, b: 'two', status: null });
		expect(row('status')).not.toBeNull();

		// Clearing a name removes the property.
		const b = row('b').querySelector<HTMLInputElement>('.metadata-property-key-input')!;
		b.value = '';
		b.dispatchEvent(new Event('change'));
		expect(saved.at(-1)).toEqual({ first: 1, status: null });
	});

	it('changes a property’s type from its icon, for the whole vault', async () => {
		const { app, saved, row } = await setup('topics: one\n');
		row('topics').querySelector<HTMLElement>('.metadata-property-icon')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		const items = [...document.querySelectorAll<HTMLElement>('.menu .menu-item')];
		expect(items.map((item) => item.textContent)).toEqual(['Text', 'List', 'Number', 'Checkbox', 'Date', 'Date & time', 'Remove']);
		items[1]!.click();
		expect(saved.at(-1)).toEqual({ topics: ['one'] });
		expect(app.metadataTypeManager.getAssignedType('topics')).toBe('multitext');
		await vi.waitFor(() => expect(row('topics').dataset.propertyType).toBe('multitext'));
	});

	it('does not redraw for the YAML its own save produced, so the field being edited keeps the focus', async () => {
		const { editor, row, saved } = await setup('title: Plan\n');
		const field = row('title').querySelector<HTMLElement>('.metadata-input-longtext')!;
		field.textContent = 'Plan B';
		field.dispatchEvent(new FocusEvent('blur'));
		editor.setYaml(stringifyFrontmatter(saved.at(-1)!));
		expect(row('title').querySelector('.metadata-input-longtext')).toBe(field);
		editor.setYaml('title: Other\n');
		expect(row('title').querySelector('.metadata-input-longtext')!.textContent).toBe('Other');
	});

	it('is read only without save', async () => {
		const { row } = await setup('title: Plan\n', { readOnly: true });
		expect(document.querySelector('.metadata-add-button')).toBeNull();
		expect(row('title').querySelector<HTMLInputElement>('.metadata-property-key-input')!.readOnly).toBe(true);
		expect(row('title').querySelector('.metadata-input-longtext')!.getAttribute('contenteditable')).not.toBe('true');
	});

	it('refuses YAML that is not a mapping', () => {
		expect(isPropertiesYaml('a: 1')).toBe(true);
		expect(isPropertiesYaml('')).toBe(true);
		expect(isPropertiesYaml('- a\n- b')).toBe(false);
		expect(isPropertiesYaml('a: [1')).toBe(false);
		expect(stringifyFrontmatter({ empty: null, tags: ['a', 'b'] })).toBe('empty:\ntags:\n  - a\n  - b\n');
	});
});
