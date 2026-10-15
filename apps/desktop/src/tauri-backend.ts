import type { VaultBackend, VaultUpdate } from '@emeraldmd/core';
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
}
