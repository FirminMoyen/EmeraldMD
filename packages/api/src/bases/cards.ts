/**
 * The cards and list views of Bases. Cards (`type: cards`) show a grid of
 * notes with a cover image from a property (`image`: a link, a path, a URL
 * or a colour), sized by `cardSize`, fitted by `imageFit`, with the cover's
 * height by `imageAspectRatio`. The list (`type: list`) shows a line per
 * note: its name, then the other properties.
 */

import { Keymap } from '../keymap';
import type { BasesEntry, BasesEntryGroup, BasesPropertyId, QueryController } from './query';
import { parsePropertyId } from './query';
import { BasesView, renderProperty, shownProperties, wireCheckbox, type BasesViewRegistration } from './view';
import { DateValue, FileValue, imageSource, LinkValue, ListValue, NullValue, StringValue, type Value } from './values';

const COLOR = /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([^)]*\))$/i;

function groupHeading(view: BasesView, el: HTMLElement, group: BasesEntryGroup): void {
	const heading = el.createDiv('bases-group-heading');
	const key = heading.createSpan('bases-group-key');
	if (group.hasKey()) group.key!.renderTo(key, view.app.renderContext);
	else key.setText('None');
	heading.createSpan({ cls: 'bases-group-count', text: String(group.entries.length) });
}

/** Opens the entry's file when its card or line is clicked outside links and fields. */
function openOnClick(view: BasesView, el: HTMLElement, entry: BasesEntry): void {
	el.addEventListener('click', (evt) => {
		if ((evt.target as Element).closest('a, input, button')) return;
		void view.app.workspace.getLeaf(Keymap.isModEvent(evt) ? 'tab' : false).openFile(entry.file);
	});
}

export class CardsView extends BasesView {
	type = 'cards';

	constructor(
		controller: QueryController,
		private readonly el: HTMLElement,
	) {
		super(controller, el);
	}

	onDataUpdated(): void {
		this.el.empty();
		const container = this.el.createDiv('bases-cards-container');
		const size = Number(this.config.get('cardSize'));
		if (size > 0) container.style.setProperty('--bases-cards-size', `${size}px`);
		const ratio = Number(this.config.get('imageAspectRatio'));
		if (ratio > 0) container.style.setProperty('--bases-cards-image-ratio', String(ratio));
		const image = this.config.getAsPropertyId('image');
		const fit = this.config.get('imageFit') === 'contain' ? 'contain' : 'cover';
		const props = shownProperties(this);
		const grouped = !!this.controller.view.groupBy?.property;
		for (const group of this.data.groupedData) {
			const section = container.createDiv('bases-cards-group');
			if (grouped) groupHeading(this, section, group);
			const grid = section.createDiv('bases-cards-grid');
			for (const entry of group.entries) this.card(grid, entry, props, image, fit);
		}
		if (!this.data.data.length) container.createDiv({ cls: 'bases-empty', text: 'No results' });
	}

	private card(grid: HTMLElement, entry: BasesEntry, props: BasesPropertyId[], image: BasesPropertyId | null, fit: string): void {
		const card = grid.createDiv({ cls: 'bases-cards-item', attr: { 'data-path': entry.file.path } });
		if (image) {
			const cover = card.createDiv(`bases-cards-cover mod-${fit}`);
			const value = entry.getValue(image) ?? NullValue.value;
			const text = coverText(value);
			if (text && COLOR.test(text.trim())) cover.style.backgroundColor = text.trim();
			else {
				const src = text ? imageSource(this.app, text, entry.file.path) : null;
				if (src) cover.createEl('img', { attr: { src, alt: '', loading: 'lazy', draggable: 'false' } });
				else cover.addClass('mod-empty');
			}
		}
		const body = card.createDiv('bases-cards-properties');
		for (const prop of props) {
			const line = body.createDiv({ cls: 'bases-cards-property', attr: { 'data-property': prop } });
			const { type, name } = parsePropertyId(prop);
			if (!(type === 'file' && (name === 'name' || name === 'basename'))) line.createDiv({ cls: 'bases-cards-label', text: this.config.getDisplayName(prop) });
			else line.addClass('mod-title');
			const valueEl = line.createDiv('bases-cards-line');
			const value = renderProperty(this.app, valueEl, entry, prop);
			wireCheckbox(this.app, valueEl, entry, prop, value);
			if (value instanceof NullValue && !line.hasClass('mod-title')) line.addClass('mod-empty');
		}
		openOnClick(this, card, entry);
	}
}

/** The text of a cover value: the link target, file path, or first item of a list. */
function coverText(value: Value): string | null {
	if (value instanceof ListValue) return value.length() ? coverText(value.get(0)) : null;
	if (value instanceof FileValue) return value.file.path;
	if (value instanceof LinkValue) return value.resolve()?.path ?? value.value;
	if (value instanceof StringValue) return value.value;
	if (value instanceof NullValue || value instanceof DateValue) return null;
	return value.toString();
}

export class ListView extends BasesView {
	type = 'list';

	constructor(
		controller: QueryController,
		private readonly el: HTMLElement,
	) {
		super(controller, el);
	}

	onDataUpdated(): void {
		this.el.empty();
		const container = this.el.createDiv('bases-list-container');
		const props = shownProperties(this);
		const grouped = !!this.controller.view.groupBy?.property;
		const labels = this.config.get('showLabels') === true;
		for (const group of this.data.groupedData) {
			const section = container.createDiv('bases-list-group');
			if (grouped) groupHeading(this, section, group);
			const list = section.createEl('ul', { cls: 'bases-list' });
			for (const entry of group.entries) {
				const item = list.createEl('li', { cls: 'bases-list-item', attr: { 'data-path': entry.file.path } });
				for (const prop of props) {
					const value = entry.getValue(prop) ?? NullValue.value;
					const { type, name } = parsePropertyId(prop);
					const title = type === 'file' && (name === 'name' || name === 'basename');
					if (!title && value instanceof NullValue) continue;
					const el = item.createSpan({ cls: title ? 'bases-list-title' : 'bases-list-property', attr: { 'data-property': prop } });
					if (labels && !title) el.createSpan({ cls: 'bases-list-label', text: `${this.config.getDisplayName(prop)}: ` });
					wireCheckbox(this.app, el, entry, prop, renderProperty(this.app, el, entry, prop));
				}
				openOnClick(this, item, entry);
			}
		}
		if (!this.data.data.length) container.createDiv({ cls: 'bases-empty', text: 'No results' });
	}
}

export const CARDS_VIEW: BasesViewRegistration = {
	name: 'Cards',
	icon: 'layout-grid',
	factory: (controller, containerEl) => new CardsView(controller, containerEl),
	options: () => [
		{ key: 'cardSize', type: 'slider', displayName: 'Card size', default: 200, min: 50, max: 800, step: 10 },
		{ key: 'image', type: 'property', displayName: 'Image property', placeholder: 'None' },
		{ key: 'imageFit', type: 'dropdown', displayName: 'Image fit', default: 'cover', options: { cover: 'Cover', contain: 'Contain' } },
		{ key: 'imageAspectRatio', type: 'slider', displayName: 'Image aspect ratio', default: 0.5, min: 0.25, max: 2.5, step: 0.05 },
	],
};

export const LIST_VIEW: BasesViewRegistration = {
	name: 'List',
	icon: 'list',
	factory: (controller, containerEl) => new ListView(controller, containerEl),
	options: () => [{ key: 'showLabels', type: 'toggle', displayName: 'Show property names', default: false }],
};
