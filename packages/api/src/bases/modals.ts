/**
 * Dialogs of the Bases toolbar: a name prompt, the formula editor, the
 * filters (for all views and for this view, as `and`/`or`/`not` groups of
 * expressions), and a view's options (`BasesViewRegistration.options`).
 */

import type { App } from '../app';
import { Modal } from '../modal';
import { Setting } from '../setting';
import { debounce } from '../util';
import { evaluateFormula, FormulaError, parseFormula } from './formula';
import type { BasesConfigFileFilter, BasesPropertyId, QueryController } from './query';
import { filterErrors, normalizePropertyId } from './query';
import type { BasesAllOptions, BasesOption, BasesViewRegistration } from './view';
import { displayText, ErrorValue, NullValue } from './values';

export class PromptModal extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly value: string,
		private readonly onSubmit: (value: string) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.title);
		const input = this.contentEl.createEl('input', { cls: 'bases-prompt-input', attr: { type: 'text', spellcheck: 'false' } });
		input.value = this.value;
		const buttons = this.contentEl.createDiv('modal-button-container');
		buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
		const submit = () => {
			this.close();
			this.onSubmit(input.value);
		};
		buttons.createEl('button', { cls: 'mod-cta', text: 'Save' }).addEventListener('click', submit);
		input.addEventListener('keydown', (evt) => {
			if (evt.key === 'Enter') {
				evt.preventDefault();
				submit();
			}
		});
		input.focus();
		input.select();
	}
}

/** Adds or edits a formula (`formulas.<name>`); new ones are added to the view's properties. */
export class FormulaModal extends Modal {
	constructor(
		app: App,
		private readonly controller: QueryController,
		private readonly original: string | null = null,
	) {
		super(app);
		this.modalEl.addClass('mod-bases-formula');
	}

	override onOpen(): void {
		const { controller } = this;
		this.titleEl.setText(this.original ? 'Edit formula' : 'Add formula');
		let name = this.original ?? '';
		let source = this.original ? (controller.config.formulas?.[this.original] ?? '') : '';
		new Setting(this.contentEl).setName('Name').addText((text) => {
			text.setPlaceholder('Formula name').setValue(name).onChange((v) => (name = v));
			text.inputEl.addClass('bases-formula-name');
		});
		const area = this.contentEl.createEl('textarea', { cls: 'bases-formula-input', attr: { rows: '4', spellcheck: 'false', placeholder: 'e.g. (price * quantity).toFixed(2)' } });
		area.value = source;
		const preview = this.contentEl.createDiv('bases-formula-preview');
		const update = () => {
			source = area.value;
			preview.empty();
			preview.removeClass('mod-error');
			if (!source.trim()) return;
			try {
				parseFormula(source);
			} catch (err) {
				preview.addClass('mod-error');
				preview.setText((err as FormulaError).message);
				return;
			}
			const first = controller.result.data[0];
			if (!first) return;
			const value = evaluateFormula(source, controller.context(first.file));
			preview.createSpan({ cls: 'bases-formula-preview-label', text: `${first.file.basename}: ` });
			if (value instanceof ErrorValue) {
				preview.addClass('mod-error');
				preview.appendText(value.message);
			} else if (!(value instanceof NullValue)) preview.appendText(displayText(value));
		};
		area.addEventListener('input', debounce(update, 200, true));
		update();
		const buttons = this.contentEl.createDiv('modal-button-container');
		buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
		buttons.createEl('button', { cls: 'mod-cta', text: 'Save' }).addEventListener('click', () => {
			const clean = name.trim();
			if (!clean || !source.trim()) return;
			this.save(clean, source);
			this.close();
		});
		area.focus();
	}

	private save(name: string, source: string): void {
		const config = this.controller.config;
		const formulas = (config.formulas ??= {});
		const previous = this.original;
		if (previous && previous !== name) {
			delete formulas[previous];
			const from = `formula.${previous}`;
			const to = `formula.${name}`;
			for (const view of this.controller.views) {
				if (Array.isArray(view.order)) view.order = view.order.map((id) => (id === from ? to : id));
				if (Array.isArray(view.sort)) for (const s of view.sort) if (s.property === from) s.property = to;
				if (view.groupBy?.property === from) view.groupBy.property = to;
			}
			if (config.properties?.[from]) {
				config.properties[to] = config.properties[from]!;
				delete config.properties[from];
			}
		}
		formulas[name] = source;
		const view = this.controller.view;
		const id: BasesPropertyId = `formula.${name}`;
		const order = (view.order ??= []).map(normalizePropertyId);
		if (!order.includes(id)) view.order.push(id);
		this.controller.changed();
	}
}

