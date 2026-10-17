import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteBackend, RemoteError, normalizeServerUrl, openVault, type RemoteStatus, type VaultSnapshot, type VaultUpdate, type WebSocketLike } from '../src';

const SERVER = 'https://notes.example.com';

const update = (u: Partial<VaultUpdate>): VaultUpdate => ({ renamed: [], removed: [], upserted: [], metadata: {}, links: {}, ...u });
const file = (path: string, mtime = 1) => ({ path, kind: 'file' as const, ctime: 1, mtime, size: 0 });

interface Call {
	method: string;
	url: URL;
	headers: Record<string, string>;
	body: string | undefined;
}

type Reply = Response | Error | (() => Response | Error);

/** A fetch that answers from `routes` (keyed "METHOD /path") and records calls. */
function mockFetch(routes: Record<string, Reply | Reply[]>) {
	const calls: Call[] = [];
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? 'GET';
		calls.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined });
		const route = routes[`${method} ${url.pathname}`];
		let reply = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route;
		if (typeof reply === 'function') reply = reply();
		if (!reply) return new Response('no route', { status: 599 });
		if (reply instanceof Error) throw reply;
		return reply.clone();
	});
	return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

class FakeSocket implements WebSocketLike {
	static all: FakeSocket[] = [];
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	closedByClient = false;
	readonly url: URL;

	constructor(url: string) {
		this.url = new URL(url);
		FakeSocket.all.push(this);
	}

	static last(): FakeSocket {
		const socket = FakeSocket.all.at(-1);
		if (!socket) throw new Error('no socket was opened');
		return socket;
	}

	open(): void {
		this.onopen?.(new Event('open'));
	}

	send(message: unknown): void {
		this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
	}

	drop(): void {
		this.onerror?.(new Event('error'));
		this.onclose?.(new CloseEvent('close', { code: 1006 }));
	}

	close(): void {
		this.closedByClient = true;
	}
}

const snapshotBody = (epoch: string, version: number) => ({
	name: 'Notes',
	basePath: '',
	files: [file('Home.md')],
	metadata: {},
	links: {},
	epoch,
	version,
});

function setup(routes: Record<string, Reply | Reply[]> = {}) {
	const { fetch, calls } = mockFetch({
		'GET /api/vaults/notes/snapshot': json(snapshotBody('e1', 3)),
		'POST /api/vaults/notes/events/ticket': () => json({ ticket: `t${calls.length}`, expiresInSecs: 30 }),
		...routes,
	});
	const updates: VaultUpdate[] = [];
	const statuses: RemoteStatus[] = [];
	const resyncs: VaultSnapshot[] = [];
	const backend = new RemoteBackend({
		serverUrl: `${SERVER}/`,
		vaultId: 'notes',
		token: 'secret',
		fetch,
		webSocket: (url) => new FakeSocket(url),
		onUpdate: (u) => updates.push(u),
		onStatus: (s) => statuses.push(s),
		onResync: (s) => void resyncs.push(s),
		random: () => 1,
	});
	return { backend, calls, updates, statuses, resyncs };
}

beforeEach(() => {
	FakeSocket.all = [];
});

afterEach(() => {
	vi.useRealTimers();
});

describe('normalizeServerUrl', () => {
	it('adds a scheme and drops trailing slashes', () => {
		expect(normalizeServerUrl(' notes.example.com/ ')).toBe('https://notes.example.com');
		expect(normalizeServerUrl('localhost:8484')).toBe('http://localhost:8484');
		expect(normalizeServerUrl('127.0.0.1:8484/')).toBe('http://127.0.0.1:8484');
		expect(normalizeServerUrl('https://example.com/emerald//?x=1#y')).toBe('https://example.com/emerald');
		expect(() => normalizeServerUrl('ftp://example.com')).toThrow(/https/);
	});
});

