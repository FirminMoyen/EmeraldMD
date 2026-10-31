/**
 * The graph view's settings, kept in `.obsidian/graph.json` with Obsidian's
 * keys (so a vault's existing settings apply here, and back): filters,
 * colour groups, display and forces, and the controls panel that edits them
 * (`.graph-controls`, collapsible sections as in Obsidian). The local graph
 * has the same settings plus its own (`localJumps`, `localBacklinks`,
 * `localForelinks`, `localInterlinks`), in a first section.
 */

import { debounce, Setting, setIcon, type App } from '@emeraldmd/api';
import type { GraphDisplay, GraphForces } from '@emeraldmd/graph';

export interface ColorGroup {
	query: string;
	/** `rgb` is 0xRRGGBB, `a` the opacity. */
	color: { a: number; rgb: number };
}

export interface GraphSettings {
	'collapse-filter': boolean;
	search: string;
	showTags: boolean;
	showAttachments: boolean;
	hideUnresolved: boolean;
	showOrphans: boolean;
	'collapse-color-groups': boolean;
	colorGroups: ColorGroup[];
	'collapse-display': boolean;
	showArrow: boolean;
	textFadeMultiplier: number;
	nodeSizeMultiplier: number;
	lineSizeMultiplier: number;
	'collapse-forces': boolean;
	centerStrength: number;
	repelStrength: number;
	linkStrength: number;
	linkDistance: number;
	scale: number;
	/** Whether the controls panel is closed. */
	close: boolean;
	/** Local graph: how many links away, and which links to follow or show. */
	localJumps?: number;
	localBacklinks?: boolean;
	localForelinks?: boolean;
	localInterlinks?: boolean;
	'collapse-local'?: boolean;
}

/** The local graph's own settings, as Obsidian's defaults. */
export const DEFAULT_LOCAL_SETTINGS = { localJumps: 1, localBacklinks: true, localForelinks: true, localInterlinks: false, 'collapse-local': false };

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
	'collapse-filter': false,
	search: '',
	showTags: false,
	showAttachments: false,
	hideUnresolved: false,
	showOrphans: true,
	'collapse-color-groups': true,
	colorGroups: [],
	'collapse-display': true,
	showArrow: false,
	textFadeMultiplier: 0,
	nodeSizeMultiplier: 1,
	lineSizeMultiplier: 1,
	'collapse-forces': true,
	centerStrength: 0.52,
	repelStrength: 10,
	linkStrength: 1,
	linkDistance: 250,
	scale: 1,
	close: true,
};

/** Obsidian's slider values as the layout's forces (their defaults give the layout's defaults). */
export function forcesOf(settings: GraphSettings): GraphForces {
	return {
		center: settings.centerStrength * 0.1,
		repel: settings.repelStrength * 12,
		link: settings.linkStrength * 0.6,
		linkDistance: settings.linkDistance * 0.24,
	};
}

export function displayOf(settings: GraphSettings): GraphDisplay {
	return { arrows: settings.showArrow, nodeSize: settings.nodeSizeMultiplier, lineSize: settings.lineSizeMultiplier, textFade: settings.textFadeMultiplier };
}

export function cssColor(color: ColorGroup['color']): string {
	const rgb = Number(color.rgb) || 0;
	return `rgba(${(rgb >> 16) & 255}, ${(rgb >> 8) & 255}, ${rgb & 255}, ${color.a ?? 1})`;
}

function hexOf(color: ColorGroup['color']): string {
	return `#${(Number(color.rgb) || 0).toString(16).padStart(6, '0')}`;
}

function rgbOf(hex: string): number {
	return parseInt(hex.replace('#', ''), 16) || 0;
}

/** A colour for a new group, in turn. */
const GROUP_COLORS = [0xe0ac00, 0x2f9e6e, 0x3b82c4, 0xc23b7a, 0x8a63d2, 0xd2691e];

const PATH = (app: App) => `${app.vault.configDir}/graph.json`;

