/**
 * Vault backend for a vault served by `emeraldmd-server`
 * (crates/emerald-server, API in docs/self-hosting.md). Operations are HTTP
 * requests that answer with the same `VaultUpdate`s as the local core.
 *
 * Changes made by other clients, or on the server's disk, arrive over a
 * WebSocket and are passed to `onUpdate`, to be applied with
 * `vault.applyUpdate`. The stream resumes from the last update it saw after a
 * dropped connection, retrying with exponential backoff. When the server can
 * no longer replay what was missed (it restarted, or the client was away too
 * long), the backend loads a fresh snapshot and hands it to `onResync`, and
 * the caller rebuilds its mirror from it.
 */

import type { SearchOptions, SearchResults } from './search';
import type { FileEntry, VaultBackend, VaultSnapshot, VaultUpdate } from './types';

export interface RemoteVaultInfo {
	id: string;
	name: string;
}

export type RemoteStatus = 'connecting' | 'connected' | 'reconnecting' | 'unauthorized' | 'closed';

/** The part of the browser `WebSocket` API this backend uses. */
export interface WebSocketLike {
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent) => void) | null;
	onclose: ((event: CloseEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
	close(code?: number, reason?: string): void;
}

export interface RemoteBackendOptions {
	/** Server base URL, e.g. `https://notes.example.com` (see `normalizeServerUrl`). */
	serverUrl: string;
	vaultId: string;
	token: string;
	/** A change made elsewhere. Apply it with `vault.applyUpdate`. */
	onUpdate?: (update: VaultUpdate) => void;
	/** Missed changes could not be replayed: rebuild the mirror from this snapshot. */
	onResync?: (snapshot: VaultSnapshot) => void | Promise<void>;
	onStatus?: (status: RemoteStatus) => void;
	fetch?: typeof fetch;
	webSocket?: (url: string) => WebSocketLike;
	/** First reconnect delay; doubles on each failure up to `maxReconnectDelayMs`. */
	minReconnectDelayMs?: number;
	maxReconnectDelayMs?: number;
	/** For jitter; tests pin it. */
	random?: () => number;
}

/** An error response from the server. */
export class RemoteError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = 'RemoteError';
		this.status = status;
	}
}

/**
 * `notes.example.com` → `https://notes.example.com`, `localhost:8484` →
 * `http://localhost:8484`; drops trailing slashes, query and fragment. Keeps a
 * path, for servers behind a reverse proxy under a prefix.
 */
export function normalizeServerUrl(input: string): string {
	let url = input.trim();
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
		const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(url);
		url = (local ? 'http://' : 'https://') + url;
	}
	const parsed = new URL(url);
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('The server URL must start with https:// or http://');
	}
	return (parsed.origin + parsed.pathname).replace(/\/+$/, '');
}

interface StreamPosition {
	epoch: string;
	version: number;
}

type StreamMessage = { type: 'update'; version: number; update: VaultUpdate } | { type: 'resync' };

const CLIENT_HEADER = 'X-EmeraldMD-Client';

async function errorFrom(response: Response): Promise<RemoteError> {
	let message = `${response.status} ${response.statusText}`.trim();
	try {
		const body = (await response.json()) as { error?: unknown };
		if (typeof body.error === 'string') message = body.error;
	} catch {
		// Not JSON (e.g. a proxy's error page): keep the status line.
	}
	return new RemoteError(message, response.status);
}

/** A version of a file kept by the server's version history. */
export interface ServerVersion {
	/** Milliseconds since the epoch. */
	time: number;
	size: number;
}

export interface DeletedServerFile {
	path: string;
	deletedAt: number;
	/** The size of its last version. */
	size: number;
}

function randomId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	return globalThis.fetch(input, init);
}

export class RemoteBackend implements VaultBackend {
	readonly serverUrl: string;
	readonly vaultId: string;
	/** Sent with every request, so the server does not echo our own changes back. */
	readonly clientId = randomId();

	private readonly token: string;
	private readonly options: RemoteBackendOptions;
	private readonly fetchImpl: typeof fetch;
	private position: StreamPosition | null = null;
	private socket: WebSocketLike | null = null;
	private wanted = false;
	private needsSnapshot = false;
	/** Bumped to abandon an in-flight connection attempt. */
	private generation = 0;
	private retries = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private currentStatus: RemoteStatus = 'closed';

	constructor(options: RemoteBackendOptions) {
		this.options = options;
		this.serverUrl = normalizeServerUrl(options.serverUrl);
		this.vaultId = options.vaultId;
		this.token = options.token;
		this.fetchImpl = options.fetch ?? defaultFetch;
	}

