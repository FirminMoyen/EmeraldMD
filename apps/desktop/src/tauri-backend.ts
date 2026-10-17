import { arrayBufferToBase64, base64ToArrayBuffer, type ConfigStore, type ListedFiles, type RequestBackend, type Stat } from '@emeraldmd/api';
import type { FileEntry, SearchOptions, SearchResults, VaultBackend, VaultUpdate } from '@emeraldmd/core';
import type { TrustStore } from '@emeraldmd/plugin-host';
import { invoke } from '@tauri-apps/api/core';

/** Runs vault operations in the local Rust core (src-tauri/src/lib.rs). */
export class TauriBackend implements VaultBackend {
	read(path: string): Promise<string> {
		return invoke('read_file', { path });
	}

	write(path: string, data: string): Promise<VaultUpdate> {
		return invoke('write_file', { path, data });
	}

	create(path: string, data: string): Promise<VaultUpdate> {
		return invoke('create_file', { path, data });
	}

	createFolder(path: string): Promise<VaultUpdate> {
		return invoke('create_folder', { path });
	}

	rename(from: string, to: string): Promise<VaultUpdate> {
		return invoke('rename_path', { from, to });
	}

	trash(path: string): Promise<VaultUpdate> {
		return invoke('trash_path', { path });
	}

	readBinary(path: string): Promise<ArrayBuffer> {
		return invoke('read_binary', { path });
	}

	/** Bytes travel as the raw request body; the path goes in a header. */
	writeBinary(path: string, data: ArrayBuffer): Promise<VaultUpdate> {
		return invoke('write_binary', new Uint8Array(data), { headers: { path: encodeURIComponent(path) } });
	}

	search(query: string, options?: SearchOptions): Promise<SearchResults> {
		return invoke('search_vault', { query, options });
	}
}

/** Files in the vault's `.obsidian` folder, through the path-checked config commands. */
export class TauriConfigStore implements ConfigStore {
	read(path: string): Promise<string | null> {
		return invoke('config_read', { path });
	}

	write(path: string, data: string): Promise<void> {
		return invoke('config_write', { path, data });
	}

	list(path: string): Promise<ListedFiles> {
		return invoke('config_list', { path });
	}

	async stat(path: string): Promise<Stat | null> {
		const entry = await invoke<FileEntry | null>('config_stat', { path });
		return entry && { type: entry.kind, ctime: entry.ctime, mtime: entry.mtime, size: entry.size };
	}

	mkdir(path: string): Promise<void> {
		return invoke('config_mkdir', { path });
	}
}

/** Whether community plugins may run in the open vault; stored in the app's settings. */
export const tauriTrustStore: TrustStore = {
	isTrusted: () => invoke('community_plugins_trusted'),
	setTrusted: (trusted) => invoke('set_community_plugins_trusted', { trusted }),
};

interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	body: string;
}

/** `requestUrl` through Rust, so plugins are not limited by the webview's CORS rules. */
export const tauriRequestBackend: RequestBackend = async (req) => {
	const body = req.body === undefined ? undefined : typeof req.body === 'string' ? arrayBufferToBase64(new TextEncoder().encode(req.body).buffer as ArrayBuffer) : arrayBufferToBase64(req.body);
	const res = await invoke<HttpResponse>('request_url', {
		request: { url: req.url, method: req.method, headers: req.headers ?? {}, contentType: req.contentType, body },
	});
	return { status: res.status, headers: res.headers, body: base64ToArrayBuffer(res.body) };
};
