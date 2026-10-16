/**
 * Settings rows and their controls. DOM and class names follow what plugin
 * and theme CSS targets: `.setting-item > .setting-item-info + .setting-item-control`,
 * `.checkbox-container.is-enabled`, `select.dropdown`, `button.mod-cta`, …
 */

import { moment } from './moment';
import { setIcon } from './icons';
import { setTooltip, type TooltipOptions } from './tooltip';
import type { App } from './app';

export abstract class BaseComponent {
	disabled = false;

	then(cb: (component: this) => unknown): this {
		cb(this);
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
}

export abstract class ValueComponent<T> extends BaseComponent {
	registerOptionListener(listeners: Record<string, (value?: T) => T>, key: string): this {
		listeners[key] = (value?: T) => {
			if (value !== undefined) this.setValue(value);
			return this.getValue();
		};
		return this;
	}

	abstract getValue(): T;
	abstract setValue(value: T): this;
}

export class ButtonComponent extends BaseComponent {
	buttonEl: HTMLButtonElement;
	private clickHandler: ((evt: MouseEvent) => unknown) | null = null;

	constructor(containerEl: HTMLElement) {
		super();
		this.buttonEl = containerEl.createEl('button');
		this.buttonEl.addEventListener('click', (evt) => {
			if (!this.disabled) void Promise.resolve(this.clickHandler?.(evt)).catch((err: unknown) => console.error(err));
		});
	}

	override setDisabled(disabled: boolean): this {
		super.setDisabled(disabled);
		this.buttonEl.disabled = disabled;
		this.buttonEl.toggleClass('is-disabled', disabled);
		return this;
	}

	setCta(): this {
		this.buttonEl.addClass('mod-cta');
		return this;
	}

	removeCta(): this {
		this.buttonEl.removeClass('mod-cta');
		return this;
	}

	setWarning(): this {
		this.buttonEl.addClass('mod-warning');
		return this;
	}

	setDestructive(): this {
		this.buttonEl.addClass('mod-destructive');
		return this;
	}

	removeDestructive(): this {
		this.buttonEl.removeClass('mod-destructive');
		return this;
	}

	setTooltip(tooltip: string, options?: TooltipOptions): this {
		setTooltip(this.buttonEl, tooltip, options);
		return this;
	}

	setButtonText(name: string): this {
		this.buttonEl.setText(name);
		return this;
	}

	setIcon(icon: string): this {
		setIcon(this.buttonEl, icon);
		return this;
	}

	setClass(cls: string): this {
		this.buttonEl.addClass(cls);
		return this;
	}

	onClick(callback: (evt: MouseEvent) => unknown): this {
		this.clickHandler = callback;
		return this;
	}
}

export class ExtraButtonComponent extends BaseComponent {
	extraSettingsEl: HTMLElement;
	private clickHandler: (() => unknown) | null = null;

	constructor(containerEl: HTMLElement) {
		super();
		this.extraSettingsEl = containerEl.createDiv('clickable-icon extra-setting-button');
		this.extraSettingsEl.addEventListener('click', () => {
			if (!this.disabled) this.clickHandler?.();
		});
	}

	override setDisabled(disabled: boolean): this {
		super.setDisabled(disabled);
		this.extraSettingsEl.toggleClass('is-disabled', disabled);
		return this;
	}

	setTooltip(tooltip: string, options?: TooltipOptions): this {
		setTooltip(this.extraSettingsEl, tooltip, options);
		return this;
	}

	setIcon(icon: string): this {
		setIcon(this.extraSettingsEl, icon);
		return this;
	}

	onClick(callback: () => unknown): this {
		this.clickHandler = callback;
		return this;
	}
}

export class ToggleComponent extends ValueComponent<boolean> {
	toggleEl: HTMLElement;
	private value = false;
	private changeHandler: ((value: boolean) => unknown) | null = null;

