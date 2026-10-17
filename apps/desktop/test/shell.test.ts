// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { startShell, type Shell } from './shell-harness';

/** A community plugin as bundlers emit it: CommonJS with `obsidian` external. */
const GREETER = `
var obsidian = require("obsidian");
module.exports = class Greeter extends obsidian.Plugin {
	async onload() {
		this.settings = Object.assign({ greeting: "Hello from a plugin" }, await this.loadData());
		this.addCommand({ id: "insert", name: "Insert greeting", editorCallback: (editor) => editor.replaceSelection(this.settings.greeting) });
		this.addRibbonIcon("smile", "Greet", () => new obsidian.Notice(this.settings.greeting));
		this.addSettingTab(new GreeterTab(this.app, this));
	}
};
class GreeterTab extends obsidian.PluginSettingTab {
	display() {
		this.containerEl.empty();
		new obsidian.Setting(this.containerEl).setName("Greeting").addText((t) => t.setValue(this.plugin.settings.greeting).onChange(async (v) => {
			this.plugin.settings.greeting = v;
			await this.plugin.saveData(this.plugin.settings);
		}));
	}
}
`;

const manifest = JSON.stringify({ id: 'greeter', name: 'Greeter', version: '1.0.0', minAppVersion: '1.0.0', author: 'Test', description: 'Says hello.' });

describe('desktop shell with a community plugin', () => {
	let shell: Shell;

	it('opens the vault in restricted mode', async () => {
		shell = await startShell(
			{ 'Welcome.md': '# Welcome\n' },
			{
				'.obsidian/community-plugins.json': '["greeter"]',
				'.obsidian/plugins/greeter/manifest.json': manifest,
				'.obsidian/plugins/greeter/main.js': GREETER,
			},
		);
		expect(shell.editorText()).toBe('# Welcome\n');
		expect(shell.app.plugins.getPlugin('greeter')).toBeNull();
		expect(document.querySelector('.notice')?.textContent).toMatch(/community plugins/);
	});

	it('turns community plugins on from Settings', async () => {
		shell.press(',', { mod: true });
		const modal = document.querySelector('.modal.mod-settings')!;
		expect(modal.querySelector('.vertical-tab-nav-item.is-active')?.textContent).toBe('Community plugins');
		const button = [...modal.querySelectorAll('button')].find((b) => b.textContent === 'Turn on community plugins')!;
		button.click();
		await vi.waitFor(() => expect(shell.app.plugins.getPlugin('greeter')).not.toBeNull());
		expect(shell.trust.trusted).toBe(true);
		expect(document.querySelector('#ribbon .side-dock-ribbon-action[aria-label="Greet"]')).not.toBeNull();
	});

	it("renders the plugin's settings tab", async () => {
		const nav = [...document.querySelectorAll('.vertical-tab-nav-item')].find((n) => n.textContent === 'Greeter') as HTMLElement;
		nav.click();
		const input = document.querySelector<HTMLInputElement>('.vertical-tab-content .setting-item input')!;
		expect(input.value).toBe('Hello from a plugin');
		shell.typeInto(input, 'Hi there');
		await vi.waitFor(() => expect(shell.config.files.get('.obsidian/plugins/greeter/data.json')).toContain('Hi there'));
		shell.press('Escape');
		expect(document.querySelector('.modal.mod-settings')).toBeNull();
	});

	it('runs the plugin command from the command palette', async () => {
		shell.app.workspace.activeEditor!.editor!.setCursor({ line: 1, ch: 0 });
		shell.press('p', { mod: true });
		const input = document.querySelector<HTMLInputElement>('.prompt-input')!;
		shell.typeInto(input, 'greeting');
		await vi.waitFor(() => expect(document.querySelector('.prompt-results .suggestion-item.is-selected')?.textContent).toBe('Greeter: Insert greeting'));
		shell.press('Enter');
		await vi.waitFor(() => expect(shell.editorText()).toBe('# Welcome\nHi there'));
		expect(document.querySelector('.prompt')).toBeNull();
	});

	it('unloads the plugin when it is turned off', async () => {
		await shell.app.plugins.disablePluginAndSave('greeter');
		expect(shell.app.commands.findCommand('greeter:insert')).toBeUndefined();
		expect(document.querySelector('#ribbon .side-dock-ribbon-action[aria-label="Greet"]')).toBeNull();
		expect(JSON.parse(shell.config.files.get('.obsidian/community-plugins.json')!)).toEqual([]);
	});
});
