// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src';
import { Slides, splitSlides } from '../src';
import { createTestApp } from '../src/testing';

afterEach(() => document.body.replaceChildren());

const DECK = ['---', 'title: Deck', '---', '# One', '', '---', '', '# Two', 'Heading under text', '---', '', '```', '---', '```', '', '---', '', '# Three', ''].join('\n');

describe('Slides', () => {
	it('splits at --- lines, but not in the frontmatter, code or under text', () => {
		const slides = splitSlides(DECK);
		expect(slides.map((s) => s.text)).toEqual(['# One', '# Two\nHeading under text\n---\n\n```\n---\n```', '# Three']);
		expect(DECK.slice(slides[2]!.start).trim()).toBe('# Three');
		expect(splitSlides('Just text')).toEqual([{ text: 'Just text', start: 0 }]);
	});

	it('presents the active note, moves with the keys and ends with Escape', async () => {
		const { app } = await createTestApp({ 'Deck.md': DECK }, { '.obsidian/core-plugins.json': JSON.stringify({ slides: true }) });
		await app.internalPlugins.load(app);
		const slides = app.internalPlugins.getEnabledPluginById('slides') as Slides;
		vi.spyOn(app.workspace, 'getActiveFile').mockReturnValue(app.vault.getFileByPath('Deck.md'));
		await slides.present();
		const counter = () => document.querySelector('.mod-slides .slides-counter')?.textContent;
		const content = () => document.querySelector('.mod-slides .slides-content')?.textContent;
		expect(counter()).toBe('1 / 3');
		await vi.waitFor(() => expect(content()).toBe('One'));
		const press = (key: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
		press('ArrowRight');
		press(' ');
		expect(counter()).toBe('3 / 3');
		press('ArrowRight');
		expect(counter()).toBe('3 / 3');
		press('Home');
		expect(counter()).toBe('1 / 3');
		press('Escape');
		expect(document.querySelector('.mod-slides')).toBeNull();
	});
});