	constructor(containerEl: HTMLElement) {
		super();
		this.toggleEl = containerEl.createDiv('checkbox-container');
		this.toggleEl.createEl('input', { type: 'checkbox', attr: { tabindex: 0 } });
		this.toggleEl.addEventListener('click', () => this.onClick());
	}

	override setDisabled(disabled: boolean): this {
		super.setDisabled(disabled);
		this.toggleEl.toggleClass('is-disabled', disabled);
		return this;
	}

	getValue(): boolean {
		return this.value;
	}

	setValue(on: boolean): this {
		const changed = this.value !== on;
		this.value = on;
		this.toggleEl.toggleClass('is-enabled', on);
		const input = this.toggleEl.querySelector('input');
		if (input) input.checked = on;
		if (changed) this.changeHandler?.(on);
		return this;
	}

	setTooltip(tooltip: string, options?: TooltipOptions): this {
		setTooltip(this.toggleEl, tooltip, options);
		return this;
	}

	onClick(): void {
		if (this.disabled) return;
		this.setValue(!this.value);
	}

	onChange(callback: (value: boolean) => unknown): this {
		this.changeHandler = callback;
		return this;
	}
}

export class AbstractTextComponent<T extends HTMLInputElement | HTMLTextAreaElement> extends ValueComponent<string> {
	inputEl: T;
	private changeHandler: ((value: string) => unknown) | null = null;

	constructor(inputEl: T) {
		super();
		this.inputEl = inputEl;
		this.inputEl.addEventListener('input', () => this.onChanged());
	}

	override setDisabled(disabled: boolean): this {
		super.setDisabled(disabled);
		this.inputEl.disabled = disabled;
		return this;
	}

	getValue(): string {
		return this.inputEl.value;
	}

	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}

	setPlaceholder(placeholder: string): this {
		this.inputEl.placeholder = placeholder;
		return this;
	}

	onChanged(): void {
		this.changeHandler?.(this.getValue());
	}

	onChange(callback: (value: string) => unknown): this {
		this.changeHandler = callback;
		return this;
	}
}

export class TextComponent extends AbstractTextComponent<HTMLInputElement> {
	constructor(containerEl: HTMLElement) {
		super(containerEl.createEl('input', { type: 'text', attr: { spellcheck: 'false' } }));
	}
}

export class TextAreaComponent extends AbstractTextComponent<HTMLTextAreaElement> {
	constructor(containerEl: HTMLElement) {
		super(containerEl.createEl('textarea', { attr: { spellcheck: 'false' } }));
	}
}

export class SearchComponent extends AbstractTextComponent<HTMLInputElement> {
	clearButtonEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		const wrapper = containerEl.createDiv('search-input-container');
		super(wrapper.createEl('input', { type: 'search', attr: { spellcheck: 'false', enterkeyhint: 'search' } }));
		this.clearButtonEl = wrapper.createDiv({ cls: 'search-input-clear-button', attr: { 'aria-label': 'Clear search' } });
		this.clearButtonEl.addEventListener('click', () => {
			this.setValue('');
			this.onChanged();
			this.inputEl.focus();
		});
		this.updateClearButton();
	}

	override setValue(value: string): this {
		super.setValue(value);
		this.updateClearButton();
		return this;
	}

	override onChanged(): void {
		this.updateClearButton();
		super.onChanged();
	}

	private updateClearButton(): void {
		this.clearButtonEl?.toggle(this.inputEl.value !== '');
	}
}

export class MomentFormatComponent extends TextComponent {
	sampleEl: HTMLElement;
	private defaultFormat = '';

	constructor(containerEl: HTMLElement) {
		super(containerEl);
		this.sampleEl = createSpan();
	}

	setDefaultFormat(defaultFormat: string): this {
		this.defaultFormat = defaultFormat;
		this.setPlaceholder(defaultFormat);
		this.updateSample();
		return this;
	}

	setSampleEl(sampleEl: HTMLElement): this {
		this.sampleEl = sampleEl;
		this.updateSample();
		return this;
	}

	override setValue(value: string): this {
		super.setValue(value);
		this.updateSample();
		return this;
	}

