// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { CachedMetadata, LinkSets, ReferenceCache, TFile } from '@emeraldmd/core';
import '../src';
import { CodeMirrorEditor, mergeProperties, NoteComposer } from '../src';
import { createTestApp } from '../src/testing';

afterEach(() => document.body.replaceChildren());

/** Metadata for the wikilinks in `text`, as the Rust index reports it. */
function linksIn(text: string): CachedMetadata {
	const links: ReferenceCache[] = [];
	const pos = (offset: number) => ({ line: 0, col: offset, offset });
	for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
		links.push({ link: m[1]!.split('|')[0]!, original: m[0], position: { start: pos(m.index), end: pos(m.index + m[0].length) } });
	}
	return { links };
}

async function setup(files: Record<string, string>) {
	const test = await createTestApp(files, {});
	await test.app.internalPlugins.load(test.app);
	const metadata: Record<string, CachedMetadata> = {};
	const links: Record<string, LinkSets> = {};
	for (const [path, text] of Object.entries(files)) {
		metadata[path] = linksIn(text);
		const resolved: Record<string, number> = {};
		for (const ref of metadata[path]!.links ?? []) {
			const target = `${ref.link.split('#')[0]}.md`;
			if (files[target] !== undefined) resolved[target] = (resolved[target] ?? 0) + 1;
		}
		links[path] = { resolved, unresolved: {} };
	}
	test.app.vault.applyUpdate({ renamed: [], removed: [], upserted: [], metadata, links });
	const composer = test.app.internalPlugins.getEnabledPluginById('note-composer') as NoteComposer;
	composer.options.askBeforeMerging = false;
	const file = (path: string) => test.app.vault.getFileByPath(path) as TFile;
	return { ...test, composer, file };
}

describe('Note composer', () => {
	it('merges a note into another: text appended, properties merged, links redirected, note to the trash', async () => {
		const { app, composer, file } = await setup({
			'A.md': '---\ntags: [a]\nstatus: draft\n---\nText of A.',
			'B.md': '---\ntags: [b]\n---\nText of B.\n',
			'C.md': 'See [[A]] and [[A#Part|the part]], and [[B]].',
		});
		await composer.merge(file('A.md'), file('B.md'));
		const b = await app.vault.read(file('B.md'));
		expect(b).toContain('Text of B.\n\nText of A.');
		expect(b).toMatch(/tags:\n\s+- b\n\s+- a/);
		expect(b).toContain('status: draft');
		expect(await app.vault.read(file('C.md'))).toBe('See [[B]] and [[B#Part|the part]], and [[B]].');
		expect(app.vault.getFileByPath('A.md')).toBeNull();
	});

	it('extracts the selection to a new note, leaving a link (or an embed)', async () => {
		const { app, composer, file } = await setup({ 'Source.md': 'Intro.\nAn idea to keep.\nOutro.' });
		const view = new EditorView({ state: EditorState.create({ doc: 'Intro.\nAn idea to keep.\nOutro.', selection: { anchor: 7, head: 23 } }), parent: document.body });
		const editor = new CodeMirrorEditor(view);
		await composer.extract(file('Source.md'), editor, editor.getSelection(), 'An idea');
		expect(await app.vault.read(file('An idea.md'))).toBe('An idea to keep.');
		expect(editor.getValue()).toBe('Intro.\n[[An idea]]\nOutro.');

		composer.options.replacementText = 'embed';
		editor.setSelection({ line: 2, ch: 0 }, { line: 2, ch: 6 });
		await composer.extract(file('Source.md'), editor, editor.getSelection(), file('An idea.md'));
		expect(await app.vault.read(file('An idea.md'))).toBe('An idea to keep.\n\nOutro.');
		expect(editor.getValue()).toBe('Intro.\n[[An idea]]\n![[An idea]]');
	});

	it('extracts a heading’s section to a note named after it', async () => {
		const text = '# Plan\nintro\n## Goals\n- ship\n- test\n## Later\nmaybe';
		const { app, composer, file } = await setup({ 'Plan.md': text });
		const view = new EditorView({ state: EditorState.create({ doc: text, selection: { anchor: text.indexOf('## Goals') + 3 } }), parent: document.body });
		const editor = new CodeMirrorEditor(view);
		await composer.extractHeading(file('Plan.md'), editor);
		expect(await app.vault.read(file('Goals.md'))).toBe('- ship\n- test');
		expect(editor.getValue()).toBe('# Plan\nintro\n[[Goals]]\n## Later\nmaybe');
	});

	it('merges properties: missing keys added, lists joined without duplicates', () => {
		const into: Record<string, unknown> = { tags: ['x', 'y'], title: 'kept', empty: null };
		mergeProperties(into, { tags: ['y', 'z'], title: 'other', empty: 'filled', added: 1 });
		expect(into).toEqual({ tags: ['x', 'y', 'z'], title: 'kept', empty: 'filled', added: 1 });
	});
});
