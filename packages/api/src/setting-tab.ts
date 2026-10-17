/**
 * Setting tabs and the settings modal (`app.setting`).
 *
 * A tab renders either declaratively, from `getSettingDefinitions()` (API
 * 1.13+), or imperatively through `display()` when it returns no
 * definitions, as the typings document.
 */

import type { App } from './app';
import { setIcon } from './icons';
import { Modal } from './modal';
import type { Plugin } from './plugin';
import {
	ColorComponent,
	DropdownComponent,
	ExtraButtonComponent,
	Setting,
	SettingGroup,
	SliderComponent,
	TextAreaComponent,
	TextComponent,
	ToggleComponent,
} from './setting';

type Predicate = boolean | (() => boolean);

interface ControlBase<V> {
	key: string;
	defaultValue?: V;
	validate?: (value: V) => string | void | Promise<string | void>;
	disabled?: Predicate;
}

export type SettingControl =
	| (ControlBase<boolean> & { type: 'toggle' })
	| (ControlBase<string> & { type: 'dropdown'; options: Record<string, string> })
	| (ControlBase<string> & { type: 'text' | 'file' | 'folder' | 'secret'; placeholder?: string })
	| (ControlBase<string> & { type: 'textarea'; placeholder?: string; rows?: number })
	| (ControlBase<number> & { type: 'number'; placeholder?: string; min?: number; max?: number; step?: number | 'any' })
	| (ControlBase<number> & { type: 'slider'; min: number; max: number; step: number; displayFormat?: (value: number) => string })
	| (ControlBase<string> & { type: 'color' });

export interface SettingDefinition {
	name: string;
	desc?: string | DocumentFragment;
	aliases?: string[];
	searchable?: Predicate;
	visible?: Predicate;
	control?: SettingControl;
	action?: (el: HTMLElement, index: number) => void;
	render?: (setting: Setting, group: SettingGroup) => void | (() => void);
	disabled?: Predicate;
}

export interface SettingDefinitionGroup {
	type: 'group' | 'list';
	heading?: string;
	cls?: string;
	extraButtons?: ((component: ExtraButtonComponent) => unknown)[];
	items?: SettingDefinitionItem[];
	visible?: Predicate;
	emptyState?: string | DocumentFragment;
	addItem?: { name: string; action: (el: HTMLElement) => void };
}

export interface SettingDefinitionPage {
	type: 'page';
	name: string;
	desc?: string | DocumentFragment;
	items?: SettingDefinitionItem[];
	visible?: Predicate;
}

export type SettingDefinitionItem = SettingDefinition | SettingDefinitionGroup | SettingDefinitionPage;

function evaluate(predicate: Predicate | undefined, fallback: boolean): boolean {
	if (predicate === undefined) return fallback;
	return typeof predicate === 'function' ? predicate() : predicate;
}

export abstract class SettingTab {
	icon = 'settings';
	app: App;
	containerEl: HTMLElement;
	settingItems: SettingDefinitionItem[] = [];
	/** Not in the public typings; the settings modal identifies tabs by `id` and lists them by `name`. */
	id = '';
	name = '';
	private stateUpdaters: (() => void)[] = [];
	private renderCleanups: (() => void)[] = [];

	constructor(app: App) {
		this.app = app;
		this.containerEl = createDiv('vertical-tab-content');
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [];
	}

	/** @internal Whether the tab is listed (a core plugin's options, while the plugin is off, are not). */
	isAvailable(): boolean {
		return true;
	}

	update(): void {
		this.settingItems = this.getSettingDefinitions() ?? [];
	}

	getControlValue(key: string): unknown {
		return this.app.vault.getConfig(key);
	}

	setControlValue(key: string, value: unknown): void | Promise<void> {
		this.app.vault.setConfig(key, value);
	}

	refreshDomState(): void {
		for (const update of this.stateUpdaters) update();
	}

	display(): void {}

	hide(): void {
		for (const cleanup of this.renderCleanups.splice(0)) cleanup();
		this.stateUpdaters = [];
		this.containerEl.empty();
	}

	/** @internal Shows the tab: declarative definitions if there are any, otherwise `display()`. */
	render(): void {
		this.update();
		if (this.settingItems.length === 0) {
			this.display();
			return;
		}
		this.containerEl.empty();
		this.stateUpdaters = [];
		const ungrouped = new SettingGroup(this.containerEl);
		for (const item of this.settingItems) this.renderItem(item, ungrouped);
		this.refreshDomState();
	}