	override onChanged(): void {
		this.updateSample();
		super.onChanged();
	}

	updateSample(): void {
		this.sampleEl.setText(moment().format(this.getValue() || this.defaultFormat));
	}
}

export class DropdownComponent extends ValueComponent<string> {
	selectEl: HTMLSelectElement;
	private changeHandler: ((value: string) => unknown) | null = null;

	constructor(containerEl: HTMLElement) {
		super();
		this.selectEl = containerEl.createEl('select', 'dropdown');
		this.selectEl.addEventListener('change', () => this.changeHandler?.(this.getValue()));
	}

	override setDisabled(disabled: boolean): this {
		super.setDisabled(disabled);
		this.selectEl.disabled = disabled;
		return this;
	}

	addOption(value: string, display: string): this {
		this.selectEl.createEl('option', { value, text: display });
		return this;
	}

	addOptions(options: Record<string, string>): this {
		for (const [value, display] of Object.entries(options)) this.addOption(value, display);
		return this;
	}

	getValue(): string {
		return this.selectEl.value;
	}

	setValue(value: string): this {
		this.selectEl.value = value;
		return this;
	}

	onChange(callback: (value: string) => unknown): this {
		this.changeHandler = callback;
		return this;
	}
}

export class SliderComponent extends ValueComponent<number> {
	sliderEl: HTMLInputElement;
	private valueEl: HTMLElement;
	private instant = false;
	private format: (value: number) => string = (value) => String(value);
	private changeHandler: ((value: number) => unknown) | null = null;

	constructor(containerEl: HTMLElement) {
		super();
		this.sliderEl = containerEl.createEl('input', { type: 'range', cls: 'slider' });
		this.valueEl = containerEl.createSpan('slider-value');
		this.sliderEl.addEventListener('input', () => {
			this.updateValueEl();
			if (this.instant) this.changeHandler?.(this.getValue());
		});
		this.sliderEl.addEventListener('change', () => {
			if (!this.instant) this.changeHandler?.(this.getValue());
		});
		this.updateValueEl();
	}

	override setDisabled(disabled: boolean): this {
		super.setDisabled(disabled);
		this.sliderEl.disabled = disabled;
		return this;
	}

	setInstant(instant: boolean): this {
		this.instant = instant;
		return this;
	}

	setLimits(min: number | null, max: number | null, step: number | 'any'): this {
		if (min !== null) this.sliderEl.min = String(min);
		if (max !== null) this.sliderEl.max = String(max);
		this.sliderEl.step = String(step);
		this.updateValueEl();
		return this;
	}

	getValue(): number {
		return Number(this.sliderEl.value);
	}

	setValue(value: number): this {
		this.sliderEl.value = String(value);
		this.updateValueEl();
		return this;
	}

	getValuePretty(): string {
		return this.format(this.getValue());
	}

	setDisplayFormat(format: (value: number) => string): this {
		this.format = format;
		this.updateValueEl();
		return this;
	}

	setDynamicTooltip(): this {
		return this;
	}

	showTooltip(): void {}

	onChange(callback: (value: number) => unknown): this {
		this.changeHandler = callback;
		return this;
	}

	private updateValueEl(): void {
		this.valueEl.setText(this.getValuePretty());
	}
}

export interface RGB {
	r: number;
	g: number;
	b: number;
}

export interface HSL {
	h: number;
	s: number;
	l: number;
}

