/**
 * Headless smoke test of one community plugin: install it into an in-memory
 * vault, turn community plugins on, enable it, render its settings tab, then
 * disable it and look for anything it left behind.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MarkdownView, CodeMirrorEditor, setRequestBackend, type App } from '@emeraldmd/api';
import { createTestApp } from '@emeraldmd/api/testing';
import { PluginHost } from '@emeraldmd/plugin-host';
import { EditorView } from '@codemirror/view';

export interface PinnedPlugin {
	id: string;
	repo: string;
	version: string;
	license: string;
	sha256: Record<string, string>;
	/** The furthest stage it reached last time (see STAGES); a run that gets less far fails. */
	expect?: Stage;
}

export const STAGES = ['none', 'loads', 'enables', 'settings', 'clean-unload'] as const;
export type Stage = (typeof STAGES)[number];

export interface SmokeResult {
	id: string;
	name: string;
	version: string;
	/** The furthest stage reached: loads (module evaluated), enables (onload finished), settings (tab rendered), clean-unload. */
	stage: Stage;
	error: string | null;
	commands: string[];
	commandErrors: string[];
	settingItems: number | null;
	ribbonIcons: number;
	statusBarItems: number;
	views: string[];
	editorExtensions: number;
	leftovers: string[];
	missingModules: string[];
	missingExports: string[];
	/** Errors logged or thrown asynchronously while the plugin ran. */
	consoleErrors: string[];
}

const CACHE = join('compat', '.cache', 'plugins');

export function pluginDir(plugin: PinnedPlugin): string {
	return join(CACHE, plugin.id, plugin.version);
}

export function isCached(plugin: PinnedPlugin): boolean {
	return existsSync(join(pluginDir(plugin), 'main.js'));
}

/** A small vault with the kinds of notes popular plugins look at. */
const SAMPLE_NOTES: Record<string, string> = {
	'Home.md': '# Home\n\nSee [[Projects/Plan]] and #inbox.\n\n- [ ] Write the plan 📅 2026-10-20\n- [x] Open the vault\n',
	'Projects/Plan.md': '---\ntags: [project]\nstatus: active\n---\n# Plan\n\nBack to [[Home]].\n\n```dataview\nLIST FROM #project\n```\n',
	'Daily/2026-10-16.md': '# Friday\n\nNothing yet.\n',
};

