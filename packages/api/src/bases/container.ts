/**
 * A base on screen: the toolbar (views, results, sort, filter, properties,
 * new note) over the current view. Used by `.base` files, their embeds and
 * `base` code blocks. DOM: `.bases-container > .bases-header >
 * .bases-toolbar` and `.bases-view[data-view-type]`.
 */

import type { App } from '../app';
import { Component } from '../component';
import { confirmAction } from '../confirm';
import { setIcon } from '../icons';
import { Menu } from '../menu';
import { Notice } from '../notice';
import { FilterModal, FormulaModal, PromptModal, ViewOptionsModal } from './modals';
import type { BasesPropertyId, QueryController } from './query';
import { normalizePropertyId } from './query';
import { BasesView, shownProperties, type BasesViewRegistration } from './view';
import { displayText, NullValue } from './values';

export interface BasesContainerOptions {
	/** The view types, by id. */
	registrations: () => Map<string, BasesViewRegistration>;
	/** Called when another view is chosen (the file view remembers it). */
	onViewChange?: (name: string) => void;
}

export class BasesContainer extends Component {
	readonly el: HTMLElement;
	private readonly toolbarEl: HTMLElement;
	private readonly viewEl: HTMLElement;
	private readonly errorEl: HTMLElement;
	private view: BasesView | null = null;
	private viewKey: unknown = null;
	private viewType = '';

	constructor(
		private readonly app: App,
		readonly controller: QueryController,
		parentEl: HTMLElement,
		private readonly options: BasesContainerOptions,
	) {
		super();
		this.el = parentEl.createDiv('bases-container');
		this.toolbarEl = this.el.createDiv('bases-header').createDiv('bases-toolbar');
		this.errorEl = this.el.createDiv('bases-error');
		this.viewEl = this.el.createDiv('bases-view');
	}

	override onload(): void {
		this.register(this.controller.onUpdate(() => this.render()));
		this.render();
	}

	override onunload(): void {
		this.view?.unload();
		this.view = null;
		this.el.remove();
	}

	/** Draws the toolbar, and the view with the latest result. */
	render(): void {
		const { controller } = this;
		this.renderToolbar();
		this.errorEl.toggle(!!controller.error);
		this.errorEl.setText(controller.error ?? '');
		const data = controller.view;
		const registration = this.options.registrations().get(data.type);
		if (!registration) {
			this.dropView();
			this.viewEl.empty();
			this.viewEl.createDiv({ cls: 'bases-empty', text: `There is no "${data.type}" view type. A plugin may add it.` });
			return;
		}
		if (this.viewKey !== data || this.viewType !== data.type || !this.view) {
			this.dropView();
			this.viewEl.empty();
			this.viewEl.setAttribute('data-view-type', data.type);
			try {
				this.view = registration.factory(controller, this.viewEl);
				this.view.load();
				this.viewKey = data;
				this.viewType = data.type;
			} catch (err) {
				console.error(err);
				this.viewEl.createDiv({ cls: 'bases-error', text: `The view could not be shown: ${(err as Error).message}` });
				return;
			}
		}
		const view = this.view!;
		view.data = controller.result;
		view.config = controller.viewConfig;
		view.allProperties = controller.allProperties;
		try {
			view.onDataUpdated();
		} catch (err) {
			console.error(err);
		}
	}

	private dropView(): void {
		this.view?.unload();
		this.view = null;
		this.viewKey = null;
	}

	private item(cls: string, icon: string, label: string, onClick: (evt: MouseEvent) => void): HTMLElement {
		const item = this.toolbarEl.createDiv(`bases-toolbar-item ${cls}`);
		const button = item.createDiv({ cls: 'text-icon-button', attr: { tabindex: '0', role: 'button' } });
		setIcon(button.createSpan('text-button-icon'), icon);
		button.createSpan({ cls: 'text-button-label', text: label });
		button.addEventListener('click', onClick);
		button.addEventListener('keydown', (evt) => {
			if (evt.key === 'Enter' || evt.key === ' ') {
				evt.preventDefault();
				button.click();
			}
		});
		return button;
	}

	private renderToolbar(): void {
		const { controller } = this;
		this.toolbarEl.empty();
		const data = controller.view;
		const registrations = this.options.registrations();
		const views = this.item('bases-toolbar-views-menu', registrations.get(data.type)?.icon ?? 'table', data.name, (evt) => this.viewsMenu(evt));
		setIcon(views.createSpan('text-button-icon mod-aux'), 'chevron-down');
		const count = controller.result.data.length;
		this.item('bases-toolbar-results-menu', 'list-ordered', `${count} result${count === 1 ? '' : 's'}`, (evt) => this.resultsMenu(evt));
		this.toolbarEl.createDiv('bases-toolbar-spacer');
		this.item('bases-toolbar-sort-menu', 'arrow-up-down', 'Sort', (evt) => this.sortMenu(evt));
		const filters = this.item('bases-toolbar-filter-menu', 'list-filter', 'Filter', () => new FilterModal(this.app, controller).open());
		if (controller.config.filters || data.filters) filters.addClass('is-active');
		this.item('bases-toolbar-properties-menu', 'list', 'Properties', (evt) => this.propertiesMenu(evt));
		this.item('bases-toolbar-new-item-menu', 'plus', 'New', () => {
			controller.createFile().catch((err: unknown) => new Notice(`Could not create the note: ${err}`));
		});
	}

