// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HoverPopover, PopoverState, type HoverParent } from '../src';
import { createTestApp } from '../src/testing';

afterEach(() => {
	vi.useRealTimers();
	document.body.replaceChildren();
});

const isMac = /Mac/.test(navigator.platform);
const mouse = (mod = false) => new MouseEvent('mouseover', { metaKey: mod && isMac, ctrlKey: mod && !isMac });

describe('HoverPopover', () => {
	it('shows after the wait, replaces the previous one and hides when the mouse leaves', async () => {
		vi.useFakeTimers();
		const parent: HoverParent = { hoverPopover: null };
		const target = document.body.createSpan({ text: 'link' });
		const first = new HoverPopover(parent, target, 300);
		expect(first.state).toBe(PopoverState.Showing);
		vi.advanceTimersByTime(300);
		expect(first.state).toBe(PopoverState.Shown);
		expect(first.hoverEl.isConnected).toBe(true);

		const second = new HoverPopover(parent, target, 0);
		expect(first.state).toBe(PopoverState.Hidden);
		vi.advanceTimersByTime(0);
		expect(parent.hoverPopover).toBe(second);

		target.dispatchEvent(new MouseEvent('mouseleave'));
		second.hoverEl.dispatchEvent(new MouseEvent('mouseenter'));
		vi.advanceTimersByTime(500);
		expect(second.state).toBe(PopoverState.Shown);
		second.hoverEl.dispatchEvent(new MouseEvent('mouseleave'));
		vi.advanceTimersByTime(300);
		expect(second.state).toBe(PopoverState.Hidden);
		expect(parent.hoverPopover).toBeNull();
	});

	it('hides on Escape', () => {
		vi.useFakeTimers();
		const popover = new HoverPopover({ hoverPopover: null }, null, 0);
		vi.advanceTimersByTime(0);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(popover.state).toBe(PopoverState.Hidden);
	});
});

describe('Page preview', () => {
	async function setup() {
		const { app } = await createTestApp({ 'Plan.md': '# Plan\n\nIntro\n\n## Goals\n\nShip it.\n\n## Later\n\nMaybe.\n', 'Home.md': 'See [[Plan]]' });
		await app.internalPlugins.load(app);
		return app;
	}

	it('shows the linked note, or its section, from the reading view without a key', async () => {
		const app = await setup();
		const parent: HoverParent = { hoverPopover: null };
		const targetEl = document.body.createEl('a', { text: 'Plan' });
		app.workspace.trigger('hover-link', { event: mouse(), source: 'preview', hoverParent: parent, targetEl, linktext: 'Plan#Goals', sourcePath: 'Home.md' });
		await vi.waitFor(() => expect(document.querySelector('.hover-popover .markdown-embed-content')?.textContent).toContain('Ship it.'));
		const text = document.querySelector('.hover-popover')!.textContent!;
		expect(text).not.toContain('Intro');
		expect(text).not.toContain('Maybe.');
	});

	it('needs the modifier key in the editor', async () => {
		const app = await setup();
		const parent: HoverParent = { hoverPopover: null };
		const targetEl = document.body.createSpan({ text: 'Plan' });
		app.workspace.trigger('hover-link', { event: mouse(false), source: 'editor', hoverParent: parent, targetEl, linktext: 'Plan', sourcePath: 'Home.md' });
		await new Promise((r) => setTimeout(r, 400));
		expect(document.querySelector('.hover-popover')).toBeNull();
		app.workspace.trigger('hover-link', { event: mouse(true), source: 'editor', hoverParent: parent, targetEl, linktext: 'Plan', sourcePath: 'Home.md' });
		await vi.waitFor(() => expect(document.querySelector('.hover-popover')?.textContent).toContain('Intro'));
	});
});
