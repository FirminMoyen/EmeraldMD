// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { Component, MarkdownRenderer } from '../src';
import { createTestApp } from '../src/testing';

async function render(markdown: string, files: Record<string, string> = {}) {
	const { app, backend } = await createTestApp({ 'Note.md': markdown, ...files });
	const el = document.createElement('div');
	await MarkdownRenderer.render(app, markdown, el, 'Note.md', new Component());
	return { el, app, backend };
}

describe('MarkdownRenderer extras', () => {
	it('renders callouts, foldable ones collapsed with "-"', async () => {
		const { el } = await render('> [!warning] Careful now\n> The body **text**.\n\n> [!faq]- Folded\n> Hidden\n\n> plain quote');
		const callouts = el.querySelectorAll('.callout');
		expect(callouts).toHaveLength(2);
		const warning = callouts[0]!;
		expect(warning.getAttribute('data-callout')).toBe('warning');
		expect(warning.querySelector('.callout-title-inner')?.textContent).toBe('Careful now');
		expect(warning.querySelector('.callout-content')?.textContent?.trim()).toBe('The body text.');
		expect(warning.querySelector('.callout-content strong')?.textContent).toBe('text');
		const faq = callouts[1]!;
		expect(faq.classList.contains('is-collapsible')).toBe(true);
		expect(faq.classList.contains('is-collapsed')).toBe(true);
		(faq.querySelector('.callout-title') as HTMLElement).click();
		expect(faq.classList.contains('is-collapsed')).toBe(false);
		expect(el.querySelector('blockquote')?.textContent?.trim()).toBe('plain quote');
	});

	it("uses a callout icon chosen in CSS, as snippets do for custom callouts", async () => {
		const style = document.head.createEl('style', { text: ".callout[data-callout='recipe'] { --callout-icon: lucide-chef-hat; }" });
		const el = document.body.createDiv();
		try {
			const { app } = await createTestApp();
			await MarkdownRenderer.render(app, '> [!recipe] Soup\n> Boil.\n\n> [!tip] Plain', el, 'Note.md', new Component());
			const icon = (type: string) => el.querySelector(`.callout[data-callout='${type}'] .callout-icon svg`)?.getAttribute('class');
			await vi.waitFor(() => expect(icon('recipe')).toContain('lucide-chef-hat'));
			expect(icon('tip')).toContain('lucide-flame');
		} finally {
			style.remove();
			el.remove();
		}
	});

	it('uses the type as the title when there is none', async () => {
		const { el } = await render('> [!tip]\n> Just a tip');
		expect(el.querySelector('.callout-title-inner')?.textContent).toBe('Tip');
		expect(el.querySelector('.callout-content')?.textContent?.trim()).toBe('Just a tip');
	});

	it('renders ==highlights==', async () => {
		const { el } = await render('Some ==marked words== here.');
		expect(el.querySelector('mark')?.textContent).toBe('marked words');
	});

	it('embeds images through the resource path, with a size', async () => {
		const { app, el } = await (async () => {
			const t = await createTestApp({ 'Note.md': '![[pic.png|200]]', 'pic.png': 'PNG' });
			t.app.vault.adapter.resourcePath = (path) => `asset://localhost/vault/${path}`;
			const el = document.createElement('div');
			await MarkdownRenderer.render(t.app, '![[pic.png|200]]', el, 'Note.md', new Component());
			return { app: t.app, el };
		})();
		const img = el.querySelector<HTMLImageElement>('.image-embed img');
		expect(img?.getAttribute('src')).toMatch(/^asset:\/\/localhost\/vault\/pic\.png\?\d+$/);
		expect(img?.getAttribute('width')).toBe('200');
		expect(app).toBeTruthy();
	});

	it('embeds a note section and marks missing embeds', async () => {
		const other = '# Other\n\nIntro\n\n## Part\n\nPart text\n\n## Next\n\nNot this';
		const { el } = await render('![[Other#Part]]\n\n![[Nope]]', { 'Other.md': other });
		const embed = el.querySelector('.markdown-embed .markdown-embed-content');
		expect(embed?.textContent).toContain('Part text');
		expect(embed?.textContent).not.toContain('Not this');
		expect(el.querySelector('.internal-embed.is-unresolved')?.getAttribute('src')).toBe('Nope');
	});

	it('stops recursive embeds after three levels', async () => {
		const { el } = await render('![[Note]]');
		const embeds = el.querySelectorAll('.markdown-embed');
		expect(embeds).toHaveLength(4);
		expect(embeds[3]!.querySelector('.markdown-embed-content')?.textContent).toBe('Note');
	});
});
