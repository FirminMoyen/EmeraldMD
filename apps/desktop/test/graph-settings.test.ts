// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { cssColor, DEFAULT_GRAPH_SETTINGS, DEFAULT_LOCAL_SETTINGS, displayOf, forcesOf, GraphControls, type GraphChange } from '../src/core-views/graph-settings';
import { startShell } from './shell-harness';

describe('graph settings', () => {
	it('maps Obsidian’s sliders onto the layout (its defaults give the layout’s defaults) and colours', () => {
		const forces = forcesOf(DEFAULT_GRAPH_SETTINGS);
		expect(forces.repel).toBeCloseTo(120);
		expect(forces.linkDistance).toBeCloseTo(60);
		expect(displayOf({ ...DEFAULT_GRAPH_SETTINGS, showArrow: true, nodeSizeMultiplier: 2 })).toEqual({ arrows: true, nodeSize: 2, lineSize: 1, textFade: 0 });
		expect(cssColor({ a: 0.5, rgb: 0xff8000 })).toBe('rgba(255, 128, 0, 0.5)');
	});

	it('gives the local graph its own section: depth and the links to follow', () => {
		const settings = { ...DEFAULT_GRAPH_SETTINGS, ...DEFAULT_LOCAL_SETTINGS, colorGroups: [], close: false };
		const changes: GraphChange[] = [];
		const el = document.body.createDiv();
		new GraphControls(el, settings, (change) => changes.push(change), true);
		const sections = [...el.querySelectorAll('.graph-control-section-header')].map((h) => h.textContent);
		expect(sections[0]).toBe('Local graph');
		const setting = (name: string) => [...el.querySelectorAll('.setting-item')].find((item) => item.querySelector('.setting-item-name')?.textContent === name)!;
		expect(setting('Neighbor links').querySelector('.checkbox-container')!.classList.contains('is-enabled')).toBe(false);
		setting('Incoming links').querySelector<HTMLElement>('.checkbox-container')!.click();
		expect(settings.localBacklinks).toBe(false);
		expect(changes).toEqual(['local']);
		expect(setting('Depth').querySelector('input[type=range]')).not.toBeNull();
		el.remove();
		// The global graph has no such section.
		const global = document.body.createDiv();
		new GraphControls(global, { ...DEFAULT_GRAPH_SETTINGS, colorGroups: [], close: false }, () => {});
		expect(global.querySelector('.graph-control-section-header')?.textContent).toBe('Filters');
	});

	it('reads graph.json, edits it from the panel, and keeps Obsidian’s keys', async () => {
		const saved = { ...DEFAULT_GRAPH_SETTINGS, showTags: true, close: false, 'collapse-display': false, colorGroups: [{ query: 'tag:#x', color: { a: 1, rgb: 0x123456 } }] };
		const shell = await startShell({ 'A.md': 'a' }, { '.obsidian/graph.json': JSON.stringify(saved) });
		shell.app.commands.executeCommandById('graph:open');
		const panel = await vi.waitFor(() => {
			const el = document.querySelector<HTMLElement>('.graph-controls:not(.is-close)');
			if (!el) throw new Error('no open panel');
			return el;
		});
		const toggle = (name: string) => [...panel.querySelectorAll('.setting-item')].find((el) => el.querySelector('.setting-item-name')?.textContent === name)!;
		expect(toggle('Tags').querySelector('.checkbox-container')!.classList.contains('is-enabled')).toBe(true);
		toggle('Arrows').querySelector<HTMLElement>('.checkbox-container')!.click();
		await vi.waitFor(async () => {
			const file = JSON.parse((await shell.config.read('.obsidian/graph.json'))!) as typeof saved;
			expect(file.showArrow).toBe(true);
			expect(file.colorGroups).toEqual(saved.colorGroups);
			expect(file.showTags).toBe(true);
		});
	});
});
