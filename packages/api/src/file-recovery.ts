/**
 * File recovery (core plugin `file-recovery`): snapshots of notes, kept on
 * this device for a few days, to look back at and restore.
 *
 * A note gets a snapshot when it opens and when it changes (whoever changed
 * it: this app, another program, another device), at most one per note per
 * interval (5 minutes by default) and only if its text changed. Snapshots
 * live in the webview's IndexedDB, one database per vault, and are pruned
 * after the history length (7 days by default). Options are in
 * `.obsidian/file-recovery.json`: `interval` (minutes) and `keep` (days).
 */

import { TFile, type TAbstractFile } from '@emeraldmd/core';
import type { App } from './app';
import { confirmAction } from './confirm';
import { InternalPluginInstance } from './core-plugins';
import { Modal } from './modal';
import { moment } from './moment';
import { Notice } from './notice';

export interface Snapshot {
	id?: number;
	path: string;
	/** Milliseconds since the epoch. */
	time: number;
	text: string;
}

/** Where snapshots are kept. */
export interface SnapshotStore {
	add(snapshot: Snapshot): Promise<void>;
	/** A note's snapshots, newest first. */
	list(path: string): Promise<Snapshot[]>;
	/** Every note with snapshots, with its newest snapshot's time. */
	paths(): Promise<{ path: string; time: number }[]>;
	/** Removes snapshots older than `time`. */
	prune(time: number): Promise<void>;
	clear(): Promise<void>;
}

/** Snapshots in memory (tests, or a webview without IndexedDB). */
export class MemorySnapshotStore implements SnapshotStore {
	private snapshots: Snapshot[] = [];
	private nextId = 1;

	async add(snapshot: Snapshot): Promise<void> {
		this.snapshots.push({ ...snapshot, id: this.nextId++ });
	}

	async list(path: string): Promise<Snapshot[]> {
		return this.snapshots.filter((s) => s.path === path).sort((a, b) => b.time - a.time || (b.id ?? 0) - (a.id ?? 0));
	}

	async paths(): Promise<{ path: string; time: number }[]> {
		const newest = new Map<string, number>();
		for (const s of this.snapshots) newest.set(s.path, Math.max(newest.get(s.path) ?? 0, s.time));
		return [...newest].map(([path, time]) => ({ path, time }));
	}

	async prune(time: number): Promise<void> {
		this.snapshots = this.snapshots.filter((s) => s.time >= time);
	}

	async clear(): Promise<void> {
		this.snapshots = [];
	}
}

/** Snapshots in IndexedDB: one database per vault, an index by note and by time. */
export class IndexedDbSnapshotStore implements SnapshotStore {
	private db: Promise<IDBDatabase> | null = null;

	constructor(private readonly name: string) {}