export async function loadGraphSettings(app: App): Promise<GraphSettings> {
	try {
		if (await app.vault.adapter.exists(PATH(app))) {
			const saved = JSON.parse(await app.vault.adapter.read(PATH(app))) as Partial<GraphSettings>;
			return { ...DEFAULT_GRAPH_SETTINGS, ...saved, colorGroups: Array.isArray(saved.colorGroups) ? saved.colorGroups : [] };
		}
	} catch (err) {
		console.error(`Could not read ${PATH(app)}`, err);
	}
	return { ...DEFAULT_GRAPH_SETTINGS, colorGroups: [] };
}

export function graphSettingsSaver(app: App): (settings: GraphSettings) => void {
	return debounce((settings: GraphSettings) => {
		void app.vault.adapter.write(PATH(app), JSON.stringify(settings, null, 2)).catch((err: unknown) => console.error(err));
	}, 500);
}

export type GraphChange = 'filter' | 'groups' | 'display' | 'forces' | 'panel' | 'local';

/** The controls panel at the top right of the graph view. */
export class GraphControls {
	readonly containerEl: HTMLElement;

	constructor(
		parent: HTMLElement,
		private readonly settings: GraphSettings,
		private readonly onChange: (change: GraphChange) => void,
		/** The local graph's controls: its own section first. */
		private readonly local = false,
	) {
		this.containerEl = parent.createDiv('graph-controls');
		this.render();
	}

	render(): void {
		const s = this.settings;
		const root = this.containerEl;
		root.empty();
		root.toggleClass('is-close', s.close);
		const close = root.createDiv({ cls: 'clickable-icon graph-controls-button mod-close', attr: { 'aria-label': 'Close' } });
		setIcon(close, 'x');
		close.addEventListener('click', () => this.setOpen(false));
		const open = root.createDiv({ cls: 'clickable-icon graph-controls-button mod-open', attr: { 'aria-label': 'Open graph settings' } });
		setIcon(open, 'settings');
		open.addEventListener('click', () => this.setOpen(true));
		if (s.close) return;

		if (this.local) {
			this.section('Local graph', 'collapse-local', (el) => {
				this.slider(el, 'Depth', 'localJumps', 1, 5, 1, 'local');
				this.toggle(el, 'Incoming links', 'localBacklinks', 'local');
				this.toggle(el, 'Outgoing links', 'localForelinks', 'local');
				this.toggle(el, 'Neighbor links', 'localInterlinks', 'local');
			});
		}
		this.section('Filters', 'collapse-filter', (el) => {
			const search = el.createEl('input', { cls: 'graph-search', attr: { type: 'search', placeholder: 'Search files…', spellcheck: 'false' } });
			search.value = s.search;
			const searchChanged = debounce(() => this.onChange('filter'), 300, true);
			search.addEventListener('input', () => {
				s.search = search.value;
				searchChanged();
			});
			this.toggle(el, 'Tags', 'showTags', 'filter');
			this.toggle(el, 'Attachments', 'showAttachments', 'filter');
			this.toggle(el, 'Existing files only', 'hideUnresolved', 'filter');
			this.toggle(el, 'Orphans', 'showOrphans', 'filter');
		});
		this.section('Groups', 'collapse-color-groups', (el) => {
			s.colorGroups.forEach((group, i) => {
				const row = el.createDiv('graph-color-group');
				const query = row.createEl('input', { cls: 'graph-color-query', attr: { type: 'text', placeholder: 'Enter query…', spellcheck: 'false' } });
				query.value = group.query;
				const queryChanged = debounce(() => this.onChange('groups'), 400, true);
				query.addEventListener('input', () => {
					group.query = query.value;
					queryChanged();
				});
				const color = row.createEl('input', { cls: 'graph-color-picker', attr: { type: 'color', 'aria-label': 'Colour' } });
				color.value = hexOf(group.color);
				color.addEventListener('input', () => {
					group.color = { a: group.color.a ?? 1, rgb: rgbOf(color.value) };
					this.onChange('groups');
				});
				const remove = row.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': 'Delete group' } });
				setIcon(remove, 'x');
				remove.addEventListener('click', () => {
					s.colorGroups.splice(i, 1);
					this.render();
					this.onChange('groups');
				});
			});
			const add = el.createEl('button', { cls: 'graph-color-button-container mod-cta', text: 'New group' });
			add.addEventListener('click', () => {
				s.colorGroups.push({ query: '', color: { a: 1, rgb: GROUP_COLORS[s.colorGroups.length % GROUP_COLORS.length]! } });
				this.render();
				this.onChange('groups');
			});
		});
		this.section('Display', 'collapse-display', (el) => {
			this.toggle(el, 'Arrows', 'showArrow', 'display');
			this.slider(el, 'Text fade threshold', 'textFadeMultiplier', -3, 3, 0.1, 'display');
			this.slider(el, 'Node size', 'nodeSizeMultiplier', 0.1, 5, 0.01, 'display');
			this.slider(el, 'Link thickness', 'lineSizeMultiplier', 0.1, 5, 0.01, 'display');
		});
		this.section('Forces', 'collapse-forces', (el) => {
			this.slider(el, 'Center force', 'centerStrength', 0, 1, 0.01, 'forces');
			this.slider(el, 'Repel force', 'repelStrength', 0, 20, 0.1, 'forces');
			this.slider(el, 'Link force', 'linkStrength', 0, 1, 0.01, 'forces');
			this.slider(el, 'Link distance', 'linkDistance', 30, 500, 1, 'forces');
		});
	}