type GroupKind = 'and' | 'or' | 'not';

interface FilterGroup {
	kind: GroupKind;
	items: (string | FilterGroup)[];
}

function toGroup(filter: BasesConfigFileFilter | undefined): FilterGroup {
	if (filter === undefined || filter === null) return { kind: 'and', items: [] };
	if (typeof filter === 'string') return { kind: 'and', items: [filter] };
	const kind: GroupKind = 'or' in filter ? 'or' : 'not' in filter ? 'not' : 'and';
	const list = (filter as Record<GroupKind, BasesConfigFileFilter[]>)[kind] ?? [];
	return { kind, items: (Array.isArray(list) ? list : []).map((item) => (typeof item === 'string' ? item : toGroup(item))) };
}

function fromGroup(group: FilterGroup): BasesConfigFileFilter | undefined {
	const items = group.items.map((item) => (typeof item === 'string' ? item : fromGroup(item))).filter((item): item is BasesConfigFileFilter => item !== undefined && item !== '');
	if (!items.length) return undefined;
	return { [group.kind]: items } as BasesConfigFileFilter;
}

const KINDS: Record<GroupKind, string> = {
	and: 'All of the following are true',
	or: 'Any of the following are true',
	not: 'None of the following are true',
};

/** The filters of all views and of this view, edited as groups of expressions. */
export class FilterModal extends Modal {
	private readonly applySoon = debounce(() => this.apply(), 400, true);
	private readonly global: FilterGroup;
	private readonly local: FilterGroup;

	constructor(
		app: App,
		private readonly controller: QueryController,
	) {
		super(app);
		this.modalEl.addClass('mod-bases-filters');
		this.global = toGroup(controller.config.filters);
		this.local = toGroup(controller.view.filters);
	}

	override onOpen(): void {
		this.titleEl.setText('Filters');
		this.render();
	}

	override onClose(): void {
		this.apply();
	}

	private apply(): void {
		const config = this.controller.config;
		const global = fromGroup(this.global);
		const local = fromGroup(this.local);
		if (JSON.stringify(global) === JSON.stringify(config.filters) && JSON.stringify(local) === JSON.stringify(this.controller.view.filters)) return;
		if (global === undefined) delete config.filters;
		else config.filters = global;
		if (local === undefined) delete this.controller.view.filters;
		else this.controller.view.filters = local;
		this.controller.changed();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createDiv({ cls: 'bases-filter-section-title', text: 'All views' });
		this.group(contentEl, this.global, null);
		contentEl.createDiv({ cls: 'bases-filter-section-title', text: `This view (${this.controller.view.name})` });
		this.group(contentEl, this.local, null);
		contentEl.createDiv({ cls: 'bases-filter-help', text: 'Each filter is a formula, such as file.hasTag("book"), status != "done" or file.mtime > now() - "1 week".' });
	}

