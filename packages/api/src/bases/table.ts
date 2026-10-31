/**
 * The table view of Bases (`type: table`): one row per file, a column per
 * property in the view's `order`. Headers sort, group, rename, move and
 * hide; their edges resize (`columnSize`); note properties are edited in
 * their cells; the footer shows each column's summary (`summaries`).
 * Options: `rowHeight`.
 */

import { Menu } from '../menu';
import { setIcon } from '../icons';
import { FormulaModal, PromptModal } from './modals';
import type { BasesEntry, BasesEntryGroup, BasesPropertyId, QueryController } from './query';
import { normalizePropertyId, parsePropertyId, SUMMARIES } from './query';
import { BasesView, editProperty, isEditable, renderProperty, shownProperties, wireCheckbox, type BasesViewRegistration } from './view';
import { NullValue } from './values';

/** Rows drawn before "Show more". */
const PAGE = 500;

export class TableView extends BasesView {
	type = 'table';
	private readonly el: HTMLElement;
	private rowsShown = PAGE;

	constructor(controller: QueryController, containerEl: HTMLElement) {
		super(controller, containerEl);
		this.el = containerEl;
	}

	onDataUpdated(): void {
		const scroll = this.el.querySelector('.bases-table-container')?.scrollLeft ?? 0;
		this.el.empty();
		const props = shownProperties(this);
		const widths = (this.config.get('columnSize') as Record<string, number> | undefined) ?? {};
		const wrap = this.el.createDiv('bases-table-container');
		const rowHeight = this.config.get('rowHeight');
		if (typeof rowHeight === 'string') wrap.addClass(`mod-row-height-${rowHeight}`);
		const table = wrap.createEl('table', { cls: 'bases-table' });
		const head = table.createEl('thead').createEl('tr', { cls: 'bases-tr' });
		const sort = this.config.getSort();
		for (const prop of props) {
			const th = head.createEl('th', { cls: 'bases-th', attr: { 'data-property': prop } });
			const width = widths[prop] ?? widths[parsePropertyId(prop).name];
			if (typeof width === 'number' && width > 0) th.style.width = th.style.minWidth = `${width}px`;
			const content = th.createDiv('bases-th-content');
			content.createSpan({ cls: 'bases-th-label', text: this.config.getDisplayName(prop) });
			const sorted = sort.find((s) => s.property === prop);
			if (sorted) setIcon(content.createSpan('bases-th-sort'), sorted.direction === 'ASC' ? 'arrow-up' : 'arrow-down');
			content.addEventListener('click', (evt) => this.showHeaderMenu(evt, prop));
			this.resizable(th, prop);
		}
		const body = table.createEl('tbody');
		const grouped = !!this.controller.view.groupBy?.property;
		let drawn = 0;
		const total = this.data.data.length;
		for (const group of this.data.groupedData) {
			if (drawn >= this.rowsShown) break;
			if (grouped) this.groupHeading(body, group, props.length);
			for (const entry of group.entries) {
				if (drawn >= this.rowsShown) break;
				this.row(body, entry, props);
				drawn++;
			}
		}
		this.footer(table, props);
		if (drawn < total) {
			const more = wrap.createEl('button', { cls: 'bases-show-more', text: `Show ${Math.min(PAGE, total - drawn)} more of ${total - drawn}` });
			more.addEventListener('click', () => {
				this.rowsShown += PAGE;
				this.onDataUpdated();
			});
		}
		wrap.scrollLeft = scroll;
	}

	private groupHeading(body: HTMLElement, group: BasesEntryGroup, columns: number): void {
		const td = body.createEl('tr', { cls: 'bases-group-heading' }).createEl('td', { attr: { colspan: String(columns) } });
		const key = td.createSpan('bases-group-key');
		if (group.hasKey()) group.key!.renderTo(key, this.app.renderContext);
		else key.setText('None');
		td.createSpan({ cls: 'bases-group-count', text: String(group.entries.length) });
	}