	private renderItem(item: SettingDefinitionItem, group: SettingGroup): void {
		if ('type' in item && (item.type === 'group' || item.type === 'list')) {
			const sub = new SettingGroup(this.containerEl);
			if (item.heading) sub.setHeading(item.heading);
			if (item.cls) sub.addClass(item.cls);
			for (const cb of item.extraButtons ?? []) sub.addExtraButton(cb);
			const items = item.items ?? [];
			if (items.length === 0 && item.emptyState) sub.listEl.createDiv({ cls: 'setting-list-empty', text: item.emptyState });
			for (const child of items) this.renderItem(child, sub);
			if (item.addItem) {
				const addItem = item.addItem;
				sub.addSetting((s) => s.setName(addItem.name).addButton((b) => b.setButtonText(addItem.name).onClick(() => addItem.action(b.buttonEl))));
			}
			this.trackVisibility(sub.listEl.parentElement!, item.visible);
			return;
		}
		if ('type' in item && item.type === 'page') {
			const sub = new SettingGroup(this.containerEl);
			sub.setHeading(item.name);
			for (const child of item.items ?? []) this.renderItem(child, sub);
			this.trackVisibility(sub.listEl.parentElement!, item.visible);
			return;
		}
		const def = item as SettingDefinition;
		group.addSetting((setting) => {
			setting.setName(def.name);
			if (def.desc) setting.setDesc(def.desc);
			if (def.control) this.renderControl(setting, def.control);
			else if (def.action) {
				const action = def.action;
				setting.settingEl.addClass('mod-clickable');
				setting.settingEl.addEventListener('click', () => action(setting.settingEl, 0));
			} else if (def.render) {
				const cleanup = def.render(setting, group);
				if (typeof cleanup === 'function') this.renderCleanups.push(cleanup);
			}
			this.trackVisibility(setting.settingEl, def.visible);
			const disabled = def.disabled ?? def.control?.disabled;
			if (disabled !== undefined) this.stateUpdaters.push(() => setting.setDisabled(evaluate(disabled, false)));
		});
	}

	private trackVisibility(el: HTMLElement, visible: Predicate | undefined): void {
		if (visible !== undefined) this.stateUpdaters.push(() => el.toggle(evaluate(visible, true)));
	}

	private renderControl(setting: Setting, control: SettingControl): void {
		const current = this.getControlValue(control.key) ?? control.defaultValue;
		const commit = async (value: unknown) => {
			const error = control.validate ? await (control.validate as (v: unknown) => string | void | Promise<string | void>)(value) : undefined;
			setting.setErrorMessage(error || null);
			if (error) return;
			await this.setControlValue(control.key, value);
			this.refreshDomState();
		};
		switch (control.type) {
			case 'toggle':
				setting.addToggle((t: ToggleComponent) => t.setValue(Boolean(current)).onChange(commit));
				break;
			case 'dropdown':
				setting.addDropdown((d: DropdownComponent) => d.addOptions(control.options).setValue(String(current ?? '')).onChange(commit));
				break;
			case 'textarea':
				setting.addTextArea((t: TextAreaComponent) => {
					t.setValue(String(current ?? '')).onChange(commit);
					if (control.placeholder) t.setPlaceholder(control.placeholder);
					if (control.rows) t.inputEl.rows = control.rows;
				});
				break;
			case 'number':
				setting.addText((t: TextComponent) => {
					t.inputEl.type = 'number';
					if (control.min !== undefined) t.inputEl.min = String(control.min);
					if (control.max !== undefined) t.inputEl.max = String(control.max);
					if (control.step !== undefined) t.inputEl.step = String(control.step);
					if (control.placeholder) t.setPlaceholder(control.placeholder);
					t.setValue(current === undefined || current === null ? '' : String(current)).onChange((v) => commit(Number(v)));
				});
				break;
			case 'slider':
				setting.addSlider((s: SliderComponent) => {
					s.setLimits(control.min, control.max, control.step).setValue(Number(current ?? control.min));
					if (control.displayFormat) s.setDisplayFormat(control.displayFormat);
					s.onChange(commit);
				});
				break;
			case 'color':
				setting.addColorPicker((c: ColorComponent) => c.setValue(String(current ?? '#000000')).onChange(commit));
				break;
			default:
				setting.addText((t: TextComponent) => {
					if (control.type === 'secret') t.inputEl.type = 'password';
					if (control.placeholder) t.setPlaceholder(control.placeholder);
					t.setValue(String(current ?? '')).onChange(commit);
				});
		}
	}
}

export abstract class PluginSettingTab extends SettingTab {
	plugin: Plugin;

	constructor(app: App, plugin: Plugin) {
		super(app);
		this.plugin = plugin;
		this.id = plugin.manifest.id;
		this.name = plugin.manifest.name;
	}

	override getControlValue(key: string): unknown {
		return (this.plugin.settings as Record<string, unknown> | undefined)?.[key];
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = (this.plugin.settings ??= {}) as Record<string, unknown>;
		settings[key] = value;
		await this.plugin.saveData(settings);
	}
}

