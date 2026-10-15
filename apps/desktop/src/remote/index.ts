/**
 * Vaults on an EmeraldMD server, in the desktop UI: "Connect to server" on the
 * start screen and next to the vault switcher, the recent servers, and the
 * connection status next to the vault name. `main.ts` hands vaults to the
 * workspace through `RemoteHost` and tells this module when a vault opens.
 */

import { RemoteBackend, RemoteError, type RemoteStatus, type VaultBackend, type VaultSnapshot, type VaultUpdate } from '@emeraldmd/core';
import { ConnectModal, describeError, hostOf } from './connect-modal';
import {
	forgetRemoteVault,
	loadRemoteVaults,
	rememberRemoteVault,
	sameVault,
	savedToken,
	setReopenRemoteVault,
	type RemoteVault,
} from './store';

export interface RemoteHost {
	/** Shows a vault in place of the open one; `keepActiveFile` reopens the same note if it still exists. */
	attach(backend: VaultBackend, snapshot: VaultSnapshot, options?: { keepActiveFile?: boolean }): Promise<void>;
	/** Applies a change pushed by the server to the open vault. */
	applyUpdate(update: VaultUpdate): void;
	showEmptyState(): void;
	notice(message: string): void;
}

const STATUS_TEXT: Record<RemoteStatus, string> = {
	connecting: 'Connecting',
	connected: 'Connected, changes appear live',
	reconnecting: 'Connection lost, reconnecting',
	unauthorized: 'Token rejected',
	closed: 'Disconnected',
};

const SERVER_ICON =
	'<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></svg>';

function required(id: string): HTMLElement {
	const el = document.getElementById(id);
	if (!el) throw new Error(`#${id} is missing from index.html`);
	return el;
}

export class RemoteVaults {
	private readonly host: RemoteHost;
	private active: { backend: RemoteBackend; vault: RemoteVault } | null = null;
	private recent: RemoteVault[] = [];
	private modal: ConnectModal | null = null;
	private readonly recentList = document.createElement('div');
	private readonly badge = document.createElement('span');

	constructor(host: RemoteHost) {
		this.host = host;
		const style = document.createElement('link');
		style.rel = 'stylesheet';
		style.href = 'remote.css';
		document.head.append(style);

		const connect = document.createElement('button');
		connect.id = 'connect-server';
		connect.className = 'mod-cta mod-secondary';
		connect.textContent = 'Connect to server';
		connect.addEventListener('click', () => this.showDialog());
		this.recentList.className = 'emerald-remote-recent';
		this.recentList.hidden = true;
		required('open-vault').after(connect, this.recentList);

		const navButton = document.createElement('button');
		navButton.id = 'connect-server-nav';
		navButton.className = 'clickable-icon';
		navButton.title = 'Connect to server';
		navButton.setAttribute('aria-label', 'Connect to server');
		navButton.innerHTML = SERVER_ICON;
		navButton.addEventListener('click', () => this.showDialog());
		required('switch-vault').after(navButton);

		this.badge.className = 'emerald-remote-status';
		this.badge.hidden = true;
		required('vault-name').after(this.badge);

		void this.refresh();
	}

	/** On start: reopens the last vault if it was a remote one. True if it handled startup. */
	async reopenLast(): Promise<boolean> {
		const list = await loadRemoteVaults().catch(() => null);
		const last = list?.reopenLast ? list.recent[0] : undefined;
		if (!last) return false;
		if (!(await this.openRecent(last))) this.host.showEmptyState();
		return true;
	}

	/** Called by the app whenever a vault is shown. Closes the remote connection if it is another vault. */
	vaultOpened(backend: VaultBackend): void {
		if (this.active?.backend === backend) return;
		this.active?.backend.close();
		this.active = null;
		this.badge.hidden = true;
		void setReopenRemoteVault(false).catch(() => {});
	}

	showDialog(options: { serverUrl?: string; message?: string } = {}): void {
		this.modal?.close();
		this.modal = new ConnectModal({
			...options,
			recent: this.recent.filter((v) => !this.active || !sameVault(v, this.active.vault)),
			open: (vault, token, remember) => this.connect(vault, token, remember),
			openRecent: (vault) => void this.openRecent(vault),
		});
		this.modal.show();
	}

