// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { CachedMetadata, LinkSets, ReferenceCache, TFile } from '@emeraldmd/core';
import '../src';
import { Component, getFrontMatterInfo, MarkdownRenderer, parseYaml, Plugin, BasesView, StringValue, type App } from '../src';
import { evaluateFormula } from '../src/bases/formula';
import { BasesContainer } from '../src/bases/container';
import { type Bases, replaceCodeBlock } from '../src/bases/plugin';
import { normalizePropertyId, parseBaseConfig, QueryController, serializeBaseConfig, type BasesConfigFile } from '../src/bases/query';
import { editProperty, parsePropertyInput } from '../src/bases/view';
import { DateValue, displayText, DurationValue, ErrorValue, ListValue, NumberValue } from '../src/bases/values';
import { createTestApp } from '../src/testing';

afterEach(() => document.body.replaceChildren());

/** What the Rust index reports for `text`: frontmatter, `#tags` and `[[links]]`. */
function metadataOf(text: string): CachedMetadata {
	const info = getFrontMatterInfo(text);
	const pos = (offset: number) => ({ line: 0, col: offset, offset });
	const links: ReferenceCache[] = [];
	for (const m of text.matchAll(/(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
		links.push({ link: m[1]!, original: m[0], displayText: m[2] ?? m[1]!, position: { start: pos(m.index), end: pos(m.index + m[0].length) } });
	}
	const tags = [...text.slice(info.contentStart).matchAll(/(?:^|\s)(#[\w/-]+)/g)].map((m) => ({ tag: m[1]!, position: { start: pos(m.index), end: pos(m.index) } }));
	const frontmatter = info.exists ? (parseYaml(info.frontmatter) as Record<string, unknown>) : undefined;
	return { links, tags, ...(frontmatter ? { frontmatter } : {}) } as CachedMetadata;
}

async function setup(files: Record<string, string>, config: Record<string, string> = {}) {
	const test = await createTestApp(files, config);
	await test.app.internalPlugins.load(test.app);
	const metadata: Record<string, CachedMetadata> = {};
	const links: Record<string, LinkSets> = {};
	for (const [path, text] of Object.entries(files)) {
		if (!path.endsWith('.md')) continue;
		metadata[path] = metadataOf(text);
		const resolved: Record<string, number> = {};
		const unresolved: Record<string, number> = {};
		for (const ref of metadata[path]!.links ?? []) {
			const target = Object.keys(files).find((p) => p === `${ref.link}.md` || p.endsWith(`/${ref.link}.md`));
			if (target) resolved[target] = (resolved[target] ?? 0) + 1;
			else unresolved[ref.link] = (unresolved[ref.link] ?? 0) + 1;
		}
		links[path] = { resolved, unresolved };
	}
	test.app.vault.applyUpdate({ renamed: [], removed: [], upserted: [], metadata, links });
	const file = (path: string) => test.app.vault.getFileByPath(path) as TFile;
	const bases = test.app.internalPlugins.getEnabledPluginById('bases') as Bases;
	return { ...test, file, bases };
}

const BOOKS = {
	'Books/Dune.md': '---\nauthor: Frank Herbert\nrating: 5\nprice: 12.5\nread: true\nfinished: 2025-01-10\ntags: [book, scifi/classic]\n---\nA desert. See [[Foundation]].',
	'Books/Foundation.md': '---\nauthor: Isaac Asimov\nrating: 4\nprice: 8\nread: false\nfinished: 2024-06-01\ntags: [book]\n---\nPsychohistory.',
	'Books/Notes/Hyperion.md': '---\nauthor: Dan Simmons\nrating: 5\nprice: 10\ntags: [book]\n---\n#to-read',
	'Recipes/Soup.md': '---\nservings: 4\n---\nHot.',
	'Cover.png': 'png',
};

function query(app: App, config: BasesConfigFile, thisFile: TFile | null = null): QueryController {
	const controller = new QueryController(app, { thisFile });
	controller.setConfig(config);
	return controller;
}

const names = (controller: QueryController) => controller.result.data.map((e) => e.file.basename);

describe('Bases formulas', () => {
	it('computes arithmetic, text, lists, conditions and regular expressions', async () => {
		const { app } = await setup({});
		const ctx = { app, file: null, thisFile: null, formula: () => new StringValue('') };
		const value = (source: string) => displayText(evaluateFormula(source, ctx));
		expect(value('1 + 2 * 3')).toBe('7');
		expect(value('(1 + 2) * 3 % 4')).toBe('1');
		expect(value('"a" + 1 + true')).toBe('a1true');
		expect(value('10 / 4')).toBe('2.5');
		expect(value('(2.345).toFixed(2)')).toBe('2.35');
		expect(value('(2.345).round(1)')).toBe('2.3');
		expect(value('"Hello world".lower().contains("world")')).toBe('true');
		expect(value('"a,b,c".split(",").length')).toBe('3');
		expect(value('"hello there".title()')).toBe('Hello There');
		expect(value('"abc".replace(/b/, "-")')).toBe('a-c');
		expect(value('/^h/i.matches("Hey")')).toBe('true');
		expect(value('[3, 1, 2].sort().join("|")')).toBe('1|2|3');
		expect(value('[1, 2, 3, 4].filter(value > 2).map(value * 10)')).toBe('30, 40');
		expect(value('[1, 2, 3].reduce(acc + value, 0)')).toBe('6');
		expect(value('[1, 1, 2].unique().length')).toBe('2');
		expect(value('[1, [2, 3]].flat().contains(3)')).toBe('true');
		expect(value('if(1 > 2, "yes", "no")')).toBe('no');
		expect(value('!true || (1 == "1" && 2 != 3)')).toBe('true');
		expect(value('max(3, 9, 2) - min(4, 1)')).toBe('8');
		expect(value('null.isEmpty()')).toBe('true');
		expect(value('[].isEmpty() && "".isEmpty()')).toBe('true');
	});

	it('adds durations to dates and subtracts dates', async () => {
		const { app } = await setup({});
		const ctx = { app, file: null, thisFile: null, formula: () => new StringValue('') };
		const result = (source: string) => evaluateFormula(source, ctx);
		expect(displayText(result('date("2025-01-01") + "1 week"'))).toBe('2025-01-08');
		expect(displayText(result('date("2025-01-31") + "1M"'))).toBe('2025-02-28');
		expect(displayText(result('(date("2025-03-01 10:30") - "2h").format("HH:mm")'))).toBe('08:30');
		const diff = result('date("2025-01-10") - date("2025-01-01")');
		expect(diff).toBeInstanceOf(DurationValue);
		expect((diff as DurationValue).getMilliseconds()).toBe(9 * 86_400_000);
		expect(displayText(result('date("2025-01-10") - date("2025-01-01") > "1 week"'))).toBe('true');
		expect(displayText(result('date("2025-01-10").year + date("2025-01-10").month'))).toBe('2026');
		expect(displayText(result('date("2025-01-10") == "2025-01-10"'))).toBe('true');
		expect(result('now()')).toBeInstanceOf(DateValue);
		expect(DurationValue.parseFromString('P1DT2H')!.getMilliseconds()).toBe(26 * 3_600_000);
	});

	it('reports what it cannot evaluate', async () => {
		const { app } = await setup({});
		const ctx = { app, file: null, thisFile: null, formula: () => new StringValue('') };
		expect((evaluateFormula('nope(1)', ctx) as ErrorValue).message).toBe('Unknown function nope()');
		expect(evaluateFormula('1 +', ctx)).toBeInstanceOf(ErrorValue);
		expect((evaluateFormula('"x".nope()', ctx) as ErrorValue).message).toMatch(/Unknown method nope\(\)/);
		expect((evaluateFormula('(1', ctx) as ErrorValue).message).toBe('Expected ")" at the end');
	});

	it("reads notes' properties, file properties, links, tags, folders and this", async () => {
		const { app, file } = await setup(BOOKS);
		const dune = file('Books/Dune.md');
		const ctx = { app, file: dune, thisFile: file('Books/Foundation.md'), formula: () => new StringValue('') };
		const value = (source: string) => displayText(evaluateFormula(source, ctx));
		expect(value('author')).toBe('Frank Herbert');
		expect(value('note.rating + note["price"]')).toBe('17.5');
		expect(value('file.name + " " + file.ext + " " + file.folder')).toBe('Dune.md md Books');
		expect(value('file.hasTag("scifi") && file.hasTag("book") && !file.hasTag("sci")')).toBe('true');
		expect(value('file.inFolder("Books") && !file.inFolder("Recipes")')).toBe('true');
		expect(value('file.hasLink(this.file) && file.hasLink("Foundation")')).toBe('true');
		expect(value('file.hasProperty("author") && !file.hasProperty("servings")')).toBe('true');
		expect(value('this.author')).toBe('Isaac Asimov');
		expect(value('finished.year')).toBe('2025');
		expect(evaluateFormula('finished', ctx)).toBeInstanceOf(DateValue);
		expect(value('file.tags')).toBe('#book, #scifi/classic');
		expect(value('file.links.length')).toBe('1');
		expect(value('link("Foundation").asFile().name')).toBe('Foundation.md');
		expect(value('missing.isEmpty()')).toBe('true');
	});
});

describe('Bases queries', () => {
	it('filters on all views and on the view, with and, or and not', async () => {
		const { app } = await setup(BOOKS);
		const base = (filters: BasesConfigFile['filters'], viewFilters?: BasesConfigFile['filters']) => names(query(app, { filters, views: [{ type: 'table', name: 'T', filters: viewFilters }] }));
		expect(base('file.hasTag("book")')).toEqual(['Dune', 'Foundation', 'Hyperion']);
		expect(base({ and: ['file.hasTag("book")', 'rating > 4'] })).toEqual(['Dune', 'Hyperion']);
		expect(base({ or: ['servings == 4', 'author == "Isaac Asimov"'] })).toEqual(['Foundation', 'Soup']);
		expect(base({ and: ['file.ext == "md"', { not: ['file.inFolder("Books/Notes")', 'file.inFolder("Recipes")'] }] })).toEqual(['Dune', 'Foundation']);
		expect(base('file.hasTag("book")', 'read')).toEqual(['Dune']);
		// No filters: every file, attachments included.
		expect(base(undefined)).toHaveLength(5);
	});

	it('sorts on several keys with empty values last, limits, and groups', async () => {
		const { app } = await setup(BOOKS);
		const config: BasesConfigFile = {
			filters: 'file.hasTag("book")',
			views: [{ type: 'table', name: 'T', sort: [{ property: 'rating', direction: 'DESC' }, { property: 'file.name', direction: 'ASC' }] }],
		};
		expect(names(query(app, config))).toEqual(['Dune', 'Hyperion', 'Foundation']);
		config.views![0]!.sort = [{ property: 'note.read', direction: 'DESC' }];
		expect(names(query(app, config))).toEqual(['Dune', 'Foundation', 'Hyperion']);
		config.views![0]!.sort = [{ property: 'price', direction: 'ASC' }];
		config.views![0]!.limit = 2;
		expect(names(query(app, config))).toEqual(['Foundation', 'Hyperion']);
		delete config.views![0]!.limit;
		config.views![0]!.groupBy = { property: 'read', direction: 'DESC' };
		const groups = query(app, config).result.groupedData;
		expect(groups.map((g) => (g.hasKey() ? displayText(g.key!) : null))).toEqual(['true', 'false', null]);
		expect(groups.map((g) => g.entries.map((e) => e.file.basename))).toEqual([['Dune'], ['Foundation'], ['Hyperion']]);
		config.views![0]!.groupOrder = [false, null];
		expect(query(app, config).result.groupedData.map((g) => g.entries.length)).toEqual([1, 1]);
	});

	it('evaluates formulas, formulas of formulas, and summaries', async () => {
		const { app } = await setup(BOOKS);
		const controller = query(app, {
			filters: 'file.hasTag("book")',
			formulas: { double: 'price * 2', label: 'author + " (" + formula.double + ")"', loop: 'formula.loop + 1' },
			summaries: { spread: 'values.map(number(value)).reduce(max(acc, value), 0) - 1' },
			views: [{ type: 'table', name: 'T', order: ['file.name', 'formula.label'] }],
		});
		const dune = controller.result.data.find((e) => e.file.basename === 'Dune')!;
		expect(displayText(dune.getValue('formula.label')!)).toBe('Frank Herbert (25)');
		expect(dune.getValue('formula.loop')).toBeInstanceOf(ErrorValue);
		const sum = (key: string) => displayText(controller.summarize(controller.result.data, 'note.price', key));
		expect(sum('Sum')).toBe('30.5');
		expect(sum('Average')).toBe('10.1666666667');
		expect(sum('Median')).toBe('10');
		expect(sum('Range')).toBe('4.5');
		expect(sum('spread')).toBe('11.5');
		expect(displayText(controller.summarize(controller.result.data, 'note.read', 'Checked'))).toBe('1');
		expect(displayText(controller.summarize(controller.result.data, 'note.read', 'Empty'))).toBe('1');
		expect(displayText(controller.summarize(controller.result.data, 'note.finished', 'Earliest'))).toBe('2024-06-01');
	});

	it('reads and writes .base settings in Obsidian\'s format', () => {
		const config = parseBaseConfig('filters:\n  and:\n    - file.hasTag("book")\nviews:\n  - type: cards\n  - name: Second\n');
		expect(config.views!.map((v) => [v.type, v.name])).toEqual([
			['cards', 'Cards'],
			['table', 'Second'],
		]);
		expect(() => parseBaseConfig('- a\n- b')).toThrow(/YAML/);
		expect(parseBaseConfig('')).toEqual({});
		expect(serializeBaseConfig({ filters: 'a', formulas: {}, views: [{ type: 'table', name: 'T' }] })).toBe('filters: a\nviews:\n  - type: table\n    name: T\n');
		expect(normalizePropertyId('status')).toBe('note.status');
		expect(normalizePropertyId('file.name')).toBe('file.name');
	});

	it('names properties as the base renames them, and the file ones plainly', async () => {
		const { app } = await setup(BOOKS);
		const controller = query(app, { properties: { 'note.author': { displayName: 'Writer' }, price: { displayName: 'Cost' } } });
		const config = controller.viewConfig;
		expect(config.getDisplayName('note.author')).toBe('Writer');
		expect(config.getDisplayName('note.price')).toBe('Cost');
		expect(config.getDisplayName('file.name')).toBe('file name');
		expect(config.getDisplayName('formula.x')).toBe('x');
	});

	it('creates a note that passes the filters, in the folder they ask for', async () => {
		const { app, backend } = await setup(BOOKS);
		const controller = query(app, { filters: { and: ['file.inFolder("Books")', 'file.hasTag("book")', 'status == "unread"', 'rating == 3'] } });
		const file = await controller.createFile('New book');
		expect(file!.path).toBe('Books/New book.md');
		const text = backend.files.get('Books/New book.md')!;
		expect(parseYaml(getFrontMatterInfo(text).frontmatter)).toEqual({ status: 'unread', rating: 3, tags: ['book'] });
	});
});

describe('Bases views', () => {
	function mount(app: App, bases: Bases, config: BasesConfigFile, save?: (config: BasesConfigFile) => void) {
		const controller = new QueryController(app, { save });
		const el = document.body.createDiv();
		const container = new BasesContainer(app, controller, el, { registrations: () => bases.registrations });
		controller.load();
		container.load();
		controller.setConfig(config);
		return { controller, container, el };
	}

	it('draws a table with the toolbar, groups and summaries', async () => {
		const { app, bases } = await setup(BOOKS);
		const { el } = mount(app, bases, {
			filters: 'file.hasTag("book")',
			views: [{ type: 'table', name: 'Books', order: ['file.name', 'author', 'rating', 'read'], sort: [{ property: 'file.name', direction: 'ASC' }], summaries: { 'note.rating': 'Average' } }],
		});
		expect(el.querySelector('.bases-toolbar-views-menu')!.textContent).toBe('Books');
		expect(el.querySelector('.bases-toolbar-results-menu')!.textContent).toBe('3 results');
		expect([...el.querySelectorAll('.bases-th-label')].map((th) => th.textContent)).toEqual(['file name', 'author', 'rating', 'read']);
		const rows = [...el.querySelectorAll('tbody .bases-tr')];
		expect(rows.map((r) => r.getAttribute('data-path'))).toEqual(['Books/Dune.md', 'Books/Foundation.md', 'Books/Notes/Hyperion.md']);
		const first = rows[0]!.querySelectorAll('.bases-td');
		expect(first[0]!.querySelector('a.internal-link')!.textContent).toBe('Dune');
		expect(first[1]!.textContent).toBe('Frank Herbert');
		expect(first[3]!.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true);
		expect(el.querySelector('.bases-summary[data-property="note.rating"]')!.textContent).toBe('Average4.67');
	});

	it('switches to cards and lists, with covers and groups', async () => {
		const { app, bases } = await setup({ ...BOOKS, 'Books/Dune.md': BOOKS['Books/Dune.md'].replace('rating: 5', 'rating: 5\ncover: "[[Cover.png]]"') });
		const { controller, el } = mount(app, bases, {
			filters: 'file.hasTag("book")',
			views: [
				{ type: 'cards', name: 'Cards', image: 'note.cover', order: ['file.name', 'author'], groupBy: { property: 'rating', direction: 'DESC' } },
				{ type: 'list', name: 'List', order: ['file.name', 'author'] },
			],
		});
		expect(el.querySelector('.bases-view')!.getAttribute('data-view-type')).toBe('cards');
		expect([...el.querySelectorAll('.bases-cards-group .bases-group-key')].map((k) => k.textContent)).toEqual(['5', '4']);
		const dune = el.querySelector('.bases-cards-item[data-path="Books/Dune.md"]')!;
		expect(dune.querySelector('.bases-cards-cover img')!.getAttribute('src')).toContain('Cover.png');
		expect(dune.querySelector('.mod-title a')!.textContent).toBe('Dune');
		expect(el.querySelector('.bases-cards-item[data-path="Books/Foundation.md"] .bases-cards-cover')!.classList.contains('mod-empty')).toBe(true);
		controller.selectView('List');
		expect(el.querySelector('.bases-view')!.getAttribute('data-view-type')).toBe('list');
		expect([...el.querySelectorAll('.bases-list-item')].map((li) => li.textContent)).toEqual(['DuneFrank Herbert', 'FoundationIsaac Asimov', 'HyperionDan Simmons']);
	});

	it('saves settings changed from the views, and edits note properties in cells', async () => {
		const { app, bases, backend } = await setup(BOOKS);
		const saved: string[] = [];
		const { controller, el } = mount(app, bases, { filters: 'file.hasTag("book")', views: [{ type: 'table', name: 'T', order: ['file.name', 'author', 'read'] }] }, (c) => saved.push(serializeBaseConfig(c)));
		controller.viewConfig.set('sort', [{ property: 'note.author', direction: 'DESC' }]);
		expect(saved.at(-1)).toContain('property: note.author');
		expect([...el.querySelectorAll('tbody .bases-tr')].map((r) => r.getAttribute('data-path'))[0]).toBe('Books/Foundation.md');

		const cell = el.querySelector<HTMLElement>('.bases-tr[data-path="Books/Dune.md"] .bases-td[data-property="note.author"]')!;
		cell.click();
		const input = cell.querySelector<HTMLInputElement>('input.bases-cell-input')!;
		expect(input.value).toBe('Frank Herbert');
		input.value = 'F. Herbert';
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		await new Promise((r) => setTimeout(r, 0));
		expect(backend.files.get('Books/Dune.md')).toContain('author: F. Herbert');

		const box = el.querySelector<HTMLInputElement>('.bases-tr[data-path="Books/Foundation.md"] .bases-td[data-property="note.read"] input')!;
		expect(box.disabled).toBe(false);
		box.checked = true;
		box.dispatchEvent(new Event('change'));
		await new Promise((r) => setTimeout(r, 0));
		expect(backend.files.get('Books/Foundation.md')).toContain('read: true');
	});

	it('stores typed values by the property type', async () => {
		const { app } = await setup({}, { '.obsidian/types.json': JSON.stringify({ types: { score: 'number', topics: 'multitext' } }) });
		expect(parsePropertyInput(app, 'score', ' 7 ', undefined)).toBe(7);
		expect(parsePropertyInput(app, 'topics', 'a, b,,c', undefined)).toEqual(['a', 'b', 'c']);
		expect(parsePropertyInput(app, 'other', 'x', ['old'])).toEqual(['x']);
		expect(parsePropertyInput(app, 'other', '', 'old')).toBeNull();
		expect(typeof editProperty).toBe('function');
	});
});

describe('Bases in notes and plugins', () => {
	it('opens .base files in the bases view, and is on by default in vaults that predate it', async () => {
		const { app } = await setup({}, { '.obsidian/core-plugins.json': JSON.stringify({ 'daily-notes': true }) });
		expect(app.viewRegistry.getTypeByExtension('base')).toBe('bases');
		expect(app.internalPlugins.getEnabledPluginById('bases')).not.toBeNull();
		expect(app.commands.findCommand('bases:new-file')).toBeDefined();
	});

	it('draws embedded bases and base code blocks, with this as the note', async () => {
		const { app } = await setup({
			...BOOKS,
			'Library.base': 'filters: file.hasTag("book")\nviews:\n  - type: table\n    name: All\n  - type: list\n    name: Same author\n    filters: author == this.author\n',
			'Home.md': '---\nauthor: Isaac Asimov\n---\n![[Library.base#Same author]]\n\n```base\nfilters: file.inFolder("Recipes")\nviews:\n  - type: table\n    name: Food\n```\n',
		});
		const el = document.body.createDiv();
		const component = new Component();
		component.load();
		await MarkdownRenderer.render(app, await app.vault.read(app.vault.getFileByPath('Home.md')!), el, 'Home.md', component);
		await new Promise((r) => setTimeout(r, 0));
		const embed = el.querySelector('.bases-embed')!;
		expect(embed.querySelector('.bases-toolbar-views-menu')!.textContent).toBe('Same author');
		expect([...embed.querySelectorAll('.bases-list-item')].map((li) => li.getAttribute('data-path'))).toEqual(['Books/Foundation.md']);
		const block = el.querySelector('.block-language-base.bases-codeblock')!;
		expect([...block.querySelectorAll('tbody .bases-tr')].map((r) => r.getAttribute('data-path'))).toEqual(['Recipes/Soup.md']);
		component.unload();
		expect(el.querySelector('.bases-container')).toBeNull();
	});

	it('rewrites a base code block in its note', () => {
		const note = 'Intro\n\n```base\nviews:\n  - type: table\n    name: A\n```\n\n- item\n  ```base\n  views: []\n  ```\n';
		expect(replaceCodeBlock(note, 'views:\n  - type: table\n    name: A', 'views:\n  - type: list\n    name: B')).toBe(note.replace('type: table\n    name: A', 'type: list\n    name: B'));
		expect(replaceCodeBlock(note, 'views: []', 'filters: x\nviews: []')).toBe(note.replace('  views: []', '  filters: x\n  views: []'));
		expect(replaceCodeBlock(note, 'nothing', 'x')).toBeNull();
	});

	it("lets plugins add view types with registerBasesView", async () => {
		const { app, bases } = await setup(BOOKS);
		class CountView extends BasesView {
			type = 'count';
			constructor(
				controller: QueryController,
				private readonly el: HTMLElement,
			) {
				super(controller);
			}
			onDataUpdated(): void {
				this.el.setText(`${this.data.data.length} files, ${this.allProperties.length > 0}, ${this.config.get('label')}`);
			}
		}
		class TestPlugin extends Plugin {
			override async onload(): Promise<void> {}
		}
		const plugin = new TestPlugin(app, { id: 'p', name: 'P', version: '1', minAppVersion: '1', author: '', description: '' });
		plugin.load();
		expect(plugin.registerBasesView('count', { name: 'Count', icon: 'hash', factory: (c, el) => new CountView(c, el) })).toBe(true);
		expect(plugin.registerBasesView('table', { name: 'Mine', icon: 'x', factory: (c, el) => new CountView(c, el) })).toBe(false);
		const controller = new QueryController(app);
		const el = document.body.createDiv();
		new BasesContainer(app, controller, el, { registrations: () => bases.registrations }).load();
		controller.setConfig({ filters: 'file.hasTag("book")', views: [{ type: 'count', name: 'C', label: 'hi' }] });
		expect(el.querySelector('.bases-view')!.textContent).toBe('3 files, true, hi');
		plugin.unload();
		expect(bases.registrations.has('count')).toBe(false);
		await app.internalPlugins.setEnabled('bases', false);
		expect(plugin.registerBasesView('count', { name: 'Count', icon: 'hash', factory: (c, e) => new CountView(c, e) })).toBe(false);
		expect(app.viewRegistry.getTypeByExtension('base')).toBeUndefined();
	});

	it('wraps plain values as the typings describe', () => {
		const list = new ListValue([1, 'two', null]);
		expect(list.get(0)).toBeInstanceOf(NumberValue);
		expect(list.get(-1).isTruthy()).toBe(false);
		expect(list.includes(new StringValue('1'))).toBe(true);
		expect(new StringValue('x').isType('string')).toBe(true);
		expect(DateValue.parseFromString('2025-02-31')).toBeNull();
		expect(DateValue.parseFromString('2025-12-31T23:59')!.time).toBe(true);
	});
});