	private setOpen(open: boolean): void {
		this.settings.close = !open;
		this.render();
		this.onChange('panel');
	}

	private section(title: string, key: 'collapse-filter' | 'collapse-color-groups' | 'collapse-display' | 'collapse-forces' | 'collapse-local', build: (el: HTMLElement) => void): void {
		const s = this.settings;
		const section = this.containerEl.createDiv({ cls: ['graph-control-section', ...(s[key] ? ['is-collapsed'] : [])] });
		const header = section.createDiv('tree-item-self is-clickable graph-control-section-header');
		setIcon(header.createDiv('tree-item-icon collapse-icon'), s[key] ? 'chevron-right' : 'chevron-down');
		header.createDiv({ cls: 'tree-item-inner', text: title });
		header.addEventListener('click', () => {
			s[key] = !s[key];
			this.render();
			this.onChange('panel');
		});
		if (!s[key]) build(section.createDiv('tree-item-children graph-control-section-content'));
	}

	private toggle(
		el: HTMLElement,
		name: string,
		key: 'showTags' | 'showAttachments' | 'hideUnresolved' | 'showOrphans' | 'showArrow' | 'localBacklinks' | 'localForelinks' | 'localInterlinks',
		change: GraphChange,
	): void {
		new Setting(el)
			.setName(name)
			.setClass('mod-toggle')
			.addToggle((t) =>
				t.setValue(this.settings[key] === true).onChange((on) => {
					this.settings[key] = on;
					this.onChange(change);
				}),
			);
	}

	private slider(
		el: HTMLElement,
		name: string,
		key: 'textFadeMultiplier' | 'nodeSizeMultiplier' | 'lineSizeMultiplier' | 'centerStrength' | 'repelStrength' | 'linkStrength' | 'linkDistance' | 'localJumps',
		min: number,
		max: number,
		step: number,
		change: GraphChange,
	): void {
		new Setting(el)
			.setName(name)
			.setClass('mod-slider')
			.addSlider((slider) =>
				slider
					.setLimits(min, max, step)
					.setValue(this.settings[key] ?? min)
					.setDynamicTooltip()
					.onChange((value) => {
						this.settings[key] = value;
						this.onChange(change);
					}),
			);
	}
}