	private open(): Promise<IDBDatabase> {
		this.db ??= new Promise((resolve, reject) => {
			const request = indexedDB.open(this.name, 1);
			request.onupgradeneeded = () => {
				const store = request.result.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
				store.createIndex('path', 'path');
				store.createIndex('time', 'time');
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		return this.db;
	}

	private async run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
		const db = await this.open();
		return new Promise((resolve, reject) => {
			const tx = db.transaction('snapshots', mode);
			const request = work(tx.objectStore('snapshots'));
			tx.oncomplete = () => resolve(request ? request.result : undefined);
			tx.onerror = () => reject(tx.error);
		});
	}

	async add(snapshot: Snapshot): Promise<void> {
		const { id: _id, ...record } = snapshot;
		await this.run('readwrite', (store) => store.add(record));
	}

	async list(path: string): Promise<Snapshot[]> {
		const found = (await this.run<Snapshot[]>('readonly', (store) => store.index('path').getAll(path))) ?? [];
		return found.sort((a, b) => b.time - a.time || (b.id ?? 0) - (a.id ?? 0));
	}

	async paths(): Promise<{ path: string; time: number }[]> {
		const newest = new Map<string, number>();
		await this.run('readonly', (store) => {
			const cursor = store.openCursor();
			cursor.onsuccess = () => {
				const current = cursor.result;
				if (!current) return;
				const { path, time } = current.value as Snapshot;
				newest.set(path, Math.max(newest.get(path) ?? 0, time));
				current.continue();
			};
		});
		return [...newest].map(([path, time]) => ({ path, time }));
	}

	async prune(time: number): Promise<void> {
		await this.run('readwrite', (store) => {
			const cursor = store.index('time').openCursor(IDBKeyRange.upperBound(time, true));
			cursor.onsuccess = () => {
				const current = cursor.result;
				if (!current) return;
				current.delete();
				current.continue();
			};
		});
	}

	async clear(): Promise<void> {
		await this.run('readwrite', (store) => store.clear());
	}
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export class FileRecovery extends InternalPluginInstance {
	readonly id = 'file-recovery';
	readonly name = 'File recovery';
	readonly description = 'Keeps snapshots of your notes on this device, to look back at and restore.';
	/** @internal Where snapshots go; set before the plugin is on. */
	store: SnapshotStore | null = null;
	/** The time and text of each note's latest snapshot this session. */
	private readonly latest = new Map<string, { time: number; text: string }>();
	private pruneTimer: ReturnType<typeof setInterval> | undefined;

	/** Minutes between two snapshots of the same note. */
	get interval(): number {
		const value = Number(this.options.interval);
		return Number.isFinite(value) && value > 0 ? value : 5;
	}

	/** Days snapshots are kept. */
	get keep(): number {
		const value = Number(this.options.keep);
		return Number.isFinite(value) && value > 0 ? value : 7;
	}

	onEnable(): void {
		this.store ??= typeof indexedDB === 'undefined' ? new MemorySnapshotStore() : new IndexedDbSnapshotStore(`emerald-file-recovery-${this.app.appId}`);
		const vault = this.app.vault;
		this.registerEvent(vault.on('modify', (file: TAbstractFile) => void this.snapshot(file)));
		this.registerEvent(this.app.workspace.on('file-open', (file: TFile | null) => void (file && this.snapshot(file))));
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: import('./menu').Menu, file: TAbstractFile) => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				menu.addItem((item) => item.setTitle('Open local history').setIcon('history').setSection('info').onClick(() => this.openHistory(file)));
			}),
		);
		this.addCommand({
			id: 'file-recovery:open',
			name: 'File recovery: Open local history',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (checking) return true;
				this.openHistory(file?.extension === 'md' ? file : null);
				return true;
			},
		});
		void this.prune();
		this.pruneTimer = setInterval(() => void this.prune(), 6 * 60 * MINUTE);
	}

	override disable(): void {
		super.disable();
		clearInterval(this.pruneTimer);
	}

	/** Takes a snapshot of a note if its last one is older than the interval and its text changed. */
	async snapshot(file: TAbstractFile, now = Date.now()): Promise<void> {
		if (!(file instanceof TFile) || file.extension !== 'md' || !this.store) return;
		const last = this.latest.get(file.path) ?? (await this.store.list(file.path))[0];
		if (last && now - last.time < this.interval * MINUTE) return;
		let text: string;
		try {
			text = await this.app.vault.cachedRead(file);
		} catch {
			return;
		}
		if (last && last.text === text) return;
		this.latest.set(file.path, { time: now, text });
		await this.store.add({ path: file.path, time: now, text }).catch((err: unknown) => console.error('File recovery: could not save a snapshot', err));
	}

	async prune(now = Date.now()): Promise<void> {
		await this.store?.prune(now - this.keep * DAY).catch((err: unknown) => console.error(err));
	}

	async clearHistory(): Promise<void> {
		this.latest.clear();
		await this.store?.clear();
	}

	/** The local history of `file`, or a list of the notes that have one. */
	openHistory(file: TFile | null): void {
		const store = this.store;
		if (!store) return;
		const source: HistorySource = {
			list: (path) => store.list(path),
			paths: () => store.paths(),
			beforeRestore: (path, text) => store.add({ path, time: Date.now(), text }),
		};
		new HistoryModal(this.app, source, file?.path ?? null, LOCAL_HISTORY).open();
	}
}