	/** The vaults this token can open. Throws `RemoteError` (401) for a bad token. */
	static async listVaults(serverUrl: string, token: string, fetchImpl: typeof fetch = defaultFetch): Promise<RemoteVaultInfo[]> {
		const response = await fetchImpl(`${normalizeServerUrl(serverUrl)}/api/vaults`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!response.ok) throw await errorFrom(response);
		return (await response.json()) as RemoteVaultInfo[];
	}

	get status(): RemoteStatus {
		return this.currentStatus;
	}

	/** Loads the vault's files and metadata; `connect()` streams changes from this point on. */
	async snapshot(): Promise<VaultSnapshot> {
		const response = await this.request('GET', '/snapshot');
		const { epoch, version, ...snapshot } = (await response.json()) as VaultSnapshot & StreamPosition;
		this.position = { epoch, version };
		return { ...snapshot, basePath: `${this.serverUrl}/api/vaults/${encodeURIComponent(this.vaultId)}` };
	}

	/** Starts the event stream. Call after `snapshot()`, once the mirror exists. */
	connect(): void {
		if (this.wanted) return;
		this.wanted = true;
		this.retries = 0;
		void this.openStream();
	}

	/** Stops the event stream for good. Requests still work. */
	close(): void {
		this.wanted = false;
		this.generation++;
		clearTimeout(this.timer);
		this.closeSocket();
		this.setStatus('closed');
	}

	async read(path: string): Promise<string> {
		return (await this.request('GET', '/files', { query: { path } })).text();
	}

	write(path: string, data: string): Promise<VaultUpdate> {
		return this.update('PUT', '/files', { query: { path }, text: data });
	}

	create(path: string, data: string): Promise<VaultUpdate> {
		return this.update('POST', '/files', { json: { path, data } });
	}

	createFolder(path: string): Promise<VaultUpdate> {
		return this.update('POST', '/folders', { json: { path } });
	}

	rename(from: string, to: string): Promise<VaultUpdate> {
		return this.update('POST', '/rename', { json: { from, to } });
	}

	trash(path: string): Promise<VaultUpdate> {
		return this.update('POST', '/trash', { json: { path } });
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		return (await this.request('GET', '/raw', { query: { path } })).arrayBuffer();
	}

	writeBinary(path: string, data: ArrayBuffer): Promise<VaultUpdate> {
		return this.update('PUT', '/raw', { query: { path }, bytes: data });
	}

	/** Whether the server keeps the vault's config folder (servers from before the config endpoints do not). */
	async supportsConfig(): Promise<boolean> {
		try {
			await this.request('GET', '/config/stat', { query: { path: '.obsidian' } });
			return true;
		} catch (err) {
			if (err instanceof RemoteError && err.status === 404) return false;
			throw err;
		}
	}

	/** A config file's text (`.obsidian/…`), or null when it does not exist. */
	async readConfig(path: string): Promise<string | null> {
		try {
			return await this.read(path);
		} catch (err) {
			if (err instanceof RemoteError && err.status === 404) return null;
			throw err;
		}
	}

	async writeConfig(path: string, data: string): Promise<void> {
		await this.request('PUT', '/config/file', { query: { path }, text: data });
	}

	async listConfig(path: string): Promise<{ files: string[]; folders: string[] }> {
		return (await (await this.request('GET', '/config/list', { query: { path } })).json()) as { files: string[]; folders: string[] };
	}

	async statConfig(path: string): Promise<FileEntry | null> {
		return (await (await this.request('GET', '/config/stat', { query: { path } })).json()) as FileEntry | null;
	}

	async mkdirConfig(path: string): Promise<void> {
		await this.request('POST', '/config/folders', { json: { path } });
	}

	/** Moves a plugin's or theme's folder to the vault's `.trash` (uninstalling). */
	async trashConfig(path: string): Promise<void> {
		await this.request('POST', '/config/trash', { json: { path } });
	}

	/** A file's versions on the server, newest first. `RemoteError` 404 when the server keeps no history. */
	async versions(path: string): Promise<ServerVersion[]> {
		const body = (await (await this.request('GET', '/history', { query: { path } })).json()) as { versions: ServerVersion[] };
		return body.versions;
	}

	/** The content of a file's version made at `time`. */
	async readVersion(path: string, time: number): Promise<ArrayBuffer> {
		return (await this.request('GET', '/history/raw', { query: { path, time: String(time) } })).arrayBuffer();
	}

	/** Deleted files the server still has versions of, most recently deleted first. */
	async deletedFiles(): Promise<DeletedServerFile[]> {
		return (await (await this.request('GET', '/history/deleted')).json()) as DeletedServerFile[];
	}

