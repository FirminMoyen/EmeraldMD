// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { applyTemplateVariables, Bookmarks, DailyNotes, moment, Templates } from '../src';
import { createTestApp } from '../src/testing';

const json = (value: unknown) => JSON.stringify(value);

describe('applyTemplateVariables', () => {
	const ctx = { title: 'Plan', date: moment('2026-10-17 09:30', 'YYYY-MM-DD HH:mm'), dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' };

	it('fills title, date and time, with formats and offsets', () => {
		expect(applyTemplateVariables('# {{title}}\n{{date}} {{ date:dddd }} {{date+1d:YYYY-MM-DD}} {{date-1M:MMMM}}', ctx)).toBe(
			'# Plan\n2026-10-17 Saturday 2026-10-18 September',
		);
		expect(applyTemplateVariables('{{time}}', ctx)).toMatch(/^\d\d:\d\d$/);
		expect(applyTemplateVariables('{{unknown}} {{date', ctx)).toBe('{{unknown}} {{date');
	});
});

describe('core plugins', () => {
	it('reads core-plugins.json and each plugin options, and registers what is on', async () => {
		const { app } = await createTestApp(
			{},
			{
				'.obsidian/core-plugins.json': json({ 'daily-notes': true, templates: false, graph: true }),
				'.obsidian/daily-notes.json': json({ folder: 'Journal', format: 'YYYY/MM/YYYY-MM-DD' }),
			},
		);
		await app.internalPlugins.load(app);
		const daily = app.internalPlugins.getPluginById('daily-notes')!;
		expect(daily.enabled).toBe(true);
		expect(daily.instance.options).toEqual({ folder: 'Journal', format: 'YYYY/MM/YYYY-MM-DD' });
		expect(app.internalPlugins.getEnabledPluginById('templates')).toBeNull();
		expect(app.commands.findCommand('daily-notes')).toBeDefined();
		expect(app.commands.findCommand('insert-template')).toBeUndefined();
		expect(app.workspace.leftRibbon.items.map((i) => i.title)).toContain("Open today's daily note");
	});

	it('accepts the older list format, and turns the defaults on without a file', async () => {
		const listed = await createTestApp({}, { '.obsidian/core-plugins.json': json(['templates']) });
		await listed.app.internalPlugins.load(listed.app);
		expect(listed.app.internalPlugins.getEnabledPlugins().map((p) => p.id)).toEqual(['templates']);

		const fresh = await createTestApp();
		await fresh.app.internalPlugins.load(fresh.app);
		expect(fresh.app.internalPlugins.getEnabledPlugins().map((p) => p.id)).toEqual(['daily-notes', 'templates', 'page-preview', 'bookmarks', 'file-recovery', 'note-composer']);
	});

	it('creates the daily note in its folder from the template', async () => {
		const { app, backend } = await createTestApp(
			{ 'Templates/Daily.md': '# {{title}}\n\n{{date:dddd}}, created {{time:HH}}h\n' },
			{ '.obsidian/daily-notes.json': json({ folder: 'Journal', format: 'YYYY/MM/YYYY-MM-DD', template: 'Templates/Daily' }) },
		);
		await app.internalPlugins.load(app);
		const daily = app.internalPlugins.getEnabledPluginById('daily-notes') as DailyNotes;
		const date = moment('2026-10-17', 'YYYY-MM-DD');
		expect(daily.pathFor(date)).toBe('Journal/2026/10/2026-10-17.md');
		await daily.openDay(date);
		expect(await backend.read('Journal/2026/10/2026-10-17.md')).toMatch(/^# 2026-10-17\n\nSaturday, created \d\dh\n$/);
		const file = app.vault.getFileByPath('Journal/2026/10/2026-10-17.md')!;
		expect(daily.dateOf(file)?.format('YYYY-MM-DD')).toBe('2026-10-17');
		expect(daily.dateOf(app.vault.getFileByPath('Templates/Daily.md')!)).toBeNull();
	});

	it('saves turning a plugin off and removes its commands', async () => {
		const { app, config } = await createTestApp();
		await app.internalPlugins.load(app);
		await app.internalPlugins.setEnabled('templates', false);
		expect(app.commands.findCommand('insert-template')).toBeUndefined();
		expect(JSON.parse(config.files.get('.obsidian/core-plugins.json')!)).toEqual({ 'daily-notes': true, templates: false, 'page-preview': true, bookmarks: true, 'file-recovery': true, 'note-composer': true, 'slash-command': false, 'random-note': false, 'zk-prefixer': false, workspaces: false });
		expect(app.workspace.leftRibbon.items.map((i) => i.title)).not.toContain('Insert template');
	});

	it('lists the notes in the templates folder', async () => {
		const { app } = await createTestApp(
			{ 'Templates/Meeting.md': 'x', 'Templates/Sub/Weekly.md': 'y', 'Templates/image.png': 'z', 'Other.md': '' },
			{ '.obsidian/templates.json': json({ folder: 'Templates' }) },
		);
		await app.internalPlugins.load(app);
		const templates = app.internalPlugins.getEnabledPluginById('templates') as Templates;
		expect(templates.templateFiles().map((f) => f.path)).toEqual(['Templates/Meeting.md', 'Templates/Sub/Weekly.md']);
	});
});

describe('Bookmarks', () => {
	it('bookmarks files, keeps groups, follows renames and saves bookmarks.json', async () => {
		const { app, config } = await createTestApp(
			{ 'Plan.md': '# Plan', 'Projects/Spec.md': '', 'Projects/Notes.md': '' },
			{ '.obsidian/bookmarks.json': json({ items: [{ type: 'group', title: 'Work', items: [{ type: 'file', path: 'Projects/Spec.md' }] }, { type: 'search', query: 'tag:#todo' }] }) },
		);
		await app.internalPlugins.load(app);
		const bookmarks = app.internalPlugins.getEnabledPluginById('bookmarks') as Bookmarks;
		expect(bookmarks.find('Projects/Spec.md')).not.toBeNull();

		bookmarks.toggle(app.vault.getFileByPath('Plan.md')!);
		expect(bookmarks.items.map((i) => i.path ?? i.title ?? i.query)).toEqual(['Work', 'tag:#todo', 'Plan.md']);
		await app.vault.rename(app.vault.getFolderByPath('Projects')!, 'Archive');
		expect(bookmarks.find('Archive/Spec.md')).not.toBeNull();
		bookmarks.toggle(app.vault.getFileByPath('Plan.md')!);
		expect(bookmarks.find('Plan.md')).toBeNull();
		await vi.waitFor(() => expect(JSON.parse(config.files.get('.obsidian/bookmarks.json')!).items[0].items[0].path).toBe('Archive/Spec.md'));
		expect(app.commands.findCommand('bookmarks:bookmark-current-view')).toBeDefined();
	});
});