/** A line diff (longest common subsequence): lines removed from `a`, added in `b`, or kept. */
export function diffLines(a: string, b: string): { kind: 'same' | 'removed' | 'added'; text: string }[] {
	const x = a.split('\n');
	const y = b.split('\n');
	// Too large to compare line by line here: show both whole.
	if (x.length * y.length > 4_000_000) return [...x.map((text) => ({ kind: 'removed' as const, text })), ...y.map((text) => ({ kind: 'added' as const, text }))];
	const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
	for (let i = x.length - 1; i >= 0; i--) {
		for (let j = y.length - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
	}
	const out: { kind: 'same' | 'removed' | 'added'; text: string }[] = [];
	let i = 0;
	let j = 0;
	while (i < x.length && j < y.length) {
		if (x[i] === y[j]) {
			out.push({ kind: 'same', text: x[i]! });
			i++;
			j++;
		} else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
			out.push({ kind: 'removed', text: x[i++]! });
		} else {
			out.push({ kind: 'added', text: y[j++]! });
		}
	}
	while (i < x.length) out.push({ kind: 'removed', text: x[i++]! });
	while (j < y.length) out.push({ kind: 'added', text: y[j++]! });
	return out;
}

/** Where a history modal gets versions: the local snapshots, or a server's version history. */
export interface HistorySource {
	/** A file's versions, newest first. */
	list(path: string): Promise<Snapshot[]>;
	/** The files to choose from when the modal opens without one, most recent first. */
	paths(): Promise<{ path: string; time: number }[]>;
	/** Keeps the current text before a version replaces it, when the source does not do so itself. */
	beforeRestore?(path: string, text: string): Promise<void>;
}

/** The words of a history modal. */
export interface HistoryModalText {
	/** Title of a file's versions, followed by its path. */
	title: string;
	/** Title of the list of files. */
	listTitle: string;
	/** Back from a file to the list. */
	back: string;
	noVersions: string;
	noFiles: string;
	/** Why restoring can be undone. */
	undo: string;
}

const LOCAL_HISTORY: HistoryModalText = {
	title: 'Local history',
	listTitle: 'Local history',
	back: '← All notes',
	noVersions: 'No snapshots of this note yet.',
	noFiles: 'No snapshots yet. Notes get one when they open or change.',
	undo: 'Its current text gets a snapshot first, so this can be undone.',
};

/** The versions of one file (or a list of files that have some), with a preview, the changes since, Copy and Restore. */
export class HistoryModal extends Modal {
	private listEl!: HTMLElement;
	private previewEl!: HTMLElement;

	constructor(
		app: App,
		private readonly source: HistorySource,
		private path: string | null,
		private readonly text: HistoryModalText,
	) {
		super(app);
		this.modalEl.addClass('mod-file-recovery');
	}

	override onOpen(): void {
		const body = this.contentEl.createDiv('file-recovery-body');
		this.listEl = body.createDiv('file-recovery-list');
		this.previewEl = body.createDiv('file-recovery-preview');
		void this.render();
	}

	private async render(): Promise<void> {
		this.listEl.empty();
		this.previewEl.empty();
		if (this.path === null) return this.renderNotes();
		const path = this.path;
		this.titleEl.setText(`${this.text.title}: ${path}`);
		let snapshots: Snapshot[];
		try {
			snapshots = await this.source.list(path);
		} catch (err) {
			this.listEl.createDiv({ cls: 'file-recovery-empty', text: errorText(err) });
			return;
		}
		if (!snapshots.length) {
			this.listEl.createDiv({ cls: 'file-recovery-empty', text: this.text.noVersions });
			return;
		}
		const back = this.listEl.createDiv({ cls: 'file-recovery-back', text: this.text.back, attr: { tabindex: '0' } });
		back.addEventListener('click', () => {
			this.path = null;
			void this.render();
		});
		snapshots.forEach((snapshot, i) => {
			const item = this.listEl.createDiv({ cls: 'file-recovery-item', attr: { tabindex: '0' } });
			item.createDiv({ cls: 'file-recovery-time', text: moment(snapshot.time).calendar() });
			item.createDiv({ cls: 'file-recovery-size', text: `${snapshot.text.length} characters` });
			const select = () => {
				for (const el of this.listEl.querySelectorAll('.file-recovery-item.is-selected')) el.removeClass('is-selected');
				item.addClass('is-selected');
				void this.showSnapshot(path, snapshot);
			};
			item.addEventListener('click', select);
			if (i === 0) select();
		});
	}

