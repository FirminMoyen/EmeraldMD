// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';
import {
	apiVersion,
	CodeMirrorEditor,
	debounce,
	FuzzySuggestModal,
	getFrontMatterInfo,
	MarkdownRenderer,
	MarkdownPreviewRenderer,
	Component,
	PluginSettingTab,
	prepareFuzzySearch,
	prepareSimpleSearch,
	renderMatches,
	requestUrl,
	setRequestBackend,
	type Plugin,
} from '../src';
import { createTestApp } from '../src/testing';

describe('API version', () => {
	it('matches API_VERSION and the pinned typings', () => {
		const file = readFileSync('packages/api/API_VERSION', 'utf8').trim();
		const pkg = JSON.parse(readFileSync('packages/api/package.json', 'utf8')) as { devDependencies: Record<string, string> };
		expect(apiVersion).toBe(file);
		expect(pkg.devDependencies.obsidian).toBe(file);
	});
});

describe('CodeMirrorEditor', () => {
	function editor(doc: string) {
		const view = new EditorView({ doc, parent: document.body });
		return { view, editor: new CodeMirrorEditor(view) };
	}

	it('reads lines and converts positions', () => {
		const { editor: e, view } = editor('one\ntwo\nthree');
		expect(e.lineCount()).toBe(3);
		expect(e.lastLine()).toBe(2);
		expect(e.getLine(1)).toBe('two');
		expect(e.posToOffset({ line: 1, ch: 2 })).toBe(6);
		expect(e.offsetToPos(6)).toEqual({ line: 1, ch: 2 });
		expect(e.getRange({ line: 0, ch: 1 }, { line: 1, ch: 1 })).toBe('ne\nt');
		view.destroy();
	});

	it('edits through selections, ranges and transactions', () => {
		const { editor: e, view } = editor('hello world');
		e.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 5 });
		expect(e.getSelection()).toBe('hello');
		e.replaceSelection('goodbye');
		expect(e.getValue()).toBe('goodbye world');
		e.replaceRange('!', { line: 0, ch: 13 });
		expect(e.getValue()).toBe('goodbye world!');
		e.setLine(0, 'x');
		expect(e.getValue()).toBe('x');
		e.transaction({ changes: [{ from: { line: 0, ch: 1 }, text: '\nyz' }], selection: { from: { line: 1, ch: 2 } } });
		expect(e.getValue()).toBe('x\nyz');
		expect(e.getCursor()).toEqual({ line: 1, ch: 2 });
		view.destroy();
	});
});

describe('search', () => {
	it('fuzzy-matches in order and prefers word starts', () => {
		const search = prepareFuzzySearch('opn set');
		expect(search('Open settings')?.matches).toEqual([
			[0, 2],
			[3, 4],
			[5, 8],
		]);
		expect(search('Close')).toBeNull();
		const score = (text: string) => prepareFuzzySearch('ns')(text)!.score;
		expect(score('New sheet')).toBeGreaterThan(score('Insert'));
	});

	it('simple search needs every word', () => {
		const search = prepareSimpleSearch('foo bar');
		expect(search('bar and foo')?.matches).toEqual([
			[0, 3],
			[8, 11],
		]);
		expect(search('foo only')).toBeNull();
	});

	it('renders highlighted matches', () => {
		const el = createDiv();
		renderMatches(el, 'Open', [[0, 2]]);
		expect(el.innerHTML).toBe('<span class="suggestion-highlight">Op</span>en');
	});
});

describe('Markdown', () => {
	it('renders blocks, inline formatting, wikilinks and tags', async () => {
		const { app } = await createTestApp({ 'Note.md': '' });
		const el = createDiv();
		const md = '---\ntitle: x\n---\n# Title\n\nSome **bold** and *em* and `code` [[Note|alias]] [[Missing]] #tag\n\n- [x] done\n- item\n\n```js\nlet a = 1;\n```\n';
		await MarkdownRenderer.render(app, md, el, '', new Component());
		expect(el.querySelector('h1')?.textContent).toBe('Title');
		expect(el.querySelector('strong')?.textContent).toBe('bold');
		expect(el.querySelector('em')?.textContent).toBe('em');
		expect(el.querySelector('p code')?.textContent).toBe('code');
		const links = el.querySelectorAll('a.internal-link');
		expect([...links].map((a) => [a.textContent, a.classList.contains('is-unresolved')])).toEqual([
			['alias', false],
			['Missing', true],
		]);
		expect(el.querySelector('a.tag')?.textContent).toBe('#tag');
		expect(el.querySelector('li.task-list-item.is-checked')?.textContent).toBe('done');
		expect(el.querySelector('pre code.language-js')?.textContent).toBe('let a = 1;\n');
		expect(el.textContent).not.toContain('title: x');
		app.destroy();
	});

	it('runs code block processors', async () => {
		const { app } = await createTestApp();
		const handler = vi.fn((source: string, el: HTMLElement) => el.setText(`rendered ${source}`));
		const processor = MarkdownPreviewRenderer.createCodeBlockPostProcessor('demo', handler);
		MarkdownPreviewRenderer.registerPostProcessor(processor);
		const el = createDiv();
		await MarkdownRenderer.render(app, '```demo\nhello\n```', el, '', new Component());
		MarkdownPreviewRenderer.unregisterPostProcessor(processor);
		expect(handler).toHaveBeenCalledOnce();
		expect(el.querySelector('.block-language-demo')?.textContent).toBe('rendered hello');
		app.destroy();
	});

	it('finds frontmatter', () => {
		expect(getFrontMatterInfo('---\na: 1\n---\nbody')).toEqual({ exists: true, frontmatter: 'a: 1', from: 4, to: 8, contentStart: 13 });
		expect(getFrontMatterInfo('no frontmatter').exists).toBe(false);
	});
});

