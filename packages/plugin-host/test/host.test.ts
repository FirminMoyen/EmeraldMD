// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createTestApp } from '@emeraldmd/api/testing';
import { CommunityPluginsTab, PluginHost, type TrustStore } from '../src';

/** A plugin as bundlers emit it: CommonJS, with `obsidian` left external. */
const SAMPLE_MAIN = `
"use strict";
var obsidian = require("obsidian");
var view = require("@codemirror/view");
class SamplePlugin extends obsidian.Plugin {
	async onload() {
		const data = (await this.loadData()) || { count: 0 };
		this.addCommand({ id: "bump", name: "Bump", callback: async () => {
			data.count++;
			await this.saveData(data);
		} });
		this.registerEditorExtension(view.EditorView.lineWrapping);
		this.addSettingTab(new SampleTab(this.app, this));
		if (obsidian.Platform.isDesktopApp) require("fs");
		void obsidian.NotARealExport;
	}
}
class SampleTab extends obsidian.PluginSettingTab {
	display() {
		this.containerEl.empty();
		new obsidian.Setting(this.containerEl).setName("Sample option").addToggle((t) => t.setValue(true));
	}
}
module.exports = SamplePlugin;
`;

const ESM_INTEROP_MAIN = `
"use strict";
var __defProp = Object.defineProperty;
var main_exports = {};
__defProp(main_exports, "default", { get: () => Interop, enumerable: true });
module.exports = main_exports;
var import_obsidian = require("obsidian");
var Interop = class extends import_obsidian.Plugin {
	onload() { require("electron"); }
};
`;

function manifest(id: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ id, name: id[0]!.toUpperCase() + id.slice(1), version: '1.0.0', minAppVersion: '1.0.0', author: 'Test', description: `The ${id} plugin`, ...extra });
}

function trustStore(initial: boolean): TrustStore & { trusted: boolean } {
	const store = {
		trusted: initial,
		isTrusted: async () => store.trusted,
		setTrusted: async (t: boolean) => void (store.trusted = t),
	};
	return store;
}

async function setup(trusted: boolean) {
	const test = await createTestApp(
		{},
		{
			'.obsidian/community-plugins.json': '["sample", "interop"]',
			'.obsidian/plugins/sample/manifest.json': manifest('sample'),
			'.obsidian/plugins/sample/main.js': SAMPLE_MAIN,
			'.obsidian/plugins/sample/styles.css': '.sample { color: red; }',
			'.obsidian/plugins/interop-folder/manifest.json': manifest('interop'),
			'.obsidian/plugins/interop-folder/main.js': ESM_INTEROP_MAIN,
			'.obsidian/plugins/future/manifest.json': manifest('future', { minAppVersion: '99.0.0' }),
			'.obsidian/plugins/future/main.js': SAMPLE_MAIN,
			'.obsidian/plugins/broken/manifest.json': '{ not json',
		},
	);
	const trust = trustStore(trusted);
	const host = new PluginHost(test.app, trust);
	await host.initialize();
	return { ...test, host, trust };
}

describe('PluginHost', () => {
	it('finds installed plugins but runs nothing in restricted mode', async () => {
		const { app, host } = await setup(false);
		expect(Object.keys(host.manifests).sort()).toEqual(['future', 'interop', 'sample']);
		expect(host.manifests.interop!.dir).toBe('.obsidian/plugins/interop-folder');
		expect(host.errors.broken).toMatch(/manifest.json/);
		expect(host.restricted).toBe(true);
		expect(host.plugins).toEqual({});
		expect(await host.enablePlugin('sample')).toBe(false);
		expect(app.commands.listCommands()).toEqual([]);
		app.destroy();
	});

	it('loads enabled plugins once restricted mode is off, with shared modules', async () => {
		const { app, host, trust, config } = await setup(false);
		await host.setRestricted(false);
		expect(trust.trusted).toBe(true);
		expect(Object.keys(host.plugins).sort()).toEqual(['sample']);
		expect(app.plugins).toBe(host);
		expect(app.commands.commands['sample:bump']?.name).toBe('Sample: Bump');
		expect(document.head.querySelector('style[data-plugin-id="sample"]')?.textContent).toContain('.sample');
		expect(host.diagnostics.sample!.missingExports).toEqual(new Set(['NotARealExport']));
		expect([...host.diagnostics.sample!.requiredModules]).toEqual(['obsidian', '@codemirror/view']);

		// The ESM-interop bundle loaded, then failed in onload because it needs Electron.
		expect(host.errors.interop).toMatch(/Cannot find module 'electron'/);
		expect(host.diagnostics.interop!.missingModules).toEqual(new Set(['electron']));
		expect(host.plugins.interop).toBeUndefined();

		app.commands.executeCommandById('sample:bump');
		await vi.waitFor(() => expect(config.files.get('.obsidian/plugins/sample/data.json')).toBe('{\n  "count": 1\n}'));
		app.destroy();
		host.unloadAll();
	});

	it('refuses plugins that need a newer API', async () => {
		const { app, host } = await setup(true);
		expect(await host.enablePluginAndSave('future')).toBe(false);
		expect(host.errors.future).toMatch(/requires app version 99\.0\.0/);
		host.unloadAll();
		app.destroy();
	});

	it('unloads a disabled plugin and saves the enabled list', async () => {
		const { app, host, config } = await setup(true);
		expect(host.plugins.sample).toBeDefined();
		await host.disablePluginAndSave('sample');
		expect(host.plugins.sample).toBeUndefined();
		expect(app.commands.commands['sample:bump']).toBeUndefined();
		expect(app.setting.pluginTabs).toEqual([]);
		expect(document.head.querySelector('style[data-plugin-id="sample"]')).toBeNull();
		expect(JSON.parse(config.files.get('.obsidian/community-plugins.json')!)).toEqual(['interop']);
		await host.enablePluginAndSave('sample');
		expect(JSON.parse(config.files.get('.obsidian/community-plugins.json')!)).toEqual(['interop', 'sample']);
		host.unloadAll();
		app.destroy();
	});

	it('lists plugins with toggles and opens their settings tab', async () => {
		const { app, host } = await setup(true);
		const tab = new CommunityPluginsTab(app, host);
		app.setting.addBuiltInTab(tab);
		app.setting.openTabById('community-plugins');
		const names = [...tab.containerEl.querySelectorAll('.community-plugin-item .setting-item-name')].map((n) => n.textContent);
		expect(names).toEqual(['Future', 'Interop', 'Sample', 'broken']);
		const sample = [...tab.containerEl.querySelectorAll('.community-plugin-item')].find((el) => el.textContent?.includes('Sample'))!;
		expect(sample.querySelector('.checkbox-container')?.classList.contains('is-enabled')).toBe(true);
		sample.querySelector<HTMLElement>('.extra-setting-button')!.click();
		expect(app.setting.activeTab?.id).toBe('sample');
		expect(app.setting.activeTab?.containerEl.textContent).toContain('Sample option');
		app.setting.close();
		host.unloadAll();
		app.destroy();
	});
});