	private row(body: HTMLElement, entry: BasesEntry, props: BasesPropertyId[]): void {
		const tr = body.createEl('tr', { cls: 'bases-tr', attr: { 'data-path': entry.file.path } });
		for (const prop of props) {
			const td = tr.createEl('td', { cls: 'bases-td', attr: { 'data-property': prop } });
			const draw = () => {
				td.empty();
				const value = renderProperty(this.app, td, entry, prop);
				wireCheckbox(this.app, td, entry, prop, value);
			};
			draw();
			if (!isEditable(entry, prop)) continue;
			td.addClass('mod-editable');
			td.addEventListener('click', (evt) => {
				const target = evt.target as Element;
				if (td.hasClass('is-editing') || target.closest('a, input')) return;
				editProperty(this.app, td, entry, prop, draw);
			});
		}
		tr.addEventListener('auxclick', (evt) => {
			if (evt.button === 1) void this.app.workspace.getLeaf('tab').openFile(entry.file);
		});
		tr.addEventListener('contextmenu', (evt) => {
			evt.preventDefault();
			const menu = new Menu();
			menu.addItem((item) => item.setTitle('Open in new tab').setIcon('file-plus').onClick(() => void this.app.workspace.getLeaf('tab').openFile(entry.file)));
			this.app.workspace.trigger('file-menu', menu, entry.file, 'bases');
			menu.showAtMouseEvent(evt);
		});
	}

	private footer(table: HTMLElement, props: BasesPropertyId[]): void {
		const summaries = (this.config.get('summaries') as Record<string, string> | undefined) ?? {};
		if (!Object.keys(summaries).length) return;
		const tr = table.createEl('tfoot').createEl('tr', { cls: 'bases-summary-row' });
		for (const prop of props) {
			const td = tr.createEl('td', { cls: 'bases-summary', attr: { 'data-property': prop } });
			const key = summaries[prop] ?? summaries[parsePropertyId(prop).name];
			if (key) {
				td.createSpan({ cls: 'bases-summary-label', text: key });
				const value = this.data.getSummaryValue(this.controller, this.data.data, prop, key);
				if (!(value instanceof NullValue)) value.renderTo(td.createSpan('bases-summary-value'), this.app.renderContext);
			}
			td.addEventListener('click', (evt) => this.showSummaryMenu(evt, prop, key));
		}
	}

	private setOrder(order: BasesPropertyId[]): void {
		this.config.set('order', order);
	}

	private showHeaderMenu(evt: MouseEvent, prop: BasesPropertyId): void {
		const menu = new Menu();
		const order = shownProperties(this);
		const i = order.indexOf(prop);
		const sortBy = (direction: 'ASC' | 'DESC') => this.config.set('sort', [{ property: prop, direction }]);
		menu.addItem((item) => item.setTitle('Sort A → Z').setIcon('arrow-up-narrow-wide').setSection('sort').onClick(() => sortBy('ASC')));
		menu.addItem((item) => item.setTitle('Sort Z → A').setIcon('arrow-down-wide-narrow').setSection('sort').onClick(() => sortBy('DESC')));
		const groupedBy = this.controller.view.groupBy?.property;
		if (groupedBy && normalizePropertyId(groupedBy) === prop) {
			menu.addItem((item) => item.setTitle('Ungroup').setIcon('ungroup').setSection('sort').onClick(() => this.config.set('groupBy', null)));
		} else {
			menu.addItem((item) => item.setTitle('Group by this property').setIcon('group').setSection('sort').onClick(() => this.config.set('groupBy', { property: prop, direction: 'ASC' })));
		}
		menu.addItem((item) =>
			item
				.setTitle('Rename…')
				.setIcon('pencil')
				.setSection('property')
				.onClick(() =>
					new PromptModal(this.app, 'Rename property', this.config.getDisplayName(prop), (name) => {
						const properties = (this.controller.config.properties ??= {});
						const entry = (properties[prop] ??= {});
						if (name.trim()) entry.displayName = name.trim();
						else delete entry.displayName;
						if (!Object.keys(entry).length) delete properties[prop];
						this.controller.changed();
					}).open(),
				),
		);
		if (parsePropertyId(prop).type === 'formula') {
			menu.addItem((item) =>
				item
					.setTitle('Edit formula…')
					.setIcon('function-square')
					.setSection('property')
					.onClick(() => new FormulaModal(this.app, this.controller, parsePropertyId(prop).name).open()),
			);
		}
		if (i > 0) {
			menu.addItem((item) =>
				item
					.setTitle('Move left')
					.setIcon('arrow-left')
					.setSection('move')
					.onClick(() => this.setOrder(move(order, i, i - 1))),
			);
		}
		if (i !== -1 && i < order.length - 1) {
			menu.addItem((item) =>
				item
					.setTitle('Move right')
					.setIcon('arrow-right')
					.setSection('move')
					.onClick(() => this.setOrder(move(order, i, i + 1))),
			);
		}
		menu.addItem((item) =>
			item
				.setTitle('Hide property')
				.setIcon('eye-off')
				.setSection('danger')
				.onClick(() => this.setOrder(order.filter((p) => p !== prop))),
		);
		menu.showAtMouseEvent(evt);
	}