	private async renderNotes(): Promise<void> {
		this.titleEl.setText(this.text.listTitle);
		let notes: { path: string; time: number }[];
		try {
			notes = (await this.source.paths()).sort((a, b) => b.time - a.time);
		} catch (err) {
			this.listEl.createDiv({ cls: 'file-recovery-empty', text: errorText(err) });
			return;
		}
		if (!notes.length) {
			this.listEl.createDiv({ cls: 'file-recovery-empty', text: this.text.noFiles });
			return;
		}
		for (const note of notes) {
			const item = this.listEl.createDiv({ cls: 'file-recovery-item', attr: { tabindex: '0' } });
			item.createDiv({ cls: 'file-recovery-path', text: note.path });
			item.createDiv({ cls: 'file-recovery-time', text: moment(note.time).calendar() });
			item.addEventListener('click', () => {
				this.path = note.path;
				void this.render();
			});
		}
	}

	private async showSnapshot(path: string, snapshot: Snapshot): Promise<void> {
		const preview = this.previewEl;
		preview.empty();
		const file = this.app.vault.getFileByPath(path);
		const current = file ? await this.app.vault.cachedRead(file).catch(() => null) : null;
		const actions = preview.createDiv('file-recovery-actions');
		const changes = actions.createEl('label', { cls: 'file-recovery-toggle' });
		const toggle = changes.createEl('input', { attr: { type: 'checkbox' } });
		changes.appendText(' Compare with the current version');
		toggle.disabled = current === null;
		const copy = actions.createEl('button', { text: 'Copy' });
		const restore = actions.createEl('button', { cls: 'mod-cta', text: 'Restore' });
		const content = preview.createDiv('file-recovery-content');
		const draw = () => {
			content.empty();
			if (!toggle.checked || current === null) {
				content.createEl('pre', { text: snapshot.text });
				return;
			}
			const pre = content.createEl('pre', { cls: 'file-recovery-diff' });
			for (const line of diffLines(snapshot.text, current)) {
				pre.createDiv({ cls: `file-recovery-line mod-${line.kind}`, text: `${line.kind === 'removed' ? '−' : line.kind === 'added' ? '+' : ' '} ${line.text}` });
			}
		};
		toggle.addEventListener('change', draw);
		draw();
		copy.addEventListener('click', () => {
			void navigator.clipboard?.writeText(snapshot.text).then(() => new Notice('Copied.'));
		});
		restore.addEventListener('click', async () => {
			const ok = await confirmAction(this.app, {
				title: 'Restore this version?',
				message: file ? `${path} goes back to this version. ${this.text.undo}` : `${path} was deleted; it is created again with this text.`,
				confirm: 'Restore',
			});
			if (!ok) return;
			try {
				if (file && current !== null) await this.source.beforeRestore?.(path, current);
				if (file) await this.app.vault.modify(file, snapshot.text);
				else await createWithFolders(this.app, path, snapshot.text);
				new Notice(`Restored ${path}.`);
				this.close();
			} catch (err) {
				new Notice(`Could not restore ${path}: ${err}`);
			}
		});
	}
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Creates `path` with `text`, and the folders it needs (a deleted file's folder may be gone too). */
async function createWithFolders(app: App, path: string, text: string): Promise<void> {
	const parts = path.split('/').slice(0, -1);
	for (let i = 1; i <= parts.length; i++) {
		const folder = parts.slice(0, i).join('/');
		if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
	}
	await app.vault.create(path, text);
}
