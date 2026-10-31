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

	it('embeds audio and video players and PDFs', async () => {
		const t = await createTestApp({ 'song.mp3': 'MP3', 'clip.mp4': 'MP4', 'paper.pdf': 'PDF' });
		t.app.vault.adapter.resourcePath = (path) => `asset://localhost/vault/${path}`;
		const el = document.createElement('div');
		await MarkdownRenderer.render(t.app, '![[song.mp3]]\n\n![[clip.mp4|320x180]]\n\n![[paper.pdf#page=3&height=400]]', el, 'Note.md', new Component());
		const audio = el.querySelector<HTMLAudioElement>('.media-embed.audio-embed audio');
		expect(audio?.getAttribute('src')).toMatch(/song\.mp3/);
		expect(audio?.hasAttribute('controls')).toBe(true);
		const video = el.querySelector<HTMLVideoElement>('.media-embed.video-embed video');
		expect([video?.getAttribute('width'), video?.getAttribute('height')]).toEqual(['320', '180']);
		const pdf = el.querySelector<HTMLIFrameElement>('.pdf-embed iframe.pdf-frame');
		expect(pdf?.getAttribute('src')).toMatch(/paper\.pdf\?\d+#page=3$/);
		expect(pdf?.style.height).toBe('400px');
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

describe('line breaks', () => {
	it('turns single line breaks into <br> unless "Strict line breaks" is on', async () => {
		const loose = await render('one\ntwo');
		expect(loose.el.querySelector('p')?.innerHTML).toBe('one<br>two');
		const { app } = await createTestApp({}, { '.obsidian/app.json': JSON.stringify({ strictLineBreaks: true }) });
		const el = document.createElement('div');
		await MarkdownRenderer.render(app, 'one\ntwo', el, 'Note.md', new Component());
		expect(el.querySelector('p')?.innerHTML).toBe('one\ntwo');
	});
});

describe('math, footnotes and diagrams', () => {
	it('keeps formulas whole, even with underscores and stars', async () => {
		const { el } = await render('Inline $x_1 + y_2 * z_3$ and **bold**, but not $5 or $10.\n\n$$\n\\frac{a}{b}\n$$\n\nAlso $$e^x$$ in text.');
		const inline = el.querySelectorAll('.math.math-inline');
		expect(inline).toHaveLength(1);
		expect(el.querySelector('p strong')?.textContent).toBe('bold');
		expect(el.querySelector('p')?.textContent).toContain('but not $5 or $10.');
		expect(el.querySelectorAll('.math.math-block')).toHaveLength(2);
	});

	it('renders formulas with MathJax', async () => {
		const { loadMathJax, renderMath } = await import('../src');
		await loadMathJax();
		const formula = renderMath('\\sqrt{x^2}', false);
		expect(formula.classList.contains('is-loaded')).toBe(true);
		expect(formula.querySelector('mjx-container svg')).not.toBeNull();
		expect((globalThis as { MathJax?: { tex2svg?: unknown } }).MathJax?.tex2svg).toBeTypeOf('function');
	}, 20000);

	it('numbers footnotes and lists them at the end', async () => {
		const { el } = await render('One[^a], two^[An *inline* note], three[^a], missing[^zz].\n\n[^a]: The **note**,\n    continued.\n');
		expect([...el.querySelectorAll('sup.footnote-ref')].map((s) => s.textContent)).toEqual(['1', '2', '1']);
		expect(el.querySelector('p')?.textContent).toContain('missing[^zz]');
		const items = el.querySelectorAll('section.footnotes > ol > li');
		expect(items).toHaveLength(2);
		expect(items[0]!.querySelector('strong')?.textContent).toBe('note');
		expect(items[0]!.textContent).toContain('continued.');
		expect(items[0]!.querySelectorAll('.footnote-backref')).toHaveLength(2);
		expect(items[1]!.querySelector('em')?.textContent).toBe('inline');
		const ref = el.querySelector<HTMLAnchorElement>('sup.footnote-ref a')!;
		expect(ref.getAttribute('href')).toBe(`#${items[0]!.id}`);
	});

	it('puts mermaid code blocks in a .mermaid element', async () => {
		const { el } = await render('```mermaid\ngraph TD; A-->B\n```');
		expect(el.querySelector('div.mermaid')).not.toBeNull();
		expect(el.querySelector('pre')).toBeNull();
	});
});

describe('untrusted notes stay inert', () => {
	it('drops links that run code from formulas', async () => {
		const { loadMathJax, renderMath } = await import('../src');
		await loadMathJax();
		const formula = renderMath('\\href{javascript:alert(1)}{x} + \\href{https://example.org}{y}', false);
		const hrefs = [...formula.querySelectorAll('*')].flatMap((el) => [el.getAttribute('href'), el.getAttribute('xlink:href')]).filter(Boolean);
		expect(hrefs.some((h) => /javascript:/i.test(h!))).toBe(false);
		expect(hrefs).toContain('https://example.org');
	}, 20000);

	it('cleans generated SVG and HTML in notes', async () => {
		const { sanitizeSvg, isDangerousUrl } = await import('../src');
		const svg = new DOMParser().parseFromString(
			'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="x()"><script>x()</script><a xlink:href="javascript:x()"><text onclick="x()">t</text></a><a href="#ok">ok</a></svg>',
			'image/svg+xml',
		).documentElement;
		sanitizeSvg(svg);
		expect(svg.outerHTML).not.toMatch(/onload|onclick|<script|javascript:/i);
		expect(svg.querySelector('a[href="#ok"]')).not.toBeNull();
		expect(isDangerousUrl(' jav\tascript:x()')).toBe(true);
		expect(isDangerousUrl('https://example.org')).toBe(false);

		const { el } = await render('<div><a href="data:text/html,x">bad</a> <img src="data:image/png;base64,AAAA"> <a href="vbscript:x">vb</a></div>');
		expect(el.querySelector('a[href^="data:"]')).toBeNull();
		expect(el.querySelector('a[href^="vbscript:"]')).toBeNull();
		expect(el.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
	});
});