function message(err: unknown): string {
	return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * happy-dom has no Web Workers (the app's webview does). Plugins that start a
 * worker get one that accepts messages and never answers.
 */
class SilentWorker extends EventTarget {
	onmessage: ((ev: MessageEvent) => unknown) | null = null;
	onerror: ((ev: Event) => unknown) | null = null;
	postMessage(): void {}
	terminate(): void {}
}
const workerGlobal = globalThis as { Worker?: unknown };
workerGlobal.Worker ??= SilentWorker;

/** Gives the app a note editor, as the desktop shell does, so editor commands and extensions have a target. */
function attachEditor(app: App): EditorView {
	const view = new MarkdownView(app.workspace.rootLeaf);
	const cm = new EditorView({ doc: SAMPLE_NOTES['Home.md'], parent: view.contentEl });
	view.editor = new CodeMirrorEditor(cm);
	app.workspace.setHost(
		{
			openFile: async (file) => {
				view.file = file;
				view.editor.setValue(await app.vault.read(file));
				app.workspace.trigger('file-open', file);
			},
			save: async () => {},
			setEditorExtensions: () => {},
		},
		view,
	);
	document.body.appendChild(app.workspace.rootSplit.containerEl);
	return cm;
}

export async function smokeTest(plugin: PinnedPlugin): Promise<SmokeResult> {
	const dir = pluginDir(plugin);
	const read = (file: string) => readFileSync(join(dir, file), 'utf8');
	const config: Record<string, string> = {
		'.obsidian/community-plugins.json': JSON.stringify([plugin.id]),
		[`.obsidian/plugins/${plugin.id}/manifest.json`]: read('manifest.json'),
		[`.obsidian/plugins/${plugin.id}/main.js`]: read('main.js'),
	};
	if (existsSync(join(dir, 'styles.css'))) config[`.obsidian/plugins/${plugin.id}/styles.css`] = read('styles.css');
	const manifest = JSON.parse(config[`.obsidian/plugins/${plugin.id}/manifest.json`]!) as { name: string; version: string };

	const result: SmokeResult = {
		id: plugin.id,
		name: manifest.name,
		version: manifest.version,
		stage: 'none',
		error: null,
		commands: [],
		commandErrors: [],
		settingItems: null,
		ribbonIcons: 0,
		statusBarItems: 0,
		views: [],
		editorExtensions: 0,
		leftovers: [],
		missingModules: [],
		missingExports: [],
		consoleErrors: [],
	};

	// The harness never touches the network.
	setRequestBackend(async () => ({ status: 503, headers: {}, body: new ArrayBuffer(0) }));
	const originalError = console.error;
	console.error = (...args: unknown[]) => {
		result.consoleErrors.push(args.map(message).join(' ').slice(0, 300));
		// COMPAT_STACKS=1 appends where each error came from to compat/.cache/stacks.log.
		if (process.env.COMPAT_STACKS) for (const a of args) if ((a as Error)?.stack) appendFileSync('compat/.cache/stacks.log', `${plugin.id}: ${(a as Error).stack}\n\n`);
	};
	const onAsyncError = (err: unknown) => void result.consoleErrors.push(message((err as { reason?: unknown }).reason ?? err).slice(0, 300));
	process.on('unhandledRejection', onAsyncError);
	process.on('uncaughtException', onAsyncError);

	const { app } = await createTestApp(SAMPLE_NOTES, config);
	const cm = attachEditor(app);
	const host = new PluginHost(app, { isTrusted: async () => true, setTrusted: async () => {} });
	const prefix = `${plugin.id}:`;
	try {
		await app.workspace.getLeaf().openFile(app.vault.getFileByPath('Home.md')!);
		await host.initialize();
		const diagnostics = host.diagnostics[plugin.id];
		const instance = host.getPlugin(plugin.id);
		if (diagnostics?.requiredModules.size || instance) result.stage = 'loads';
		if (!instance) {
			result.error = host.errors[plugin.id] ?? 'not loaded';
			return result;
		}
		result.stage = 'enables';
		app.workspace.setLayoutReady();
		await sleep(50);

		result.commands = Object.keys(app.commands.commands).filter((id) => id.startsWith(prefix));
		for (const id of result.commands) {
			const command = app.commands.commands[id]!;
			try {
				// Checking availability runs check callbacks without executing the command.
				app.commands.isAvailable(command);
			} catch (err) {
				result.commandErrors.push(`${id}: ${message(err)}`);
			}
		}
		result.ribbonIcons = app.workspace.leftRibbon.actionsEl.children.length;
		result.statusBarItems = app.statusBar.containerEl.children.length;
		result.views = Object.keys(app.viewRegistry.viewByType);
		result.editorExtensions = (app.workspace as unknown as { editorExtensions: unknown[] }).editorExtensions.length;

		const tab = app.setting.pluginTabs.find((t) => t.id === plugin.id);
		if (tab) {
			app.setting.openTabById(plugin.id);
			const failed = tab.containerEl.querySelector('.setting-tab-error');
			if (failed) result.error = failed.textContent;
			else result.settingItems = tab.containerEl.querySelectorAll('.setting-item').length;
			app.setting.close();
		}
		if (tab && result.settingItems === null) return result;
		result.stage = 'settings';

		await host.disablePlugin(plugin.id);
		await sleep(20);
		const left = result.leftovers;
		if (Object.keys(app.commands.commands).some((id) => id.startsWith(prefix))) left.push('commands');
		if (app.setting.pluginTabs.length) left.push('setting tab');
		if (app.workspace.leftRibbon.actionsEl.children.length || app.workspace.leftRibbon.items.length) left.push('ribbon icons');
		if (app.statusBar.containerEl.children.length) left.push('status bar items');
		if (Object.keys(app.viewRegistry.viewByType).length) left.push('views');
		if ((app.workspace as unknown as { editorExtensions: unknown[] }).editorExtensions.length) left.push('editor extensions');
		if (document.head.querySelector(`style[data-plugin-id="${plugin.id}"]`)) left.push('styles');
		if (left.length === 0) result.stage = 'clean-unload';
		return result;
	} catch (err) {
		result.error = message(err);
		return result;
	} finally {
		const diagnostics = host.diagnostics[plugin.id];
		result.missingModules = [...(diagnostics?.missingModules ?? [])].sort();
		result.missingExports = [...(diagnostics?.missingExports ?? [])].sort();
		host.unloadAll();
		cm.destroy();
		app.workspace.rootSplit.containerEl.remove();
		app.destroy();
		await sleep(10);
		process.off('unhandledRejection', onAsyncError);
		process.off('uncaughtException', onAsyncError);
		console.error = originalError;
		document.body.replaceChildren();
		document.head.replaceChildren();
		result.consoleErrors = [...new Set(result.consoleErrors)];
	}
}

/** Markdown for docs/compat/plugins.md. */
export function renderReport(results: SmokeResult[], plugins: PinnedPlugin[]): string {
	const yes = (ok: boolean) => (ok ? '✅' : '❌');
	const reached = (r: SmokeResult, stage: Stage) => STAGES.indexOf(r.stage) >= STAGES.indexOf(stage);
	const lines = [
		'# Community plugin compatibility',
		'',
		'Generated by `npm run compat` (compat/smoke.test.ts) with `UPDATE_COMPAT_DOCS=1`. Each plugin is',
		'installed into an in-memory vault and run headlessly (Vitest + happy-dom, no network):',
		'load `main.js` → enable (`onload`) → open its settings tab → disable, then look for',
		'anything left registered. Versions are pinned with SHA-256 hashes in `compat/plugins.json`.',
		'',
		'This is a smoke test: it shows that a plugin starts, registers its commands and settings and',
		'unloads cleanly, not that every feature works. Plugins were picked from the most downloaded',
		'community plugins that are MIT-licensed and not desktop-only.',
		'',
		'Headless differences from the app: happy-dom has no IndexedDB, and no Web Workers (the harness',
		'gives plugins a worker that never answers). The app\'s webview has both. `compat/desktop.test.ts`',
		'also runs Hider through the desktop UI code (command palette, settings modal).',
		'',
		'| Plugin | Version | Loads | Enables | Settings tab | Clean unload | Commands | Notes |',
		'|---|---|---|---|---|---|---|---|',
	];
	for (const r of results) {
		const plugin = plugins.find((p) => p.id === r.id)!;
		const notes: string[] = [];
		if (r.error) notes.push(`Error: ${r.error.replace(/\|/g, '\\|').slice(0, 160)}`);
		if (r.missingModules.length) notes.push(`Needs modules: ${r.missingModules.map((m) => `\`${m}\``).join(', ')}`);
		if (r.missingExports.length) notes.push(`Missing API: ${r.missingExports.map((m) => `\`${m}\``).join(', ')}`);
		if (r.leftovers.length) notes.push(`Left behind: ${r.leftovers.join(', ')}`);
		if (r.settingItems !== null) notes.push(`${r.settingItems} setting rows`);
		if (r.views.length) notes.push(`Views: ${r.views.map((v) => `\`${v}\``).join(', ')}`);
		if (r.consoleErrors.length) notes.push(`${r.consoleErrors.length} logged error(s)`);
		lines.push(
			`| [${r.name}](https://github.com/${plugin.repo}) | ${r.version} | ${yes(reached(r, 'loads'))} | ${yes(reached(r, 'enables'))} | ${
				r.settingItems === null && reached(r, 'settings') ? '–' : yes(reached(r, 'settings'))
			} | ${yes(reached(r, 'clean-unload'))} | ${r.commands.length} | ${notes.join('; ') || '–'} |`,
		);
	}
	const passing = results.filter((r) => r.stage === 'clean-unload').length;
	lines.push('', `${passing} of ${results.length} plugins pass every stage.`, '');
	const logged = results.filter((r) => r.consoleErrors.length);
	if (logged.length) {
		lines.push('## Logged errors', '', 'First errors each plugin logged while running (truncated).', '');
		for (const r of logged) {
			lines.push(`- **${r.name}**`);
			for (const e of r.consoleErrors.slice(0, 3)) lines.push(`  - \`${e.replace(/`/g, "'").replace(/\s+/g, ' ').slice(0, 200)}\``);
		}
		lines.push('');
	}
	return lines.join('\n');
}