describe('RemoteBackend requests', () => {
	it('lists the vaults a token can open', async () => {
		const { fetch, calls } = mockFetch({ 'GET /api/vaults': json([{ id: 'notes', name: 'Notes' }]) });
		expect(await RemoteBackend.listVaults('notes.example.com', 'secret', fetch)).toEqual([{ id: 'notes', name: 'Notes' }]);
		expect(calls[0]!.headers.Authorization).toBe('Bearer secret');
	});

	it('loads the snapshot without the stream position', async () => {
		const { backend, calls } = setup();
		const snapshot = await backend.snapshot();
		expect(snapshot).toEqual({
			name: 'Notes',
			basePath: `${SERVER}/api/vaults/notes`,
			files: [file('Home.md')],
			metadata: {},
			links: {},
		});
		expect(calls[0]!.url.href).toBe(`${SERVER}/api/vaults/notes/snapshot`);
		expect(calls[0]!.headers.Authorization).toBe('Bearer secret');
	});

	it('maps vault operations to the HTTP API', async () => {
		const changed = update({ upserted: [file('A/Note.md', 2)] });
		const { backend, calls } = setup({
			'GET /api/vaults/notes/files': new Response('# Note'),
			'PUT /api/vaults/notes/files': json(changed),
			'POST /api/vaults/notes/files': json(changed),
			'POST /api/vaults/notes/folders': json(changed),
			'POST /api/vaults/notes/rename': json(changed),
			'POST /api/vaults/notes/trash': json(changed),
		});
		expect(await backend.read('A/Note.md')).toBe('# Note');
		expect(await backend.write('A/Note.md', 'new text')).toEqual(changed);
		await backend.create('A/New.md', 'x');
		await backend.createFolder('B');
		await backend.rename('A/Note.md', 'B/Note.md');
		await backend.trash('B');

		expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
			'GET /api/vaults/notes/files?path=A%2FNote.md',
			'PUT /api/vaults/notes/files?path=A%2FNote.md',
			'POST /api/vaults/notes/files',
			'POST /api/vaults/notes/folders',
			'POST /api/vaults/notes/rename',
			'POST /api/vaults/notes/trash',
		]);
		expect(calls[1]!.body).toBe('new text');
		expect(calls[1]!.headers['Content-Type']).toBe('text/plain; charset=utf-8');
		expect(calls.slice(2).map((c) => JSON.parse(c.body!))).toEqual([
			{ path: 'A/New.md', data: 'x' },
			{ path: 'B' },
			{ from: 'A/Note.md', to: 'B/Note.md' },
			{ path: 'B' },
		]);
		for (const call of calls) {
			expect(call.headers.Authorization).toBe('Bearer secret');
			expect(call.headers['X-EmeraldMD-Client']).toBe(backend.clientId);
		}
	});

	it('turns error responses into RemoteError', async () => {
		const { backend } = setup({
			'POST /api/vaults/notes/files': json({ error: 'already exists: A.md' }, 409),
			'GET /api/vaults/notes/files': new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
		});
		const conflict = await backend.create('A.md', '').catch((e: unknown) => e);
		expect(conflict).toBeInstanceOf(RemoteError);
		expect(conflict).toMatchObject({ status: 409, message: 'already exists: A.md' });
		await expect(backend.read('A.md')).rejects.toMatchObject({ status: 502, message: '502 Bad Gateway' });
	});

	it('works as the backend of a vault mirror', async () => {
		const { backend } = setup({ 'POST /api/vaults/notes/files': json(update({ upserted: [file('New.md')] })) });
		const { vault } = openVault(backend, await backend.snapshot());
		const created = await vault.create('New.md', 'hello');
		expect(created.path).toBe('New.md');
		expect(await vault.cachedRead(created)).toBe('hello');
	});
});