	private group(parent: HTMLElement, group: FilterGroup, remove: (() => void) | null): void {
		const el = parent.createDiv('bases-filter-group');
		const header = el.createDiv('bases-filter-group-header');
		const select = header.createEl('select', { cls: 'dropdown' });
		for (const [kind, label] of Object.entries(KINDS)) select.createEl('option', { text: label, attr: { value: kind } });
		select.value = group.kind;
		select.addEventListener('change', () => {
			group.kind = select.value as GroupKind;
			this.applySoon();
		});
		if (remove) {
			const del = header.createEl('button', { cls: 'clickable-icon bases-filter-remove', attr: { 'aria-label': 'Remove group' }, text: '×' });
			del.addEventListener('click', remove);
		}
		const items = el.createDiv('bases-filter-items');
		group.items.forEach((item, i) => {
			const drop = () => {
				group.items.splice(i, 1);
				this.applySoon();
				this.render();
			};
			if (typeof item !== 'string') {
				this.group(items, item, drop);
				return;
			}
			const row = items.createDiv('bases-filter-row');
			const input = row.createEl('input', { cls: 'bases-filter-input', attr: { type: 'text', spellcheck: 'false', placeholder: 'file.hasTag("book")' } });
			input.value = item;
			const error = items.createDiv('bases-filter-error');
			const check = () => {
				const [message] = filterErrors(input.value);
				error.setText(message ? message.slice(input.value.length + 2) : '');
				row.toggleClass('mod-error', !!message);
			};
			check();
			input.addEventListener('input', () => {
				group.items[i] = input.value;
				check();
				this.applySoon();
			});
			const del = row.createEl('button', { cls: 'clickable-icon bases-filter-remove', attr: { 'aria-label': 'Remove filter' }, text: '×' });
			del.addEventListener('click', drop);
		});
		const actions = el.createDiv('bases-filter-actions');
		actions.createEl('button', { text: 'Add filter' }).addEventListener('click', () => {
			group.items.push('');
			this.render();
			const inputs = this.contentEl.querySelectorAll<HTMLInputElement>('.bases-filter-input');
			[...inputs].find((input) => input.value === '')?.focus();
		});
		actions.createEl('button', { text: 'Add filter group' }).addEventListener('click', () => {
			group.items.push({ kind: 'and', items: [''] });
			this.render();
		});
	}
}

/** A view's options, from its registration, saved in the view's settings. */
export class ViewOptionsModal extends Modal {
	constructor(
		app: App,
		private readonly controller: QueryController,
		private readonly registration: BasesViewRegistration,
	) {
		super(app);
		this.modalEl.addClass('mod-bases-view-options');
	}

	override onOpen(): void {
		this.titleEl.setText(`${this.controller.view.name}: options`);
		const options = this.registration.options?.(this.controller.viewConfig) ?? [];
		if (!options.length) this.contentEl.createDiv({ cls: 'bases-empty', text: 'This view has no options.' });
		this.render(this.contentEl, options);
	}

	private render(el: HTMLElement, options: BasesAllOptions[]): void {
		const config = this.controller.viewConfig;
		for (const option of options) {
			if (option.shouldHide?.()) continue;
			if (option.type === 'group' && 'items' in option) {
				new Setting(el).setName(option.displayName).setHeading();
				this.render(el, option.items);
				continue;
			}
			const o = option as BasesOption;
			const current = config.get(o.key) ?? o.default;
			const setting = new Setting(el).setName(o.displayName);
			const set = (value: unknown) => config.set(o.key, value);
			switch (o.type) {
				case 'dropdown':
					setting.addDropdown((d) => d.addOptions(o.options ?? {}).setValue(String(current ?? '')).onChange(set));
					break;
				case 'toggle':
					setting.addToggle((t) => t.setValue(current === true).onChange(set));
					break;
				case 'slider':
					setting.addSlider((s) =>
						s
							.setLimits(o.min ?? 0, o.max ?? 100, o.step ?? 1)
							.setValue(Number(current ?? o.min ?? 0))
							.setDynamicTooltip()
							.onChange(set),
					);
					break;
				case 'property': {
					const filter = o.filter as ((id: BasesPropertyId) => boolean) | undefined;
					setting.addDropdown((d) => {
						d.addOption('', o.placeholder ?? 'None');
						for (const id of this.controller.allProperties) if (!filter || filter(id)) d.addOption(id, config.getDisplayName(id));
						d.setValue(typeof current === 'string' ? normalizePropertyId(current) : '').onChange((v) => set(v || null));
					});
					break;
				}
				case 'multitext':
					setting.addText((t) =>
						t
							.setPlaceholder('Comma-separated')
							.setValue(Array.isArray(current) ? current.join(', ') : '')
							.onChange((v) =>
								set(
									v
										.split(',')
										.map((s) => s.trim())
										.filter(Boolean),
								),
							),
					);
					break;
				default:
					setting.addText((t) =>
						t
							.setPlaceholder(o.placeholder ?? '')
							.setValue(typeof current === 'string' ? current : '')
							.onChange(debounce((v: string) => set(v || null), 400, true)),
					);
			}
		}
	}
}
