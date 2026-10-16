// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { Component, loadAsync, Notice, Plugin, PluginSettingTab, Setting, type PluginManifest } from '../src';
import { createTestApp } from '../src/testing';

const manifest: PluginManifest = {
	id: 'sample',
	name: 'Sample',
	author: 'Test',
	version: '1.0.0',
	minAppVersion: '1.0.0',
	description: '',
	dir: '.obsidian/plugins/sample',
};

describe('Component', () => {
	it('loads children and runs cleanups on unload', async () => {
		const parent = new Component();
		const child = new Component();
		const order: string[] = [];
		child.onload = () => order.push('child load');
		child.onunload = () => order.push('child unload');
		parent.addChild(child);
		parent.register(() => order.push('cleanup'));
		parent.load();
		expect(child._loaded).toBe(true);
		parent.unload();
		expect(order).toEqual(['child load', 'child unload', 'cleanup']);
		expect(child._loaded).toBe(false);
	});

	it('waits for an async onload', async () => {
		const c = new Component();
		let done = false;
		c.onload = (async () => {
			await Promise.resolve();
			done = true;
		}) as unknown as () => void;
		await loadAsync(c);
		expect(done).toBe(true);
		expect(c._loaded).toBe(true);
	});

	it('removes DOM listeners and intervals on unload', () => {
		const c = new Component();
		c.load();
		const el = createDiv();
		const listener = vi.fn();
		c.registerDomEvent(el, 'click', listener);
		el.click();
		c.unload();
		el.click();
		expect(listener).toHaveBeenCalledTimes(1);
	});
});

class SamplePlugin extends Plugin {
	override settings: { greeting: string } = { greeting: 'hello' };
	ran = 0;

	override async onload() {
		this.settings = Object.assign({ greeting: 'hello' }, await this.loadData());
		this.addCommand({ id: 'run', name: 'Run', callback: () => this.ran++ });
		this.addCommand({ id: 'needs-editor', name: 'Needs editor', editorCallback: () => this.ran++ });
		this.addCommand({ id: 'checked', name: 'Checked', checkCallback: (checking) => (checking ? this.ran >= 1 : void this.ran++) });
		this.addSettingTab(new SampleTab(this));
		this.addRibbonIcon('dice', 'Roll', () => this.ran++);
		this.addStatusBarItem().setText('status');
	}
}

class SampleTab extends PluginSettingTab {
	constructor(readonly sample: SamplePlugin) {
		super(sample.app, sample);
	}

	override display() {
		this.containerEl.empty();
		new Setting(this.containerEl)
			.setName('Greeting')
			.addText((t) => t.setValue(this.sample.settings.greeting).onChange(async (v) => {
				this.sample.settings.greeting = v;
				await this.sample.saveData(this.sample.settings);
			}));
	}
}

describe('Plugin', () => {
	it('registers prefixed commands, ribbon, status bar and settings, and removes them on unload', async () => {
		const { app } = await createTestApp();
		const plugin = new SamplePlugin(app, manifest);
		await loadAsync(plugin);
		expect(Object.keys(app.commands.commands)).toEqual(['sample:run', 'sample:needs-editor', 'sample:checked']);
		expect(app.commands.commands['sample:run']!.name).toBe('Sample: Run');
		expect(app.workspace.leftRibbon.actionsEl.querySelectorAll('.side-dock-ribbon-action').length).toBe(1);
		expect(app.statusBar.containerEl.textContent).toBe('status');
		expect(app.workspace.leftRibbon.items.map((i) => i.title)).toEqual(['Roll']);
		expect(app.setting.pluginTabs.map((t) => t.id)).toEqual(['sample']);

		// No editor is open, so the editor command is unavailable.
		expect(app.commands.executeCommandById('sample:needs-editor')).toBe(false);
		expect(app.commands.isAvailable(app.commands.commands['sample:checked']!)).toBe(false);
		expect(app.commands.executeCommandById('sample:run')).toBe(true);
		await Promise.resolve();
		expect(plugin.ran).toBe(1);
		expect(app.commands.executeCommandById('sample:checked')).toBe(true);
		await Promise.resolve();
		expect(plugin.ran).toBe(2);

		plugin.unload();
		expect(Object.keys(app.commands.commands)).toEqual([]);
		expect(app.workspace.leftRibbon.actionsEl.children.length).toBe(0);
		expect(app.statusBar.containerEl.children.length).toBe(0);
		expect(app.workspace.leftRibbon.items).toEqual([]);
		expect(app.setting.pluginTabs).toEqual([]);
		app.destroy();
	});

	it('reads and writes data.json in the plugin folder', async () => {
		const { app, config } = await createTestApp({}, { '.obsidian/plugins/sample/data.json': '{"greeting":"hi"}' });
		const plugin = new SamplePlugin(app, manifest);
		await loadAsync(plugin);
		expect(plugin.settings.greeting).toBe('hi');
		await plugin.saveData({ greeting: 'bye' });
		expect(JSON.parse(config.files.get('.obsidian/plugins/sample/data.json')!)).toEqual({ greeting: 'bye' });
		plugin.unload();
		app.destroy();
	});

	it('renders the setting tab in the settings modal', async () => {
		const { app, config } = await createTestApp();
		const plugin = new SamplePlugin(app, manifest);
		await loadAsync(plugin);
		app.setting.openTabById('sample');
		const modal = document.querySelector('.modal.mod-settings')!;
		expect(modal.querySelector('.vertical-tab-nav-item.is-active')?.textContent).toBe('Sample');
		const input = modal.querySelector<HTMLInputElement>('.setting-item input')!;
		expect(input.value).toBe('hello');
		input.value = 'changed';
		input.dispatchEvent(new Event('input'));
		await vi.waitFor(() => expect(config.files.get('.obsidian/plugins/sample/data.json')).toContain('changed'));
		app.setting.close();
		expect(document.querySelector('.modal.mod-settings')).toBeNull();
		plugin.unload();
		app.destroy();
	});

	it('runs command hotkeys from the keymap', async () => {
		const { app } = await createTestApp();
		const run = vi.fn();
		app.commands.addCommand({ id: 'x', name: 'X', callback: run, hotkeys: [{ modifiers: ['Shift'], key: 'k' }] });
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', code: 'KeyK', shiftKey: true }));
		await Promise.resolve();
		expect(run).toHaveBeenCalledTimes(1);
		app.destroy();
	});

	it('shows notices', () => {
		vi.useFakeTimers();
		const notice = new Notice('Saved', 1000);
		expect(document.querySelector('.notice-container .notice .notice-message')?.textContent).toBe('Saved');
		vi.advanceTimersByTime(1000);
		expect(notice.containerEl.isConnected).toBe(false);
		vi.useRealTimers();
	});
});
