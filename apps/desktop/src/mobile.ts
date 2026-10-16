/**
 * Phone and tablet shell: the body classes themes and plugins check
 * (`is-mobile`, `is-phone`, `is-tablet`, `is-android`, `is-ios`), the file
 * drawer on phones, and vaults kept in the app's own storage (the system
 * folder picker returns content URIs there, not paths).
 */

import { Platform, setIcon } from '@emeraldmd/api';
import { invoke } from '@tauri-apps/api/core';

interface AppVaults {
	dir: string;
	vaults: string[];
}

export interface MobileHost {
	open(path: string): Promise<void>;
	notice(message: string): void;
}

const DRAWER_OPEN = 'is-left-drawer-open';

export function setupMobile(host: MobileHost): void {
	if (!Platform.isMobile) return;
	const body = document.body;
	body.classList.add('is-mobile', Platform.isTablet ? 'is-tablet' : 'is-phone');
	if (Platform.isAndroidApp) body.classList.add('is-android');
	if (Platform.isIosApp) body.classList.add('is-ios');

	// Bottom bar button for the file drawer; tapping a file or outside closes it.
	const toggle = document.createElement('button');
	toggle.className = 'clickable-icon mobile-drawer-toggle';
	toggle.setAttribute('aria-label', 'Files');
	setIcon(toggle, 'folder-closed');
	toggle.addEventListener('click', () => body.classList.toggle(DRAWER_OPEN));
	document.getElementById('status-bar')?.prepend(toggle);
	document.getElementById('file-tree')?.addEventListener('click', (e) => {
		if ((e.target as Element).closest('.nav-file-title')) body.classList.remove(DRAWER_OPEN);
	});
	document.getElementById('workspace')?.addEventListener('click', (e) => {
		if (body.classList.contains(DRAWER_OPEN) && !(e.target as Element).closest('.mod-left-split, .mobile-drawer-toggle')) {
			body.classList.remove(DRAWER_OPEN);
		}
	});

	void renderVaultList(host);
}

/** The start screen on mobile: vaults in app storage and a field to create one. */
async function renderVaultList(host: MobileHost): Promise<void> {
	const card = document.querySelector('#empty-state .empty-card');
	const openButton = document.getElementById('open-vault');
	if (!card || !openButton) return;
	openButton.hidden = true;
	const section = document.createElement('div');
	section.className = 'mobile-vaults';
	openButton.after(section);

	let list: AppVaults;
	try {
		list = await invoke<AppVaults>('app_vaults');
	} catch (err) {
		host.notice(`Could not list vaults: ${err}`);
		return;
	}
	for (const name of list.vaults) {
		const row = document.createElement('button');
		row.className = 'mobile-vault-row';
		row.textContent = name;
		row.addEventListener('click', () => void host.open(`${list.dir}/${name}`).catch((err) => host.notice(`Could not open ${name}: ${err}`)));
		section.append(row);
	}

	const form = document.createElement('form');
	form.className = 'mobile-vault-create';
	const input = document.createElement('input');
	input.placeholder = list.vaults.length ? 'New vault name' : 'Name your first vault';
	input.setAttribute('aria-label', 'Vault name');
	const create = document.createElement('button');
	create.className = 'mod-cta';
	create.type = 'submit';
	create.textContent = 'Create vault';
	form.append(input, create);
	form.addEventListener('submit', (e) => {
		e.preventDefault();
		const name = input.value.trim();
		if (!name) return;
		void invoke<string>('create_app_vault', { name })
			.then((path) => host.open(path))
			.catch((err) => host.notice(`${err}`));
	});
	section.append(form);
}