function hexToRgb(hex: string): RGB {
	const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16) || 0;
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }: RGB): string {
	return '#' + [r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('');
}

function rgbToHsl({ r, g, b }: RGB): HSL {
	const [rn, gn, bn] = [r / 255, g / 255, b / 255];
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	if (max === min) return { h: 0, s: 0, l: l * 100 };
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
	h *= 60;
	return { h, s: s * 100, l: l * 100 };
}

function hslToRgb({ h, s, l }: HSL): RGB {
	const sn = s / 100;
	const ln = l / 100;
	const k = (n: number) => (n + h / 30) % 12;
	const a = sn * Math.min(ln, 1 - ln);
	const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}

export class ColorComponent extends ValueComponent<string> {
	colorPickerEl: HTMLInputElement;
	private changeHandler: ((value: string) => unknown) | null = null;

	constructor(containerEl: HTMLElement) {
		super();
		this.colorPickerEl = containerEl.createEl('input', { type: 'color' });
		this.colorPickerEl.addEventListener('input', () => this.changeHandler?.(this.getValue()));
	}

	override setDisabled(disabled: boolean): this {
		super.setDisabled(disabled);
		this.colorPickerEl.disabled = disabled;
		return this;
	}

	getValue(): string {
		return this.colorPickerEl.value.toLowerCase();
	}

	getValueRgb(): RGB {
		return hexToRgb(this.getValue());
	}

	getValueHsl(): HSL {
		return rgbToHsl(this.getValueRgb());
	}

	setValue(value: string): this {
		this.colorPickerEl.value = value;
		return this;
	}

	setValueRgb(rgb: RGB): this {
		return this.setValue(rgbToHex(rgb));
	}

	setValueHsl(hsl: HSL): this {
		return this.setValue(rgbToHex(hslToRgb(hsl)));
	}

	onChange(callback: (value: string) => unknown): this {
		this.changeHandler = callback;
		return this;
	}
}

export class ProgressBarComponent extends ValueComponent<number> {
	private progressBar: HTMLElement;
	private lineEl: HTMLElement;
	private value = 0;

	constructor(containerEl: HTMLElement) {
		super();
		this.progressBar = containerEl.createDiv('setting-progress-bar');
		this.lineEl = this.progressBar.createDiv('setting-progress-bar-inner');
	}

	getValue(): number {
		return this.value;
	}

	setValue(value: number): this {
		this.value = Math.max(0, Math.min(100, value));
		this.lineEl.style.width = `${this.value}%`;
		return this;
	}
}

export class DisplayValueComponent {
	valueEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		this.valueEl = containerEl.createDiv('setting-display-value');
	}

	setValue(value: string | null): this {
		this.valueEl.setText(value ?? '');
		return this;
	}

	setStatus(status: 'warning' | null): this {
		this.valueEl.toggleClass('mod-warning', status === 'warning');
		return this;
	}
}

/** A password-style field. Secrets stay in memory for now; there is no keychain yet. */
export class SecretComponent extends BaseComponent {
	private inputEl: HTMLInputElement;
	private changeHandler: ((value: string | null) => unknown) | null = null;

	constructor(_app: App, containerEl: HTMLElement) {
		super();
		this.inputEl = containerEl.createEl('input', { type: 'password' });
		this.inputEl.addEventListener('input', () => this.changeHandler?.(this.inputEl.value || null));
	}

	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}

	onChange(cb: (value: string | null) => unknown): this {
		this.changeHandler = cb;
		return this;
	}
}

export class Setting {
	settingEl: HTMLElement;
	infoEl: HTMLElement;
	nameEl: HTMLElement;
	descEl: HTMLElement;
	controlEl: HTMLElement;
	components: BaseComponent[] = [];
	errorEl: HTMLElement | null = null;

	constructor(containerEl: HTMLElement) {
		this.settingEl = containerEl.createDiv('setting-item');
		this.infoEl = this.settingEl.createDiv('setting-item-info');
		this.nameEl = this.infoEl.createDiv('setting-item-name');
		this.descEl = this.infoEl.createDiv('setting-item-description');
		this.controlEl = this.settingEl.createDiv('setting-item-control');
	}

	setErrorMessage(message: string | null): this {
		if (message === null) {
			this.errorEl?.detach();
			this.errorEl = null;
		} else {
			this.errorEl ??= this.infoEl.createDiv('setting-item-error');
			this.errorEl.setText(message);
		}
		this.settingEl.toggleClass('has-error', message !== null);
		return this;
	}

	addDisplayValue(cb: (component: DisplayValueComponent) => unknown): this {
		cb(new DisplayValueComponent(this.controlEl));
		return this;
	}