describe('RemoteBackend event stream', () => {
	it('streams changes from the snapshot version on, with a ticket', async () => {
		const { backend, calls, updates, statuses } = setup();
		await backend.snapshot();
		backend.connect();
		await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));

		const ticketCall = calls.find((c) => c.url.pathname.endsWith('/events/ticket'))!;
		expect(ticketCall.method).toBe('POST');
		expect(ticketCall.headers.Authorization).toBe('Bearer secret');
		const socket = FakeSocket.last();
		expect(socket.url.origin + socket.url.pathname).toBe('wss://notes.example.com/api/vaults/notes/events');
		expect(Object.fromEntries(socket.url.searchParams)).toEqual({ ticket: 't2', client: backend.clientId, epoch: 'e1', since: '3' });

		socket.open();
		const pushed = update({ upserted: [file('Theirs.md')] });
		socket.send({ type: 'update', version: 4, update: pushed });
		expect(updates).toEqual([pushed]);
		expect(statuses).toEqual(['connecting', 'connected']);
	});

	it('reconnects with exponential backoff and resumes after the last update', async () => {
		vi.useFakeTimers();
		const offline = new TypeError('Failed to fetch');
		const ticket = () => json({ ticket: 'again', expiresInSecs: 30 });
		const { backend, statuses } = setup({ 'POST /api/vaults/notes/events/ticket': [ticket, offline, offline, offline, ticket] });
		await backend.snapshot();
		backend.connect();
		await vi.advanceTimersByTimeAsync(0);
		FakeSocket.last().open();
		FakeSocket.last().send({ type: 'update', version: 7, update: update({}) });
		FakeSocket.last().drop();
		expect(statuses.at(-1)).toBe('reconnecting');

		// 500 ms, then 1 s and 2 s after the failed ticket requests, then 4 s.
		await vi.advanceTimersByTimeAsync(499);
		expect(FakeSocket.all).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1 + 1000 + 2000 + 3999);
		expect(FakeSocket.all).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(FakeSocket.all).toHaveLength(2);
		expect(FakeSocket.last().url.searchParams.get('since')).toBe('7');

		FakeSocket.last().open();
		expect(statuses.at(-1)).toBe('connected');
		// A successful connection resets the delay.
		FakeSocket.last().drop();
		await vi.advanceTimersByTimeAsync(500);
		expect(FakeSocket.all).toHaveLength(3);
	});

	it('caps the reconnect delay', async () => {
		vi.useFakeTimers();
		const { backend, calls } = setup({ 'POST /api/vaults/notes/events/ticket': new TypeError('offline') });
		const attempts = () => calls.filter((c) => c.url.pathname.endsWith('/events/ticket')).length;
		backend.connect();
		await vi.advanceTimersByTimeAsync(500 + 1000 + 2000 + 4000 + 8000 + 16000);
		expect(attempts()).toBe(7);
		// Uncapped, the next delay would be 32 s.
		await vi.advanceTimersByTimeAsync(29_999);
		expect(attempts()).toBe(7);
		await vi.advanceTimersByTimeAsync(1);
		expect(attempts()).toBe(8);
		backend.close();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('gives up when the server rejects the token', async () => {
		vi.useFakeTimers();
		const { backend, statuses } = setup({ 'POST /api/vaults/notes/events/ticket': json({ error: 'missing or invalid token' }, 401) });
		backend.connect();
		await vi.advanceTimersByTimeAsync(0);
		expect(statuses).toEqual(['connecting', 'unauthorized']);
		expect(vi.getTimerCount()).toBe(0);
		expect(FakeSocket.all).toHaveLength(0);
	});

	it('reloads the snapshot when the server asks for a resync', async () => {
		const { backend, resyncs, calls } = setup({
			'GET /api/vaults/notes/snapshot': [json(snapshotBody('e1', 3)), json(snapshotBody('e2', 0))],
		});
		await backend.snapshot();
		backend.connect();
		await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
		const first = FakeSocket.last();
		first.open();
		first.send({ type: 'resync' });
		expect(first.closedByClient).toBe(true);

		await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
		expect(resyncs).toHaveLength(1);
		expect(resyncs[0]!.files).toEqual([file('Home.md')]);
		expect(calls.filter((c) => c.url.pathname.endsWith('/snapshot'))).toHaveLength(2);
		const params = FakeSocket.last().url.searchParams;
		expect([params.get('epoch'), params.get('since')]).toEqual(['e2', '0']);
		// The old socket's late close does not trigger a reconnect.
		first.drop();
		expect(FakeSocket.all).toHaveLength(2);
	});

	it('stops streaming when closed', async () => {
		vi.useFakeTimers();
		const { backend, statuses, updates } = setup();
		await backend.snapshot();
		backend.connect();
		await vi.advanceTimersByTimeAsync(0);
		const socket = FakeSocket.last();
		socket.open();
		backend.close();
		expect(socket.closedByClient).toBe(true);
		socket.send({ type: 'update', version: 4, update: update({}) });
		socket.drop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(updates).toEqual([]);
		expect(FakeSocket.all).toHaveLength(1);
		expect(statuses.at(-1)).toBe('closed');
	});
});

describe('RemoteBackend config folder', () => {
	it('reads, writes and lists .obsidian through the config endpoints', async () => {
		const { fetch, calls } = mockFetch({
			'GET /api/vaults/notes/config/stat': [json(null), json({ path: '.obsidian/themes', kind: 'folder', ctime: 1, mtime: 2, size: 0 })],
			'GET /api/vaults/notes/files': [new Response('{"theme":"obsidian"}'), json({ error: 'not found' }, 404)],
			'PUT /api/vaults/notes/config/file': new Response(null, { status: 204 }),
			'GET /api/vaults/notes/config/list': json({ files: ['.obsidian/app.json'], folders: ['.obsidian/themes'] }),
			'POST /api/vaults/notes/config/folders': new Response(null, { status: 204 }),
		});
		const backend = new RemoteBackend({ serverUrl: SERVER, vaultId: 'notes', token: 't', fetch });
		expect(await backend.supportsConfig()).toBe(true);
		expect(await backend.readConfig('.obsidian/appearance.json')).toBe('{"theme":"obsidian"}');
		expect(await backend.readConfig('.obsidian/missing.json')).toBeNull();
		await backend.writeConfig('.obsidian/appearance.json', '{}');
		expect(await backend.listConfig('.obsidian')).toEqual({ files: ['.obsidian/app.json'], folders: ['.obsidian/themes'] });
		expect((await backend.statConfig('.obsidian/themes'))?.kind).toBe('folder');
		await backend.mkdirConfig('.obsidian/snippets');
		const put = calls.find((c) => c.method === 'PUT')!;
		expect(put.url.searchParams.get('path')).toBe('.obsidian/appearance.json');
		expect(put.body).toBe('{}');
		expect(JSON.parse(calls.find((c) => c.method === 'POST')!.body!)).toEqual({ path: '.obsidian/snippets' });
	});

	it('tells when the server has no config endpoints', async () => {
		const { fetch } = mockFetch({ 'GET /api/vaults/notes/config/stat': json({ error: 'not found' }, 404) });
		const backend = new RemoteBackend({ serverUrl: SERVER, vaultId: 'notes', token: 't', fetch });
		expect(await backend.supportsConfig()).toBe(false);
	});
});
