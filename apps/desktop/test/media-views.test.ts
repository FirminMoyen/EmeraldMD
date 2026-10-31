// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { startShell } from './shell-harness';

it('opens images, audio, video and PDFs in tabs', async () => {
	const shell = await startShell({ 'Home.md': 'hi', 'pic.png': 'PNG', 'song.m4a': 'M4A', 'clip.mov': 'MOV', 'paper.pdf': 'PDF' }, {});
	const app = shell.app;
	const open = async (path: string, selector: string) => {
		await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(path)!);
		return vi.waitFor(() => {
			const el = document.querySelector<HTMLElement>(`.workspace-leaf-content ${selector}`);
			if (!el) throw new Error(`no ${selector} for ${path}`);
			return el;
		});
	};
	expect((await open('pic.png', '.image-view .image-container img')).getAttribute('alt')).toBe('pic.png');
	expect((await open('song.m4a', '.audio-view audio')).hasAttribute('controls')).toBe(true);
	expect((await open('clip.mov', '.video-view video')).hasAttribute('controls')).toBe(true);
	expect((await open('paper.pdf', '.pdf-view iframe.pdf-frame')).getAttribute('src')).toBeTruthy();
	expect(document.querySelector('.workspace-leaf-content[data-type="pdf"]')).not.toBeNull();
	expect(document.querySelector('.mod-root .workspace-tab-header.is-active .workspace-tab-header-inner-title')?.textContent).toBe('paper.pdf');
});
