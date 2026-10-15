import { describe, expect, it } from 'vitest';
import { TFile, TFolder, openVault, type FileEntry, type VaultBackend, type VaultUpdate } from '../src';

const file = (path: string, mtime = 1, size = 0): FileEntry => ({ path, kind: 'file', ctime: 1, mtime, size });
const folder = (path: string): FileEntry => ({ path, kind: 'folder', ctime: 1, mtime: 1, size: 0 });
const update = (u: Partial<VaultUpdate>): VaultUpdate => ({
	renamed: [],
	removed: [],
	upserted: [],
	metadata: {},
	links: {},
	...u,
});

/** Backend that replays canned updates, standing in for the Rust core. */
function fakeBackend(contents: Record<string, string> = {}): VaultBackend & { next: VaultUpdate } {
	const backend = {
		next: update({}),
		read: async (path: string) => contents[path] ?? '',
		write: async () => backend.next,
		create: async () => backend.next,
		createFolder: async () => backend.next,
		rename: async () => backend.next,
		trash: async () => backend.next,
	};
	return backend;
}

function setup() {
	const backend = fakeBackend({ 'Home.md': 'from disk' });
	const { vault, metadataCache } = openVault(backend, {
		name: 'Test',
		basePath: '/tmp/test',
		files: [file('Home.md'), folder('Projects'), file('Projects/Plan.md')],
		metadata: { 'Home.md': { links: [] } },
		links: { 'Home.md': { resolved: { 'Projects/Plan.md': 1 }, unresolved: {} } },
	});
	const events: string[] = [];
	for (const name of ['create', 'modify', 'delete', 'rename']) {
		vault.on(name, (f: { path: string }, old?: string) => events.push(old ? `${name}:${old}->${f.path}` : `${name}:${f.path}`));
	}
	return { backend, vault, metadataCache, events };
}

describe('Vault mirror', () => {
	it('builds the tree from a snapshot', () => {
		const { vault } = setup();
		const plan = vault.getAbstractFileByPath('/Projects/Plan.md/');
		expect(plan).toBeInstanceOf(TFile);
		expect((plan as TFile).basename).toBe('Plan');
		expect(plan!.parent).toBe(vault.getFolderByPath('Projects'));
		expect(vault.getRoot().children.map((c) => c.name).sort()).toEqual(['Home.md', 'Projects']);
		expect(vault.getMarkdownFiles()).toHaveLength(2);
	});

	it('caches own writes and fires modify', async () => {
		const { backend, vault, events } = setup();
		const home = vault.getFileByPath('Home.md')!;
		backend.next = update({ upserted: [file('Home.md', 2, 5)] });
		await vault.modify(home, 'hello');
		expect(await vault.cachedRead(home)).toBe('hello');
		expect(home.stat.mtime).toBe(2);
		expect(events).toEqual(['modify:Home.md']);
	});

	it('drops cached content when the file changes outside the app', async () => {
		const { vault } = setup();
		const home = vault.getFileByPath('Home.md')!;
		await vault.cachedRead(home);
		vault.applyUpdate(update({ upserted: [file('Home.md', 9, 9)] }));
		expect(vault.peekContent('Home.md')).toBeUndefined();
	});

	it('creates missing parents and keeps object identity across renames', async () => {
		const { backend, vault, metadataCache, events } = setup();
		const plan = vault.getFileByPath('Projects/Plan.md')!;
		backend.next = update({ renamed: [['Projects', 'Archive/Projects']], upserted: [folder('Archive')] });
		await vault.rename(vault.getFolderByPath('Projects')!, 'Archive/Projects');
		expect(plan.path).toBe('Archive/Projects/Plan.md');
		expect(vault.getFileByPath('Archive/Projects/Plan.md')).toBe(plan);
		expect(vault.getAbstractFileByPath('Projects')).toBeNull();
		expect(vault.getFolderByPath('Archive')).toBeInstanceOf(TFolder);
		expect(events).toEqual([
			'create:Archive',
			'rename:Projects->Archive/Projects',
			'rename:Projects/Plan.md->Archive/Projects/Plan.md',
		]);
		expect(metadataCache.getFirstLinkpathDest('Plan', 'Home.md')).toBe(plan);
	});

	it('removes deleted files and their metadata', async () => {
		const { backend, vault, metadataCache, events } = setup();
		backend.next = update({ removed: ['Home.md'] });
		await vault.trash(vault.getFileByPath('Home.md')!);
		expect(vault.getFileByPath('Home.md')).toBeNull();
		expect(metadataCache.getCache('Home.md')).toBeNull();
		expect(metadataCache.resolvedLinks['Home.md']).toBeUndefined();
		expect(events).toEqual(['delete:Home.md']);
	});

	it('applies metadata and links, and reports backlinks', () => {
		const { vault, metadataCache } = setup();
		const changed: string[] = [];
		metadataCache.on('changed', (f: TFile) => changed.push(f.path));
		vault.applyUpdate(
			update({
				metadata: { 'Projects/Plan.md': { tags: [] } },
				links: { 'Projects/Plan.md': { resolved: { 'Home.md': 1 }, unresolved: {} } },
			}),
		);
		expect(changed).toEqual(['Projects/Plan.md']);
		expect(metadataCache.getBacklinks(vault.getFileByPath('Home.md')!)).toEqual(['Projects/Plan.md']);
		expect(metadataCache.fileToLinktext(vault.getFileByPath('Projects/Plan.md')!, 'Home.md')).toBe('Plan');
	});

	it('suggests free paths', () => {
		const { vault } = setup();
		expect(vault.getAvailablePath('Home', 'md')).toBe('Home 1.md');
		expect(vault.getAvailablePath('Untitled', 'md')).toBe('Untitled.md');
	});
});
