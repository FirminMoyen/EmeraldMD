import { invoke } from '@tauri-apps/api/core';

/** A vault on an EmeraldMD server (see src-tauri/src/remote.rs). */
export interface RemoteVault {
	serverUrl: string;
	vaultId: string;
	name: string;
}

export interface RemoteVaultList {
	/** Most recently opened first. */
	recent: RemoteVault[];
	/** The last vault opened was `recent[0]`. */
	reopenLast: boolean;
}

export function loadRemoteVaults(): Promise<RemoteVaultList> {
	return invoke('remote_vaults');
}

/** Lists the vault first and stores the token (if given) in the OS keychain. */
export function rememberRemoteVault(vault: RemoteVault, token?: string): Promise<void> {
	return invoke('remember_remote_vault', { vault, token: token ?? null });
}

export function forgetRemoteVault(vault: RemoteVault): Promise<void> {
	return invoke('forget_remote_vault', { serverUrl: vault.serverUrl, vaultId: vault.vaultId });
}

/** The token saved in the keychain for this server, if any. */
export function savedToken(serverUrl: string): Promise<string | null> {
	return invoke('remote_token', { serverUrl });
}

export function setReopenRemoteVault(reopen: boolean): Promise<void> {
	return invoke('set_reopen_remote_vault', { reopen });
}

export function sameVault(a: RemoteVault, b: RemoteVault): boolean {
	return a.serverUrl === b.serverUrl && a.vaultId === b.vaultId;
}
