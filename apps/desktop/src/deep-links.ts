/**
 * `emeraldmd://` links, like Obsidian's `obsidian://` URIs: macOS hands them
 * to the app (src-tauri/src/deep_links.rs), which keeps them until this page
 * takes them.
 *
 * - `open?vault=&file=` opens a note (`file` with or without `.md`).
 * - `new?vault=&file=|name=&content=&append=true&silent=true` creates a note
 *   (or adds to it with `append`), and opens it unless `silent`.
 * - `search?vault=&query=` searches the vault.
 * - `daily?vault=` opens today's daily note.
 * - Any other action goes to the handler a plugin registered with
 *   `registerObsidianProtocolHandler`.
 *
 * `vault` must name the open vault (or be left out). "Copy EmeraldMD URL"
 * (command and file menu) copies a note's `open` link.
 */

import { DailyNotes, moment, Notice, TFile, type App, type Menu, type TAbstractFile } from '@emeraldmd/api';
import { normalizePath } from '@emeraldmd/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const SCHEME = 'emeraldmd';

export interface DeepLinkHost {
	openSearch(query: string): Promise<void>;
}

/** The action and parameters of an `emeraldmd://` link, or null if it is not one. */
export function parseDeepLink(url: string): { action: string; params: Record<string, string> } | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== `${SCHEME}:`) return null;
	// `emeraldmd://open?…` puts the action in the host; `emeraldmd:open?…` in the path.
	const action = decodeURIComponent((parsed.host || parsed.pathname).replace(/^\/+|\/+$/g, ''));
	if (!action) return null;
	const params: Record<string, string> = {};
	for (const [key, value] of parsed.searchParams) params[key] = value;
	return { action, params };
}

/** The `open` link of a file in the open vault. */
export function deepLinkTo(app: App, file: TFile): string {
	const path = file.extension === 'md' ? file.path.slice(0, -3) : file.path;
	return `${SCHEME}://open?vault=${encodeURIComponent(app.vault.getName())}&file=${encodeURIComponent(path)}`;
}

/** The file a link's `file` parameter names: a path, with or without `.md`, or a note name. */
function fileFor(app: App, param: string): TFile | null {
	const path = normalizePath(param);
	return app.vault.getFileByPath(path) ?? app.vault.getFileByPath(`${path}.md`) ?? app.metadataCache.getFirstLinkpathDest(path, '');
}

/** Runs a link's action in the open vault. */
export async function handleDeepLink(app: App, host: DeepLinkHost, url: string): Promise<void> {
	const link = parseDeepLink(url);
	if (!link) return;
	const { action, params } = link;
	if (params.vault && params.vault !== app.vault.getName()) {
		new Notice(`This link is for the vault "${params.vault}". Open that vault, then follow the link again.`);
		return;
	}
	switch (action) {
		case 'open': {
			if (!params.file) return;
			const file = fileFor(app, params.file);
			if (!file) {
				new Notice(`${params.file} is not in this vault.`);
				return;
			}
			await app.workspace.getLeaf(false).openFile(file);
			return;
		}
		case 'new': {
			const name = params.file ?? params.name ?? 'Untitled';
			const path = normalizePath(name.endsWith('.md') ? name : `${name}.md`);
			const content = params.content ?? '';
			let file = app.vault.getFileByPath(path);
			if (file && params.append === 'true') {
				await app.vault.process(file, (text) => (text && !text.endsWith('\n') ? `${text}\n${content}` : text + content));
			} else if (file && params.overwrite === 'true') {
				await app.vault.modify(file, content);
			} else {
				const target = file ? app.vault.getAvailablePath(path.slice(0, -3), 'md') : path;
				const folder = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
				if (folder && !app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
				file = await app.vault.create(target, content);
			}
			if (params.silent !== 'true') await app.workspace.getLeaf(false).openFile(file);
			return;
		}
		case 'search':
			await host.openSearch(params.query ?? '');
			return;
		case 'daily': {
			const daily = app.internalPlugins.getEnabledPluginById('daily-notes');
			if (daily instanceof DailyNotes) await daily.openDay(moment());
			else new Notice('Turn on the Daily notes core plugin to open daily notes from a link.');
			return;
		}
	}
	const handler = app.protocolHandlers.get(action);
	if (!handler) {
		new Notice(`No plugin handles "${action}" links.`);
		return;
	}
	try {
		await handler({ action, ...params });
	} catch (err) {
		console.error(err);
	}
}

/** Follows links macOS hands to the app, from now on and those that started it. */
export async function setupDeepLinks(app: App, host: DeepLinkHost): Promise<void> {
	const copy = async (file: TFile) => {
		await navigator.clipboard.writeText(deepLinkTo(app, file));
		new Notice('Copied the link to this note.');
	};
	app.commands.addCommand({
		id: 'workspace:copy-url',
		name: 'Copy EmeraldMD URL',
		checkCallback: (checking) => {
			const file = app.workspace.getActiveFile();
			if (!file) return false;
			if (!checking) void copy(file).catch((err: unknown) => new Notice(`Could not copy: ${err}`));
			return true;
		},
	});
	app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
		if (!(file instanceof TFile)) return;
		menu.addItem((item) => item.setTitle('Copy EmeraldMD URL').setIcon('link').setSection('info').onClick(() => void copy(file)));
	});
	// Links wait in a queue on the Rust side; `open-url` only says there are some, so none is followed twice.
	const followPending = async () => {
		const urls = (await invoke<string[] | null>('take_open_urls').catch(() => null)) ?? [];
		for (const url of urls) await handleDeepLink(app, host, url).catch((err: unknown) => new Notice(`Could not follow the link: ${err}`));
	};
	const unlisten = await listen('open-url', () => void followPending()).catch(() => null);
	if (unlisten) window.addEventListener('beforeunload', unlisten);
	await followPending();
}