	setName(name: string | DocumentFragment): this {
		this.nameEl.setText(name);
		return this;
	}

	setDesc(desc: string | DocumentFragment): this {
		this.descEl.setText(desc);
		return this;
	}

	setClass(cls: string): this {
		this.settingEl.addClass(cls);
		return this;
	}

	setTooltip(tooltip: string, options?: TooltipOptions): this {
		setTooltip(this.nameEl, tooltip, options);
		return this;
	}

	setHeading(): this {
		this.settingEl.addClass('setting-item-heading');
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.settingEl.toggleClass('is-disabled', disabled);
		for (const component of this.components) component.setDisabled(disabled);
		return this;
	}

	private add<T extends BaseComponent>(component: T, cb: (component: T) => unknown): this {
		this.components.push(component);
		cb(component);
		return this;
	}

	addButton(cb: (component: ButtonComponent) => unknown): this {
		return this.add(new ButtonComponent(this.controlEl), cb);
	}

	addExtraButton(cb: (component: ExtraButtonComponent) => unknown): this {
		return this.add(new ExtraButtonComponent(this.controlEl), cb);
	}

	addToggle(cb: (component: ToggleComponent) => unknown): this {
		return this.add(new ToggleComponent(this.controlEl), cb);
	}

	addText(cb: (component: TextComponent) => unknown): this {
		return this.add(new TextComponent(this.controlEl), cb);
	}

	addComponent<T extends BaseComponent>(cb: (el: HTMLElement) => T): this {
		this.components.push(cb(this.controlEl));
		return this;
	}

	addSearch(cb: (component: SearchComponent) => unknown): this {
		return this.add(new SearchComponent(this.controlEl), cb);
	}

	addTextArea(cb: (component: TextAreaComponent) => unknown): this {
		return this.add(new TextAreaComponent(this.controlEl), cb);
	}

	addMomentFormat(cb: (component: MomentFormatComponent) => unknown): this {
		return this.add(new MomentFormatComponent(this.controlEl), cb);
	}

	addDropdown(cb: (component: DropdownComponent) => unknown): this {
		return this.add(new DropdownComponent(this.controlEl), cb);
	}

	addColorPicker(cb: (component: ColorComponent) => unknown): this {
		return this.add(new ColorComponent(this.controlEl), cb);
	}

	addProgressBar(cb: (component: ProgressBarComponent) => unknown): this {
		return this.add(new ProgressBarComponent(this.controlEl), cb);
	}

	addSlider(cb: (component: SliderComponent) => unknown): this {
		return this.add(new SliderComponent(this.controlEl), cb);
	}

	then(cb: (setting: this) => unknown): this {
		cb(this);
		return this;
	}

	clear(): this {
		this.controlEl.empty();
		this.components = [];
		return this;
	}
}

/** A titled group of settings (`.setting-group`). */
export class SettingGroup {
	listEl: HTMLElement;
	private groupEl: HTMLElement;
	private headerEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		this.groupEl = containerEl.createDiv('setting-group');
		this.headerEl = this.groupEl.createDiv('setting-item setting-item-heading');
		this.headerEl.hide();
		this.listEl = this.groupEl.createDiv('setting-items');
	}

	setHeading(text: string | DocumentFragment): this {
		this.headerEl.empty();
		this.headerEl.createDiv('setting-item-name').setText(text);
		this.headerEl.show();
		return this;
	}

	addClass(...classes: string[]): this {
		this.groupEl.addClass(...classes);
		return this;
	}

	addSetting(cb: (setting: Setting) => void): this {
		cb(new Setting(this.listEl));
		return this;
	}

	addSearch(cb: (component: SearchComponent) => unknown): this {
		cb(new SearchComponent(this.headerEl));
		this.headerEl.show();
		return this;
	}

	addExtraButton(cb: (component: ExtraButtonComponent) => unknown): this {
		cb(new ExtraButtonComponent(this.headerEl));
		this.headerEl.show();
		return this;
	}
}
