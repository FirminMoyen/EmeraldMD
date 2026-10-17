import { normalizeServerUrl, RemoteBackend, RemoteError, type RemoteVaultInfo } from '@emeraldmd/core';
import type { RemoteVault } from './store';

export interface ConnectModalOptions {
	serverUrl?: string;
	/** Shown above the form, e.g. why the saved token did not work. */
	message?: string;
	recent: RemoteVault[];
	/** Opens the chosen vault; a thrown error is shown in the dialog. */
	open(vault: RemoteVault, token: string, remember: boolean): Promise<void>;
	/** Sets up a synced local copy of the chosen vault instead of working online. */
	openSynced(vault: RemoteVault, token: string): Promise<void>;
	openRecent(vault: RemoteVault): void;
}

/** Turns a failed request into a sentence for the user. */
export function describeError(err: unknown, serverUrl: string): string {
	if (err instanceof RemoteError) {
		if (err.status === 401) return 'The server did not accept this token.';
		return `The server answered: ${err.message}`;
	}
	if (err instanceof TypeError) {
		return `Could not reach ${serverUrl}. Check the address and that the server is running; servers other than localhost need https://.`;
	}
	return String(err);
}

export function hostOf(serverUrl: string): string {
	try {
		const url = new URL(serverUrl);
		return url.host + url.pathname.replace(/\/$/, '');
	} catch {
		return serverUrl;
	}
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text) node.textContent = text;
	return node;
}

/**
 * "Connect to server": server URL and token, then a choice of vault if the
 * token can open several. Uses the plugin API's modal class names so themes
 * style it like other dialogs.
 */
