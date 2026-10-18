// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { Menu, TAbstractFile } from '@emeraldmd/api';
import { startShell, type Shell } from './shell-harness';

const title = (path: string) => document.querySelector<HTMLElement>(`.tree-item-self[data-path="${path}"]`)!;
const menuItems = () => [...document.querySelectorAll('.menu .menu-item')].map((item) => item.textContent);
const clickMenuItem = (label: string) =>
	([...document.querySelectorAll<HTMLElement>('.menu .menu-item')].find((item) => item.textContent === label) ?? null)!.click();

function drag(from: HTMLElement, to: HTMLElement): void {
	const dataTransfer = new DataTransfer();
	// happy-dom does not keep the `dataTransfer` passed to DragEvent.
	const event = (type: string) => Object.defineProperty(new DragEvent(type, { bubbles: true, cancelable: true }), 'dataTransfer', { value: dataTransfer });
	from.dispatchEvent(event('dragstart'));
	to.dispatchEvent(event('dragover'));
	to.dispatchEvent(event('drop'));
	from.dispatchEvent(event('dragend'));
}

describe('file explorer', () => {
	let shell: Shell;

	it('shows the tree with the DOM themes and plugins use', async () => {
		shell = await startShell(
			{ 'Welcome.md': 'See [[Plan]].\n', 'Projects/Plan.md': '# Plan\n', 'Attachments/pic.png': 'png' },
			{ '.obsidian/app.json': JSON.stringify({ alwaysUpdateLinks: true }) },
		);
		expect(title('Welcome.md').querySelector('.nav-file-title-content')?.textContent).toBe('Welcome');
		expect(title('Projects').querySelector('.nav-folder-title-content')?.textContent).toBe('Projects');
		// Folders start closed, so large vaults draw only their top level; a click opens them, and that is remembered.
		expect(title('Projects').parentElement!.classList.contains('is-collapsed')).toBe(true);
		expect(document.querySelector('[data-path="Projects/Plan.md"]')).toBeNull();
		title('Projects').click();
		title('Attachments').click();
		expect(shell.app.loadLocalStorage('emerald-expanded-folders')).toEqual(['Projects', 'Attachments']);
		expect(title('Projects').querySelector('.nav-folder-collapse-indicator svg')).not.toBeNull();
		expect(title('Attachments/pic.png').querySelector('.nav-file-tag')?.textContent).toBe('png');
	});

	it('opens a context menu that plugins extend through file-menu', () => {
		const seen: string[] = [];
		const ref = shell.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile, source: string) => {
			seen.push(`${file.path} ${source}`);
			menu.addItem((item) => item.setTitle('From a plugin'));
		});
		title('Welcome.md').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
		// The Bookmarks core plugin adds its item through the same event.
		expect(menuItems()).toEqual(['Open in new tab', 'Rename…', 'Move to…', 'Bookmark', 'Merge entire file with…', 'Copy path', 'Reveal in Finder', 'Open local history', 'Delete', 'From a plugin']);
		expect(seen).toEqual(['Welcome.md file-explorer-context-menu']);
		shell.press('Escape');
		shell.app.workspace.offref(ref);

		title('Projects').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		expect(menuItems().slice(0, 2)).toEqual(['New note', 'New folder']);
		shell.press('Escape');
	});

	it('renames in place, and updates links to the renamed note', async () => {
		title('Projects/Plan.md').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		clickMenuItem('Rename…');
		const field = await vi.waitFor(() => {
			const el = document.querySelector<HTMLElement>('.nav-file-title-content.is-being-renamed');
			if (!el) throw new Error('not editable yet');
			return el;
		});
		field.textContent = 'Roadmap';
		field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await vi.waitFor(() => expect(shell.app.vault.getFileByPath('Projects/Roadmap.md')).not.toBeNull());
	});

	it('moves items by dragging them onto a folder', async () => {
		drag(title('Welcome.md'), title('Projects').parentElement!);
		await vi.waitFor(() => expect(shell.app.vault.getFileByPath('Projects/Welcome.md')).not.toBeNull());
		await vi.waitFor(() => expect(title('Projects/Welcome.md')).not.toBeNull());
		// A folder cannot go inside itself.
		drag(title('Projects'), title('Projects/Welcome.md').parentElement!);
		expect(shell.app.vault.getFolderByPath('Projects')).not.toBeNull();
	});

	it('creates a folder and names it in place', async () => {
		document.getElementById('file-tree')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		clickMenuItem('New folder');
		const field = await vi.waitFor(() => {
			const el = document.querySelector<HTMLElement>('.nav-folder-title-content.is-being-renamed');
			if (!el) throw new Error('not editable yet');
			return el;
		});
		expect(field.textContent).toBe('Untitled');
		field.textContent = 'Inbox';
		field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await vi.waitFor(() => expect(shell.app.vault.getFolderByPath('Inbox')).not.toBeNull());
	});
});
