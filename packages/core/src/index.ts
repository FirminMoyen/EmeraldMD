export { Events, type EventRef } from './events';
export { LinkResolver } from './link-resolver';
export { getLinkpath, parseLinktext } from './linktext';
export { MetadataCache } from './metadata-cache';
export { fileName, joinPath, normalizePath, parentPath, resolveRelative, splitExtension } from './path';
export {
	RemoteBackend,
	RemoteError,
	normalizeServerUrl,
	type RemoteBackendOptions,
	type RemoteStatus,
	type RemoteVaultInfo,
	type WebSocketLike,
} from './remote-backend';
export * from './types';
export type * from './search';
export { TAbstractFile, TFile, TFolder, Vault, type FileStats } from './vault';

import { MetadataCache } from './metadata-cache';
import type { VaultBackend, VaultSnapshot } from './types';
import { Vault } from './vault';

/** Builds the vault and metadata mirrors from a backend's snapshot. */
export function openVault(backend: VaultBackend, snapshot: VaultSnapshot): { vault: Vault; metadataCache: MetadataCache } {
	const vault = new Vault(backend, snapshot.name, snapshot.files);
	const metadataCache = new MetadataCache(vault, snapshot);
	return { vault, metadataCache };
}