	private showSummaryMenu(evt: MouseEvent, prop: BasesPropertyId, current: string | undefined): void {
		const menu = new Menu();
		const set = (key: string | null) => {
			const summaries = { ...((this.config.get('summaries') as Record<string, string> | undefined) ?? {}) };
			delete summaries[parsePropertyId(prop).name];
			if (key) summaries[prop] = key;
			else delete summaries[prop];
			this.config.set('summaries', Object.keys(summaries).length ? summaries : null);
		};
		menu.addItem((item) => item.setTitle('None').setChecked(!current).onClick(() => set(null)));
		for (const key of [...Object.keys(SUMMARIES), ...Object.keys(this.controller.config.summaries ?? {})]) {
			menu.addItem((item) => item.setTitle(key).setChecked(current === key).onClick(() => set(key)));
		}
		menu.showAtMouseEvent(evt);
	}

	/** Dragging a header's right edge sets the column's width. */
	private resizable(th: HTMLElement, prop: BasesPropertyId): void {
		const handle = th.createDiv('bases-th-resize');
		handle.addEventListener('click', (evt) => evt.stopPropagation());
		handle.addEventListener('pointerdown', (down) => {
			down.preventDefault();
			down.stopPropagation();
			const start = down.clientX;
			const startWidth = th.offsetWidth;
			let width = startWidth;
			const onMove = (move: PointerEvent) => {
				width = Math.max(40, startWidth + move.clientX - start);
				th.style.width = th.style.minWidth = `${width}px`;
			};
			const onUp = () => {
				window.removeEventListener('pointermove', onMove);
				window.removeEventListener('pointerup', onUp);
				if (width === startWidth) return;
				const widths = { ...((this.config.get('columnSize') as Record<string, number> | undefined) ?? {}), [prop]: Math.round(width) };
				this.config.set('columnSize', widths);
			};
			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', onUp);
		});
		handle.addEventListener('dblclick', (evt) => {
			evt.stopPropagation();
			const widths = { ...((this.config.get('columnSize') as Record<string, number> | undefined) ?? {}) };
			delete widths[prop];
			this.config.set('columnSize', Object.keys(widths).length ? widths : null);
		});
	}
}

function move<T>(list: T[], from: number, to: number): T[] {
	const out = [...list];
	const [item] = out.splice(from, 1);
	out.splice(to, 0, item!);
	return out;
}

export const TABLE_VIEW: BasesViewRegistration = {
	name: 'Table',
	icon: 'table',
	factory: (controller, containerEl) => new TableView(controller, containerEl),
	options: () => [
		{
			key: 'rowHeight',
			type: 'dropdown',
			displayName: 'Row height',
			default: 'medium',
			options: { short: 'Short', medium: 'Medium', tall: 'Tall', 'extra-tall': 'Extra tall' },
		},
	],
};