interface TabGroup {
	title: string;
	tabs: SettingTab[];
}

/** The settings modal, available to plugins as `app.setting`. */
export class AppSetting extends Modal {
	/** Built-in tabs. */
	settingTabs: SettingTab[] = [];
	/** Tabs added by plugins. */
	pluginTabs: SettingTab[] = [];
	/** Options of core plugins. */
	corePluginTabs: SettingTab[] = [];
	activeTab: SettingTab | null = null;
	tabHeadersEl: HTMLElement;
	tabContentContainer: HTMLElement;
	private lastTabId: string | null = null;

	constructor(app: App) {
		super(app);
		this.modalEl.addClass('mod-settings', 'mod-sidebar-layout');
		this.titleEl.parentElement?.detach();
		this.contentEl.addClass('vertical-tabs-container');
		this.tabHeadersEl = this.contentEl.createDiv('vertical-tab-header');
		this.tabContentContainer = this.contentEl.createDiv('vertical-tab-content-container');
	}

	addSettingTab(tab: SettingTab): void {
		if (!this.pluginTabs.includes(tab)) this.pluginTabs.push(tab);
		tab.update();
		if (this.isOpen) this.renderTabHeaders();
	}

	removeSettingTab(tab: SettingTab): void {
		this.pluginTabs = this.pluginTabs.filter((t) => t !== tab);
		if (this.activeTab === tab) {
			this.hideActiveTab();
			if (this.isOpen) this.openTab(this.settingTabs[0] ?? this.pluginTabs[0] ?? null);
		}
		if (this.isOpen) this.renderTabHeaders();
	}

	/** @internal Built-in tabs are listed before plugin tabs. */
	addBuiltInTab(tab: SettingTab): void {
		this.settingTabs.push(tab);
	}

	/** @internal A core plugin's options, listed under "Core plugins". */
	addCorePluginTab(tab: SettingTab): void {
		this.corePluginTabs.push(tab);
	}

	/** @internal Lists the tabs again (after a core plugin is turned on or off). */
	updateTabs(): void {
		if (this.isOpen) this.renderTabHeaders();
	}

	openTabById(id: string): SettingTab | null {
		const tab = [...this.settingTabs, ...this.corePluginTabs, ...this.pluginTabs].find((t) => t.id === id) ?? null;
		if (!tab) return null;
		if (!this.isOpen) {
			this.lastTabId = id;
			this.open();
		} else this.openTab(tab);
		return tab;
	}

	openTab(tab: SettingTab | null): void {
		this.hideActiveTab();
		if (!tab) return;
		this.activeTab = tab;
		this.lastTabId = tab.id;
		this.tabContentContainer.appendChild(tab.containerEl);
		this.renderTabHeaders();
		try {
			tab.render();
		} catch (err) {
			console.error(err);
			tab.containerEl.createDiv({ cls: 'setting-tab-error', text: `This tab failed to render: ${err}` });
		}
	}

	override onOpen(): void {
		this.renderTabHeaders();
		const all = [...this.settingTabs, ...this.corePluginTabs, ...this.pluginTabs].filter((t) => t.isAvailable());
		this.openTab(all.find((t) => t.id === this.lastTabId) ?? all[0] ?? null);
	}

	override onClose(): void {
		this.hideActiveTab();
	}

	private hideActiveTab(): void {
		const tab = this.activeTab;
		if (!tab) return;
		this.activeTab = null;
		try {
			tab.hide();
		} catch (err) {
			console.error(err);
		}
		tab.containerEl.detach();
	}

	private renderTabHeaders(): void {
		const groups: TabGroup[] = [
			{ title: 'Options', tabs: this.settingTabs },
			{ title: 'Core plugins', tabs: this.corePluginTabs.filter((t) => t.isAvailable()) },
			{ title: 'Community plugins', tabs: this.pluginTabs },
		];
		this.tabHeadersEl.empty();
		for (const group of groups) {
			if (group.tabs.length === 0) continue;
			const groupEl = this.tabHeadersEl.createDiv('vertical-tab-header-group');
			groupEl.createDiv({ cls: 'vertical-tab-header-group-title', text: group.title });
			const items = groupEl.createDiv('vertical-tab-header-group-items');
			for (const tab of group.tabs) {
				const item = items.createDiv('vertical-tab-nav-item');
				item.toggleClass('is-active', tab === this.activeTab);
				const icon = item.createDiv('vertical-tab-nav-item-icon');
				setIcon(icon, tab.icon || 'settings');
				item.createSpan({ cls: 'vertical-tab-nav-item-title', text: tab.name || tab.id });
				item.addEventListener('click', () => this.openTab(tab));
			}
		}
	}
}