	private select(name: string): void {
		this.controller.selectView(name);
		this.options.onViewChange?.(name);
	}

	private uniqueName(base: string): string {
		const names = new Set(this.controller.views.map((v) => v.name));
		if (!names.has(base)) return base;
		let i = 2;
		while (names.has(`${base} ${i}`)) i++;
		return `${base} ${i}`;
	}

	private viewsMenu(evt: MouseEvent): void {
		const { controller } = this;
		const registrations = this.options.registrations();
		const menu = new Menu();
		for (const view of controller.views) {
			menu.addItem((item) =>
				item
					.setTitle(view.name)
					.setIcon(registrations.get(view.type)?.icon ?? 'table')
					.setChecked(view === controller.view)
					.setSection('views')
					.onClick(() => this.select(view.name)),
			);
		}
		menu.addItem((item) => {
			item.setTitle('Add view').setIcon('plus').setSection('actions');
			const sub = item.setSubmenu();
			for (const [type, registration] of registrations) {
				sub.addItem((s) =>
					s
						.setTitle(registration.name)
						.setIcon(registration.icon)
						.onClick(() => {
							const name = this.uniqueName(registration.name);
							controller.views.push({ type, name, order: [...shownProperties(this.view ?? fakeView(controller))] });
							controller.viewName = name;
							controller.changed();
							this.options.onViewChange?.(name);
						}),
				);
			}
		});
		const current = controller.view;
		const registration = registrations.get(current.type);
		if (registration?.options) {
			menu.addItem((item) => item.setTitle('View options…').setIcon('settings-2').setSection('actions').onClick(() => new ViewOptionsModal(this.app, controller, registration).open()));
		}
		menu.addItem((item) =>
			item
				.setTitle('Rename view…')
				.setIcon('pencil')
				.setSection('actions')
				.onClick(() =>
					new PromptModal(this.app, 'Rename view', current.name, (name) => {
						const clean = name.trim();
						if (!clean || clean === current.name) return;
						current.name = this.uniqueName(clean);
						controller.viewName = current.name;
						controller.changed();
						this.options.onViewChange?.(current.name);
					}).open(),
				),
		);
		menu.addItem((item) =>
			item
				.setTitle('Duplicate view')
				.setIcon('copy')
				.setSection('actions')
				.onClick(() => {
					const copy = structuredClone(current);
					copy.name = this.uniqueName(current.name);
					controller.views.splice(controller.views.indexOf(current) + 1, 0, copy);
					controller.viewName = copy.name;
					controller.changed();
					this.options.onViewChange?.(copy.name);
				}),
		);
		if (controller.views.length > 1) {
			menu.addItem((item) =>
				item
					.setTitle('Delete view')
					.setIcon('trash-2')
					.setWarning(true)
					.setSection('danger')
					.onClick(async () => {
						const ok = await confirmAction(this.app, { title: 'Delete view?', message: `The view "${current.name}" is removed from this base.`, confirm: 'Delete' });
						if (!ok) return;
						controller.views.splice(controller.views.indexOf(current), 1);
						controller.viewName = controller.views[0]?.name ?? null;
						controller.changed();
						if (controller.viewName) this.options.onViewChange?.(controller.viewName);
					}),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	private resultsMenu(evt: MouseEvent): void {
		const { controller } = this;
		const menu = new Menu();
		const limit = Number(controller.view.limit) || 0;
		menu.addItem((item) => {
			item.setTitle(limit ? `Limit: ${limit}` : 'Limit: none').setIcon('list-end').setSection('limit');
			const sub = item.setSubmenu();
			for (const n of [0, 10, 25, 50, 100, 500]) {
				sub.addItem((s) =>
					s
						.setTitle(n ? String(n) : 'No limit')
						.setChecked(limit === n)
						.onClick(() => controller.viewConfig.set('limit', n || null)),
				);
			}
		});
		menu.addItem((item) => item.setTitle('Copy as Markdown table').setIcon('table').setSection('copy').onClick(() => void this.copy('markdown')));
		menu.addItem((item) => item.setTitle('Copy as CSV').setIcon('file-spreadsheet').setSection('copy').onClick(() => void this.copy('csv')));
		menu.showAtMouseEvent(evt);
	}

	/** The results as a Markdown table or CSV, on the clipboard. */
	private async copy(format: 'markdown' | 'csv'): Promise<void> {
		const { controller } = this;
		const props = shownProperties(this.view ?? fakeView(controller));
		const config = controller.viewConfig;
		const cell = (id: BasesPropertyId, entry: (typeof controller.result.data)[number]) => {
			const value = entry.getValue(id) ?? NullValue.value;
			if (id === 'file.name' || id === 'file.basename') return format === 'markdown' ? `[[${this.app.metadataCache.fileToLinktext(entry.file, '')}]]` : entry.file.basename;
			return displayText(value);
		};
		let text: string;
		if (format === 'markdown') {
			const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
			const rows = controller.result.data.map((e) => `| ${props.map((p) => esc(cell(p, e))).join(' | ')} |`);
			text = [`| ${props.map((p) => esc(config.getDisplayName(p))).join(' | ')} |`, `| ${props.map(() => '---').join(' | ')} |`, ...rows].join('\n');
		} else {
			const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
			text = [props.map((p) => esc(config.getDisplayName(p))).join(','), ...controller.result.data.map((e) => props.map((p) => esc(cell(p, e))).join(','))].join('\n');
		}
		try {
			await navigator.clipboard.writeText(text);
			new Notice(`Copied ${controller.result.data.length} result${controller.result.data.length === 1 ? '' : 's'}.`);
		} catch (err) {
			new Notice(`Could not copy: ${err}`);
		}
	}

	private sortMenu(evt: MouseEvent): void {
		const { controller } = this;
		const config = controller.viewConfig;
		const sort = config.getSort();
		const menu = new Menu();
		const setSort = (next: { property: string; direction: string }[]) => config.set('sort', next.length ? next : null);
		sort.forEach((s, i) => {
			menu.addItem((item) =>
				item
					.setTitle(`${config.getDisplayName(s.property)} (${s.direction === 'ASC' ? 'A → Z' : 'Z → A'})`)
					.setIcon(s.direction === 'ASC' ? 'arrow-up' : 'arrow-down')
					.setSection('sort')
					.onClick(() => setSort(sort.map((o, j) => (j === i ? { ...o, direction: o.direction === 'ASC' ? 'DESC' : 'ASC' } : o)))),
			);
		});
		menu.addItem((item) => {
			item.setTitle('Add sort').setIcon('plus').setSection('actions');
			const sub = item.setSubmenu();
			for (const id of controller.allProperties.filter((p) => !sort.some((s) => s.property === p))) {
				sub.addItem((s) => s.setTitle(config.getDisplayName(id)).onClick(() => setSort([...sort, { property: id, direction: 'ASC' }])));
			}
		});
		if (sort.length) menu.addItem((item) => item.setTitle('Remove sort').setIcon('x').setSection('actions').onClick(() => setSort([])));
		const groupBy = typeof controller.view.groupBy?.property === 'string' ? normalizePropertyId(controller.view.groupBy.property) : null;
		menu.addItem((item) => {
			item.setTitle(groupBy ? `Group by: ${config.getDisplayName(groupBy)}` : 'Group by').setIcon('group').setSection('group');
			const sub = item.setSubmenu();
			sub.addItem((s) => s.setTitle('None').setChecked(!groupBy).onClick(() => config.set('groupBy', null)));
			for (const id of controller.allProperties) {
				sub.addItem((s) =>
					s
						.setTitle(config.getDisplayName(id))
						.setChecked(groupBy === id)
						.onClick(() => config.set('groupBy', { property: id, direction: String(controller.view.groupBy?.direction ?? 'ASC') })),
				);
			}
		});
		if (groupBy) {
			const desc = String(controller.view.groupBy?.direction ?? 'ASC').toUpperCase() === 'DESC';
			menu.addItem((item) =>
				item
					.setTitle(desc ? 'Groups: Z → A' : 'Groups: A → Z')
					.setIcon(desc ? 'arrow-down' : 'arrow-up')
					.setSection('group')
					.onClick(() => config.set('groupBy', { property: groupBy, direction: desc ? 'ASC' : 'DESC' })),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	private propertiesMenu(evt: MouseEvent): void {
		const { controller } = this;
		const config = controller.viewConfig;
		const menu = new Menu();
		const order = shownProperties(this.view ?? fakeView(controller));
		for (const id of controller.allProperties) {
			const shown = order.includes(id);
			menu.addItem((item) =>
				item
					.setTitle(config.getDisplayName(id))
					.setChecked(shown)
					.setSection(id.startsWith('file.') ? 'file' : id.startsWith('formula.') ? 'formula' : 'note')
					.onClick(() => config.set('order', shown ? order.filter((p) => p !== id) : [...order, id])),
			);
		}
		menu.addItem((item) => item.setTitle('Add formula…').setIcon('function-square').setSection('actions').onClick(() => new FormulaModal(this.app, controller).open()));
		menu.showAtMouseEvent(evt);
	}
}

/** For menus before a view exists: the view's properties come from its settings alone. */
function fakeView(controller: QueryController): BasesView {
	return { config: controller.viewConfig } as BasesView;
}