	private async connect(vault: RemoteVault, token: string, remember: boolean): Promise<void> {
		const opened = await this.open(vault, token);
		if (remember) {
			await rememberRemoteVault(opened, token).catch((err) => this.host.notice(`Connected, but the token could not be saved: ${err}`));
		} else {
			await setReopenRemoteVault(false).catch(() => {});
		}
		await this.refresh();
	}

	/** Opens a remembered vault with the token from the keychain. False if it could not. */
	private async openRecent(vault: RemoteVault): Promise<boolean> {
		let token: string | null;
		try {
			token = await savedToken(vault.serverUrl);
		} catch (err) {
			this.host.notice(`Could not read the token from the keychain: ${err}`);
			token = null;
		}
		if (!token) {
			this.showDialog({ serverUrl: vault.serverUrl, message: `Enter the access token for ${hostOf(vault.serverUrl)}.` });
			return false;
		}
		try {
			const opened = await this.open(vault, token);
			await rememberRemoteVault(opened).catch(() => {});
			await this.refresh();
			return true;
		} catch (err) {
			if (err instanceof RemoteError && err.status === 401) {
				this.showDialog({ serverUrl: vault.serverUrl, message: 'The saved token was not accepted. Enter a new one.' });
			} else {
				this.host.notice(`Could not open ${vault.name}: ${describeError(err, vault.serverUrl)}`);
			}
			return false;
		}
	}

	/** Loads the snapshot, shows the vault, then starts the live event stream. */
	private async open(vault: RemoteVault, token: string): Promise<RemoteVault> {
		const backend: RemoteBackend = new RemoteBackend({
			serverUrl: vault.serverUrl,
			vaultId: vault.vaultId,
			token,
			onUpdate: (update) => {
				if (this.active?.backend === backend) this.host.applyUpdate(update);
			},
			onResync: async (snapshot) => {
				if (this.active?.backend === backend) await this.host.attach(backend, snapshot, { keepActiveFile: true });
			},
			onStatus: (status) => this.statusChanged(backend, status),
		});
		const snapshot = await backend.snapshot();
		const opened = { ...vault, name: snapshot.name };
		const previous = this.active;
		this.active = { backend, vault: opened };
		previous?.backend.close();
		await this.host.attach(backend, snapshot);
		backend.connect();
		return opened;
	}

	private statusChanged(backend: RemoteBackend, status: RemoteStatus): void {
		if (this.active?.backend !== backend) return;
		const { vault } = this.active;
		const label = `${STATUS_TEXT[status]}: ${vault.name} on ${hostOf(vault.serverUrl)}`;
		this.badge.hidden = false;
		this.badge.dataset.status = status;
		this.badge.title = label;
		this.badge.setAttribute('aria-label', label);
		if (status === 'unauthorized') {
			this.showDialog({ serverUrl: vault.serverUrl, message: 'The server no longer accepts this token. Enter a new one.' });
		}
	}

	private async refresh(): Promise<void> {
		const list = await loadRemoteVaults().catch(() => null);
		this.recent = list?.recent ?? [];
		this.renderRecent();
	}

	/** The recent servers on the start screen. */
	private renderRecent(): void {
		this.recentList.replaceChildren();
		this.recentList.hidden = this.recent.length === 0;
		if (this.recent.length === 0) return;
		const heading = document.createElement('div');
		heading.className = 'emerald-connect-heading';
		heading.textContent = 'Recent servers';
		this.recentList.append(heading);
		for (const vault of this.recent) {
			const row = document.createElement('div');
			row.className = 'emerald-remote-row';
			const open = document.createElement('button');
			open.className = 'emerald-remote-item';
			const name = document.createElement('span');
			name.className = 'emerald-remote-name';
			name.textContent = vault.name;
			const host = document.createElement('span');
			host.className = 'emerald-remote-host';
			host.textContent = hostOf(vault.serverUrl);
			open.append(name, host);
			open.addEventListener('click', () => void this.openRecent(vault));
			const forget = document.createElement('button');
			forget.className = 'clickable-icon emerald-remote-forget';
			forget.textContent = '×';
			forget.title = 'Forget this vault and its token';
			forget.setAttribute('aria-label', `Forget ${vault.name}`);
			forget.addEventListener('click', () => {
				void forgetRemoteVault(vault)
					.catch((err) => this.host.notice(`Could not forget ${vault.name}: ${err}`))
					.then(() => this.refresh());
			});
			row.append(open, forget);
			this.recentList.append(row);
		}
	}
}