	async search(query: string, options: SearchOptions = {}): Promise<SearchResults> {
		const params: Record<string, string> = { q: query };
		if (options.caseSensitive) params.caseSensitive = 'true';
		if (options.sort) params.sort = options.sort;
		if (options.limit !== undefined) params.limit = String(options.limit);
		return (await (await this.request('GET', '/search', { query: params })).json()) as SearchResults;
	}

	private async update(method: string, path: string, body: RequestBody): Promise<VaultUpdate> {
		return (await (await this.request(method, path, body)).json()) as VaultUpdate;
	}

	private async request(method: string, path: string, body: RequestBody = {}): Promise<Response> {
		const url = new URL(`${this.serverUrl}/api/vaults/${encodeURIComponent(this.vaultId)}${path}`);
		for (const [key, value] of Object.entries(body.query ?? {})) url.searchParams.set(key, value);
		const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, [CLIENT_HEADER]: this.clientId };
		let payload: string | ArrayBuffer | undefined;
		if (body.json !== undefined) {
			headers['Content-Type'] = 'application/json';
			payload = JSON.stringify(body.json);
		} else if (body.text !== undefined) {
			headers['Content-Type'] = 'text/plain; charset=utf-8';
			payload = body.text;
		} else if (body.bytes !== undefined) {
			headers['Content-Type'] = 'application/octet-stream';
			payload = body.bytes;
		}
		const response = await this.fetchImpl(url, { method, headers, body: payload });
		if (!response.ok) throw await errorFrom(response);
		return response;
	}

	private setStatus(status: RemoteStatus): void {
		if (status === this.currentStatus) return;
		this.currentStatus = status;
		this.options.onStatus?.(status);
	}

	private async openStream(): Promise<void> {
		const generation = ++this.generation;
		const current = () => generation === this.generation && this.wanted;
		this.setStatus(this.retries === 0 ? 'connecting' : 'reconnecting');
		try {
			if (this.needsSnapshot) {
				const snapshot = await this.snapshot();
				if (!current()) return;
				this.needsSnapshot = false;
				await this.options.onResync?.(snapshot);
				if (!current()) return;
			}
			const response = await this.request('POST', '/events/ticket');
			const { ticket } = (await response.json()) as { ticket: string };
			if (!current()) return;
			this.openSocket(ticket);
		} catch (err) {
			if (!current()) return;
			if (err instanceof RemoteError && err.status === 401) {
				this.wanted = false;
				this.setStatus('unauthorized');
			} else {
				this.scheduleReconnect();
			}
		}
	}

	private openSocket(ticket: string): void {
		const query = new URLSearchParams({ ticket, client: this.clientId });
		if (this.position) {
			query.set('epoch', this.position.epoch);
			query.set('since', String(this.position.version));
		}
		const base = this.serverUrl.replace(/^http/, 'ws');
		const url = `${base}/api/vaults/${encodeURIComponent(this.vaultId)}/events?${query}`;
		const socket = (this.options.webSocket ?? ((u: string) => new WebSocket(u)))(url);
		this.socket = socket;
		socket.onopen = () => {
			if (this.socket !== socket) return;
			this.retries = 0;
			this.setStatus('connected');
		};
		socket.onmessage = (event) => {
			if (this.socket === socket) this.handleMessage(event.data);
		};
		// An error is always followed by close.
		socket.onerror = () => {};
		socket.onclose = () => {
			if (this.socket !== socket) return;
			this.socket = null;
			this.scheduleReconnect();
		};
	}

	private handleMessage(data: unknown): void {
		let message: StreamMessage;
		try {
			message = JSON.parse(String(data)) as StreamMessage;
		} catch {
			return;
		}
		if (message.type === 'update') {
			if (this.position) this.position.version = message.version;
			this.options.onUpdate?.(message.update);
		} else if (message.type === 'resync') {
			this.needsSnapshot = true;
			this.closeSocket();
			this.retries = 0;
			void this.openStream();
		}
	}

	private scheduleReconnect(): void {
		if (!this.wanted) return;
		const min = this.options.minReconnectDelayMs ?? 500;
		const max = this.options.maxReconnectDelayMs ?? 30_000;
		const base = Math.min(max, min * 2 ** this.retries);
		const random = this.options.random ?? Math.random;
		// "Equal jitter": between half and all of the base delay.
		const delay = base / 2 + (random() * base) / 2;
		this.retries++;
		this.setStatus('reconnecting');
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.openStream(), delay);
	}

	private closeSocket(): void {
		const socket = this.socket;
		this.socket = null;
		socket?.close(1000);
	}
}

interface RequestBody {
	query?: Record<string, string>;
	json?: unknown;
	text?: string;
	bytes?: ArrayBuffer;
}
