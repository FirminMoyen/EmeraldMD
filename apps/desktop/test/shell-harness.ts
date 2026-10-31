/**
 * Boots the real desktop UI (src/main.ts and static/index.html) in happy-dom,
 * with Tauri's IPC mocked: the Rust commands are served from in-memory
 * storage. Used by the shell tests here and by compat/desktop.test.ts.
 */

import { readFileSync } from 'node:fs';
import { mockConvertFileSrc, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import type { App } from '@emeraldmd/api';
import { MemoryBackend, MemoryConfigStore } from '@emeraldmd/api/testing';
import type { VaultSnapshot } from '@emeraldmd/core';
import { vi } from 'vitest';

export interface Shell {
	app: App;
	backend: MemoryBackend;
	config: MemoryConfigStore;
	/** Whether the user turned community plugins on (the app setting stored by Rust). */
	trust: { trusted: boolean };
	/** Presses a key on the focused element, or on the window. */
	press(key: string, mods?: { mod?: boolean; shift?: boolean }): void;
	/** Types into the focused input and fires `input`. */
	typeInto(input: HTMLInputElement, text: string): void;
	editorText(): string;
}

const VAULT = '/vault';

/** Answers for other Rust commands (`open_vault_sync`…), by command name. */
export type ExtraCommands = Record<string, (args: Record<string, unknown>) => unknown>;

export async function startShell(files: Record<string, string>, config: Record<string, string>, trusted = false, extra: ExtraCommands = {}): Promise<Shell> {
	const html = readFileSync('apps/desktop/static/index.html', 'utf8');
	document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, '');
	const backend = new MemoryBackend(files);
	const store = new MemoryConfigStore(config);
	const trust = { trusted };

	mockWindows('main');
	mockConvertFileSrc('macos');
	mockIPC(
		async (cmd, args) => {
			const a = (args ?? {}) as Record<string, string & boolean>;
			if (extra[cmd]) return extra[cmd](a);
			switch (cmd) {
				case 'last_vault':
					return VAULT;
				case 'open_vault': {
					const snapshot: VaultSnapshot = { name: 'vault', basePath: VAULT, files: backend.entries(), metadata: {}, links: {} };
					return snapshot;
				}
				case 'read_file':
					return backend.read(a.path);
				case 'write_file':
					return backend.write(a.path, a.data);
				case 'create_file':
					return backend.create(a.path, a.data);
				case 'create_folder':
					return backend.createFolder(a.path);
				case 'rename_path':
					return backend.rename(a.from, a.to);
				case 'trash_path':
					return backend.trash(a.path);
				case 'config_read':
					return store.read(a.path);
				case 'config_write':
					return store.write(a.path, a.data);
				case 'config_list':
					return store.list(a.path);
				case 'config_trash':
					return store.trash(a.path);
				case 'config_mkdir':
					return store.mkdir(a.path);
				case 'config_stat': {
					const stat = await store.stat(a.path);
					return stat && { path: a.path, kind: stat.type, ctime: stat.ctime, mtime: stat.mtime, size: stat.size };
				}
				case 'community_plugins_trusted':
					return trust.trusted;
				case 'set_community_plugins_trusted':
					trust.trusted = a.trusted;
					return null;
				case 'request_url':
					return { status: 503, headers: {}, body: '' };
				case 'plugin:dialog|ask':
					return true;
				// The dialog plugin's ask() and confirm() are message boxes; answer yes.
				case 'plugin:dialog|message':
					return 'Yes';
				default:
					// Window title and other window-plugin calls.
					return null;
			}
		},
		{ shouldMockEvents: true },
	);

	await import('../src/main');
	const app = await vi.waitFor(
		() => {
			const app = (globalThis as { app?: App }).app;
			if (!app?.workspace.layoutReady) throw new Error('the app has not finished opening the vault');
			return app;
		},
		{ timeout: 5000 },
	);

	return {
		app,
		backend,
		config: store,
		trust,
		press(key, mods = {}) {
			const isMac = /Mac/.test(navigator.platform);
			const target = document.activeElement ?? document.body;
			const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key;
			target.dispatchEvent(
				new KeyboardEvent('keydown', {
					key,
					code,
					bubbles: true,
					cancelable: true,
					metaKey: Boolean(mods.mod) && isMac,
					ctrlKey: Boolean(mods.mod) && !isMac,
					shiftKey: Boolean(mods.shift),
				}),
			);
		},
		typeInto(input, text) {
			input.value = text;
			input.dispatchEvent(new Event('input', { bubbles: true }));
		},
		editorText() {
			return app.workspace.activeEditor?.editor?.getValue() ?? '';
		},
	};
}