describe('requestUrl', () => {
	it('uses the backend and exposes text, json and arrayBuffer', async () => {
		setRequestBackend(async (req) => ({
			status: req.url.endsWith('missing') ? 404 : 200,
			headers: { 'content-type': 'application/json' },
			body: new TextEncoder().encode('{"ok":true}').buffer as ArrayBuffer,
		}));
		const res = await requestUrl('https://example.test/data');
		expect(res.status).toBe(200);
		expect(res.json).toEqual({ ok: true });
		expect(await requestUrl({ url: 'https://example.test/data' }).text).toBe('{"ok":true}');
		await expect(requestUrl('https://example.test/missing')).rejects.toMatchObject({ status: 404 });
		expect((await requestUrl({ url: 'https://example.test/missing', throw: false })).status).toBe(404);
	});
});

describe('debounce', () => {
	it('runs once with the last arguments', () => {
		vi.useFakeTimers();
		const fn = vi.fn();
		const d = debounce(fn, 100, true);
		d(1);
		d(2);
		vi.advanceTimersByTime(100);
		expect(fn).toHaveBeenCalledExactlyOnceWith(2);
		d(3);
		d.cancel();
		vi.advanceTimersByTime(100);
		expect(fn).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});
});

describe('suggest modal', () => {
	it('filters, navigates and chooses with the keyboard', async () => {
		const { app } = await createTestApp();
		const chosen: string[] = [];
		class Picker extends FuzzySuggestModal<string> {
			getItems() {
				return ['Apple', 'Banana', 'Cherry'];
			}
			getItemText(item: string) {
				return item;
			}
			onChooseItem(item: string) {
				chosen.push(item);
			}
		}
		const modal = new Picker(app);
		modal.open();
		await vi.waitFor(() => expect(modal.resultContainerEl.children.length).toBe(3));
		modal.inputEl.value = 'an';
		modal.inputEl.dispatchEvent(new Event('input'));
		await vi.waitFor(() => expect(modal.resultContainerEl.textContent).toBe('Banana'));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter' }));
		expect(chosen).toEqual(['Banana']);
		expect(modal.containerEl.isConnected).toBe(false);
		app.destroy();
	});
});

describe('declarative setting tabs', () => {
	it('renders definitions and writes through setControlValue', async () => {
		const { app, config } = await createTestApp();
		const plugin = {
			app,
			manifest: { id: 'decl', name: 'Decl', dir: '.obsidian/plugins/decl' },
			settings: { enabled: false, mode: 'b' },
			saveData: async (data: unknown) => void (await app.vault.adapter.write('.obsidian/plugins/decl/data.json', JSON.stringify(data))),
		} as unknown as Plugin;
		class Tab extends PluginSettingTab {
			override getSettingDefinitions() {
				return [
					{ name: 'Enabled', control: { type: 'toggle' as const, key: 'enabled' } },
					{ type: 'group' as const, heading: 'More', items: [{ name: 'Mode', control: { type: 'dropdown' as const, key: 'mode', options: { a: 'A', b: 'B' } } }] },
				];
			}
		}
		const tab = new Tab(app, plugin);
		app.setting.addSettingTab(tab);
		app.setting.openTabById('decl');
		const names = [...tab.containerEl.querySelectorAll('.setting-item-name')].map((n) => n.textContent);
		expect(names).toEqual(['Enabled', 'More', 'Mode']);
		expect(tab.containerEl.querySelector<HTMLSelectElement>('select')!.value).toBe('b');
		tab.containerEl.querySelector<HTMLElement>('.checkbox-container')!.click();
		await vi.waitFor(() => expect(config.files.get('.obsidian/plugins/decl/data.json')).toBe('{"enabled":true,"mode":"b"}'));
		app.setting.close();
		app.destroy();
	});
});
