// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { startShell } from './shell-harness';

const title = (path: string) => document.querySelector<HTMLElement>(`.nav-files-container [data-path="${path}"], [data-path="${path}"].nav-file-title, [data-path="${path}"].nav-folder-title`)!;
const click = (path: string, mods: MouseEventInit = {}) => title(path).dispatchEvent(new MouseEvent('click', { bubbles: true, ...mods }));
const selected = () => [...document.querySelectorAll<HTMLElement>('.nav-file-title.is-selected, .nav-folder-title.is-selected')].map((el) => el.dataset.path);

it('selects with ⌥-click and ⇧-click, and moves or deletes the selection at once', async () => {
	const shell = await startShell({ 'A.md': 'a', 'B.md': 'b', 'C.md': 'c', 'D.md': 'd', 'Archive/Old.md': 'o' }, {});
	const app = shell.app;
	await vi.waitFor(() => expect(title('A.md')).toBeTruthy());

	click('A.md', { altKey: true });
	click('C.md', { altKey: true });
	expect(selected()).toEqual(['A.md', 'C.md']);
	// ⌥-click again takes an item out.
	click('A.md', { altKey: true });
	expect(selected()).toEqual(['C.md']);
	// ⇧-click: everything from the last ⌥-clicked item (A) to this one.
	click('C.md', { shiftKey: true });
	expect(selected()).toEqual(['A.md', 'B.md', 'C.md']);

	// The selection's menu: plugins get files-menu with every item.
	const seen: string[][] = [];
	app.workspace.on('files-menu', (_menu: unknown, files: { path: string }[]) => seen.push(files.map((f) => f.path)));
	title('B.md').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
	expect(seen).toEqual([['A.md', 'B.md', 'C.md']]);
	const items = [...document.querySelectorAll<HTMLElement>('.menu .menu-item')];
	expect(items.map((el) => el.textContent)).toContain('Move 3 items to…');
	items.find((el) => el.textContent === 'Delete 3 items')!.click();
	await vi.waitFor(() => expect(app.vault.getFileByPath('A.md')).toBeNull());
	expect(app.vault.getFileByPath('B.md')).toBeNull();
	expect(app.vault.getFileByPath('C.md')).toBeNull();
	expect(app.vault.getFileByPath('D.md')).not.toBeNull();
	expect(selected()).toEqual([]);

	// A plain click clears the selection and opens the note.
	click('D.md', { altKey: true });
	expect(selected().length).toBeGreaterThan(0);
	click('D.md');
	expect(selected()).toEqual([]);
	await vi.waitFor(() => expect(app.workspace.getActiveFile()?.path).toBe('D.md'));
});
