// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { emit } from '@tauri-apps/api/event';
import { deepLinkTo, handleDeepLink, parseDeepLink } from '../src/deep-links';
import { startShell } from './shell-harness';

it('parses emeraldmd:// links', () => {
	expect(parseDeepLink('emeraldmd://open?vault=My%20vault&file=Notes%2FA%20b')).toEqual({ action: 'open', params: { vault: 'My vault', file: 'Notes/A b' } });
	expect(parseDeepLink('emeraldmd:search?query=x')).toEqual({ action: 'search', params: { query: 'x' } });
	expect(parseDeepLink('obsidian://open?file=A')).toBeNull();
	expect(parseDeepLink('not a url')).toBeNull();
});

it('opens, creates and searches from links, and passes others to plugins', async () => {
	const queue = ['emeraldmd://open?file=Projects%2FPlan'];
	const shell = await startShell({ 'Home.md': 'home', 'Projects/Plan.md': '# Plan' }, {}, false, {
		take_open_urls: () => queue.splice(0),
	});
	const app = shell.app;
	// The link that started the app is followed once the vault is open.
	await vi.waitFor(() => expect(app.workspace.getActiveFile()?.path).toBe('Projects/Plan.md'));
	const name = encodeURIComponent(app.vault.getName());
	expect(deepLinkTo(app, app.vault.getFileByPath('Projects/Plan.md')!)).toBe(`emeraldmd://open?vault=${name}&file=Projects%2FPlan`);

	// Links that arrive later.
	queue.push(`emeraldmd://open?vault=${name}&file=Home`);
	await emit('open-url', null);
	await vi.waitFor(() => expect(app.workspace.getActiveFile()?.path).toBe('Home.md'));

	const openSearch = vi.fn(async () => {});
	await handleDeepLink(app, { openSearch }, 'emeraldmd://new?file=Inbox%2FIdea&content=First%20line&silent=true');
	expect(await app.vault.read(app.vault.getFileByPath('Inbox/Idea.md')!)).toBe('First line');
	expect(app.workspace.getActiveFile()?.path).toBe('Home.md');
	await handleDeepLink(app, { openSearch }, 'emeraldmd://new?file=Inbox%2FIdea&content=Second%20line&append=true');
	expect(await app.vault.read(app.vault.getFileByPath('Inbox/Idea.md')!)).toBe('First line\nSecond line');
	await vi.waitFor(() => expect(app.workspace.getActiveFile()?.path).toBe('Inbox/Idea.md'));
	await handleDeepLink(app, { openSearch }, 'emeraldmd://search?query=tag%3A%23x');
	expect(openSearch).toHaveBeenCalledWith('tag:#x');

	const handler = vi.fn();
	app.protocolHandlers.set('my-plugin', handler);
	await handleDeepLink(app, { openSearch }, 'emeraldmd://my-plugin?x=1');
	expect(handler).toHaveBeenCalledWith({ action: 'my-plugin', x: '1' });

	// A link for another vault does nothing here.
	await handleDeepLink(app, { openSearch }, 'emeraldmd://new?vault=Other&file=Nope');
	expect(app.vault.getFileByPath('Nope.md')).toBeNull();
	await vi.waitFor(() => expect(document.querySelector('.notice')?.textContent).toContain('"Other"'));
});
