/**
 * The server's version history, for vaults on an EmeraldMD server (online
 * or synced): "Server: Show version history" for the open note (also in the
 * file menu) and "Server: Show deleted files", in the same modal as the local
 * history, with the changes since a version, Copy and Restore. Restoring
 * writes the text back like an edit, and the server keeps the text it
 * replaces as a version.
 */

import { HistoryModal, TFile, type App, type HistoryModalText, type HistorySource, type Menu, type TAbstractFile } from '@emeraldmd/api';
import type { RemoteBackend } from '@emeraldmd/core';

/** Files shown as text in the modal; the server keeps versions of attachments too, for its API. */
const TEXT_FILE = /\.(md|canvas|base|txt|csv|json|css|js)$/i;
/** Versions loaded at once, newest first. */
const MAX_VERSIONS = 100;

const SERVER_HISTORY: HistoryModalText = {
	title: 'Version history',
	listTitle: 'Deleted files',
	back: '← Deleted files',
	noVersions: 'The server has no versions of this file yet.',
	noFiles: 'There are no deleted files on the server.',
	undo: 'The server keeps its current text as a version, so this can be undone.',
};

/** The server's versions and deleted text files, for the history modal. */
export function serverHistorySource(backend: () => Promise<RemoteBackend>): HistorySource {
	const decoder = new TextDecoder();
	return {
		async list(path) {
			const server = await backend();
			const versions = (await server.versions(path)).slice(0, MAX_VERSIONS);
			return Promise.all(versions.map(async (v) => ({ path, time: v.time, text: decoder.decode(await server.readVersion(path, v.time)) })));
		},
		async paths() {
			const deleted = await (await backend()).deletedFiles();
			return deleted.filter((f) => TEXT_FILE.test(f.path)).map((f) => ({ path: f.path, time: f.deletedAt }));
		},
	};
}

/** Adds the commands and the file menu item, for a vault whose server `backend` returns. */
export function registerServerHistory(app: App, backend: () => Promise<RemoteBackend>): void {
	const source = serverHistorySource(backend);
	const open = (path: string | null) => new HistoryModal(app, source, path, SERVER_HISTORY).open();
	app.commands.addCommand({
		id: 'server-history:open',
		name: 'Server: Show version history',
		checkCallback: (checking) => {
			const file = app.workspace.getActiveFile();
			if (!file || !TEXT_FILE.test(file.path)) return false;
			if (!checking) open(file.path);
			return true;
		},
	});
	app.commands.addCommand({ id: 'server-history:deleted', name: 'Server: Show deleted files', callback: () => open(null) });
	app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
		if (!(file instanceof TFile) || !TEXT_FILE.test(file.path)) return;
		menu.addItem((item) => item.setTitle('Open version history').setIcon('history').setSection('info').onClick(() => open(file.path)));
	});
}