export class ConnectModal {
	private readonly options: ConnectModalOptions;
	private readonly container = el('div', 'modal-container mod-dim emerald-connect-modal');
	private readonly form = el('form', 'emerald-connect-form');
	private readonly urlInput = el('input');
	private readonly tokenInput = el('input');
	private readonly remember = el('input');
	private readonly synced = el('input');
	private readonly error = el('div', 'emerald-connect-error');
	private readonly choice = el('div', 'emerald-connect-choice');
	private readonly submit = el('button', 'mod-cta', 'Connect');
	private readonly onKeydown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') this.close();
	};

	constructor(options: ConnectModalOptions) {
		this.options = options;
		const modal = el('div', 'modal');
		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');
		modal.setAttribute('aria-label', 'Connect to server');
		const close = el('button', 'modal-close-button', '×');
		close.type = 'button';
		close.setAttribute('aria-label', 'Close');
		close.addEventListener('click', () => this.close());
		const backdrop = el('div', 'modal-bg');
		backdrop.addEventListener('click', () => this.close());

		const content = el('div', 'modal-content');
		content.append(
			el('p', 'emerald-connect-intro', 'Open a vault hosted by emeraldmd-server. Edits are saved to the server, and changes from other devices appear live.'),
		);
		if (options.recent.length > 0) content.append(this.renderRecent());

		this.urlInput.type = 'text';
		this.urlInput.placeholder = 'https://notes.example.com';
		this.urlInput.value = options.serverUrl ?? '';
		this.urlInput.inputMode = 'url';
		this.urlInput.spellcheck = false;
		this.tokenInput.type = 'password';
		this.tokenInput.placeholder = 'emd_…';
		this.tokenInput.autocomplete = 'off';
		this.remember.type = 'checkbox';
		this.remember.checked = true;
		this.synced.type = 'checkbox';
		this.synced.checked = false;
		this.error.setAttribute('role', 'alert');
		this.error.hidden = !options.message;
		this.error.textContent = options.message ?? '';
		this.choice.hidden = true;
		this.submit.type = 'submit';
		const cancel = el('button', '', 'Cancel');
		cancel.type = 'button';
		cancel.addEventListener('click', () => this.close());
		const buttons = el('div', 'modal-button-container');
		buttons.append(this.submit, cancel);

		this.form.append(
			this.field('Server URL', this.urlInput),
			this.field('Access token', this.tokenInput),
			this.checkbox('Remember this server; the token is kept in the system keychain', this.remember),
			this.checkbox('Keep a synced copy on this Mac, to work offline', this.synced),
			this.error,
			this.choice,
			buttons,
		);
		this.form.addEventListener('submit', (e) => {
			e.preventDefault();
			void this.connect();
		});
		content.append(this.form);
		modal.append(close, el('div', 'modal-title', 'Connect to server'), content);
		this.container.append(backdrop, modal);
	}

	show(): void {
		document.body.append(this.container);
		document.addEventListener('keydown', this.onKeydown);
		(this.urlInput.value ? this.tokenInput : this.urlInput).focus();
	}

	close(): void {
		document.removeEventListener('keydown', this.onKeydown);
		this.container.remove();
	}

	private field(label: string, input: HTMLInputElement): HTMLElement {
		const row = el('label', 'emerald-connect-field');
		row.append(el('span', '', label), input);
		return row;
	}

	private checkbox(label: string, input: HTMLInputElement): HTMLElement {
		const row = el('label', 'emerald-connect-remember');
		row.append(input, el('span', '', label));
		return row;
	}

	private renderRecent(): HTMLElement {
		const section = el('div', 'emerald-connect-recent');
		section.append(el('div', 'emerald-connect-heading', 'Recent'));
		for (const vault of this.options.recent) {
			const row = el('button', 'emerald-remote-item');
			row.type = 'button';
			row.append(el('span', 'emerald-remote-name', vault.name), el('span', 'emerald-remote-host', hostOf(vault.serverUrl)));
			row.addEventListener('click', () => {
				this.close();
				this.options.openRecent(vault);
			});
			section.append(row);
		}
		return section;
	}

	private showError(message: string): void {
		this.error.textContent = message;
		this.error.hidden = false;
	}

	private setBusy(busy: boolean): void {
		this.submit.disabled = busy;
		this.submit.textContent = busy ? 'Connecting…' : 'Connect';
		this.form.classList.toggle('is-busy', busy);
	}

	private async connect(): Promise<void> {
		this.error.hidden = true;
		this.choice.hidden = true;
		let serverUrl: string;
		try {
			serverUrl = normalizeServerUrl(this.urlInput.value);
		} catch {
			this.showError('Enter the server address, for example https://notes.example.com');
			this.urlInput.focus();
			return;
		}
		const token = this.tokenInput.value.trim();
		if (!token) {
			this.showError('Enter an access token. Create one on the server with `emeraldmd-server token new`.');
			this.tokenInput.focus();
			return;
		}
		this.urlInput.value = serverUrl;
		this.setBusy(true);
		let vaults: RemoteVaultInfo[];
		try {
			vaults = await RemoteBackend.listVaults(serverUrl, token);
		} catch (err) {
			this.setBusy(false);
			this.showError(describeError(err, serverUrl));
			return;
		}
		if (vaults.length === 0) {
			this.setBusy(false);
			this.showError('This token cannot open any vault on this server.');
		} else if (vaults.length === 1) {
			await this.openVault(serverUrl, vaults[0]!, token);
		} else {
			this.setBusy(false);
			this.renderChoice(serverUrl, vaults, token);
		}
	}

	private renderChoice(serverUrl: string, vaults: RemoteVaultInfo[], token: string): void {
		this.choice.replaceChildren(el('div', 'emerald-connect-heading', 'Choose a vault'));
		for (const info of vaults) {
			const row = el('button', 'emerald-remote-item');
			row.type = 'button';
			row.append(el('span', 'emerald-remote-name', info.name), el('span', 'emerald-remote-host', info.id));
			row.addEventListener('click', () => void this.openVault(serverUrl, info, token));
			this.choice.append(row);
		}
		this.choice.hidden = false;
		this.choice.querySelector('button')?.focus();
	}

	private async openVault(serverUrl: string, info: RemoteVaultInfo, token: string): Promise<void> {
		this.setBusy(true);
		try {
			const vault = { serverUrl, vaultId: info.id, name: info.name };
			if (this.synced.checked) await this.options.openSynced(vault, token);
			else await this.options.open(vault, token, this.remember.checked);
			this.close();
		} catch (err) {
			this.setBusy(false);
			this.showError(describeError(err, serverUrl));
		}
	}
}
