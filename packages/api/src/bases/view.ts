/**
 * `BasesView`, the class Bases views extend (EmeraldMD's table, cards and
 * list, and plugins' views registered with `registerBasesView`), and what
 * they share: drawing a value, and editing a note property in place.
 */

import type { TFile } from '@emeraldmd/core';
import type { App } from '../app';
import { Component } from '../component';
import type { BasesEntry, BasesPropertyId, BasesQueryResult, BasesViewConfig, QueryController } from './query';
import { parsePropertyId } from './query';
import { rawProperty } from './formula';
import { BooleanValue, ErrorValue, FileValue, NullValue, type Value } from './values';

export interface BasesOption {
	key: string;
	type: string;
	displayName: string;
	shouldHide?: () => boolean;
	default?: unknown;
	placeholder?: string;
	options?: Record<string, string>;
	min?: number;
	max?: number;
	step?: number;
	instant?: boolean;
	filter?: (value: never) => boolean;
}

export interface BasesOptionGroup {
	type: 'group';
	displayName: string;
	items: BasesOption[];
	shouldHide?: () => boolean;
}

export type BasesAllOptions = BasesOption | BasesOptionGroup;

export type BasesViewFactory = (controller: QueryController, containerEl: HTMLElement) => BasesView;

export interface BasesViewRegistration {
	name: string;
	icon: string;
	factory: BasesViewFactory;
	options?: (config: BasesViewConfig) => BasesAllOptions[];
}

export abstract class BasesView extends Component {
	abstract type: string;
	app: App;
	config: BasesViewConfig;
	allProperties: BasesPropertyId[];
	data: BasesQueryResult;
	/** @internal */
	controller: QueryController;

	protected constructor(controller: QueryController, _containerEl?: HTMLElement) {
		super();
		this.controller = controller;
		this.app = controller.app;
		this.config = controller.viewConfig;
		this.allProperties = controller.allProperties;
		this.data = controller.result;
	}

	abstract onDataUpdated(): void;

	async createFileForView(baseFileName?: string, frontmatterProcessor?: (frontmatter: Record<string, unknown>, file: TFile) => void): Promise<void> {
		await this.controller.createFile(baseFileName, frontmatterProcessor);
	}
}

/** The property ids a view shows: its `order`, or the file name. */
export function shownProperties(view: BasesView): BasesPropertyId[] {
	const order = view.config.getOrder();
	return order.length ? order : ['file.name'];
}

/** Draws `prop` of `entry`: the file's name as a link to it, other values as they render. */
export function renderProperty(app: App, el: HTMLElement, entry: BasesEntry, prop: BasesPropertyId): Value {
	const { type, name } = parsePropertyId(prop);
	const value = entry.getValue(prop) ?? NullValue.value;
	if (type === 'file' && (name === 'name' || name === 'basename' || name === 'file')) {
		new FileValue(entry.file).renderTo(el, app.renderContext);
		return value;
	}
	if (value instanceof ErrorValue) el.addClass('mod-error');
	value.renderTo(el, app.renderContext);
	return value;
}

/** Whether `prop` of `entry` is a note property that can be edited in place. */
export function isEditable(entry: BasesEntry, prop: BasesPropertyId): boolean {
	return parsePropertyId(prop).type === 'note' && entry.file.extension === 'md';
}

/** The text shown while editing a property: lists as comma-separated items. */
function editText(raw: unknown): string {
	if (raw === null || raw === undefined) return '';
	if (Array.isArray(raw)) return raw.map((item) => String(item ?? '')).join(', ');
	if (typeof raw === 'object') return JSON.stringify(raw);
	return String(raw);
}

/** The value to store for `text` typed for property `name`, by its type (or what it held before). */
export function parsePropertyInput(app: App, name: string, text: string, previous: unknown): unknown {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const type = app.metadataTypeManager.getAssignedType(name);
	if (type === 'number' || (!type && typeof previous === 'number')) {
		const n = Number(trimmed);
		return Number.isFinite(n) ? n : trimmed;
	}
	if (type === 'checkbox' || (!type && typeof previous === 'boolean')) return /^(true|yes|1)$/i.test(trimmed);
	if (type === 'multitext' || type === 'tags' || type === 'aliases' || (!type && Array.isArray(previous))) {
		return trimmed
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	}
	return text;
}

/** Edits `prop` of `entry` in `el`: a checkbox toggles, other values become a text field until Enter or blur. */
export function editProperty(app: App, el: HTMLElement, entry: BasesEntry, prop: BasesPropertyId, onDone: () => void): void {
	const { name } = parsePropertyId(prop);
	const previous = rawProperty(app, entry.file, name);
	const save = (value: unknown) =>
		app.fileManager
			.processFrontMatter(entry.file, (fm) => {
				const key = Object.keys(fm).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
				fm[key] = value;
			})
			.catch((err: unknown) => console.error(err));
	el.empty();
	el.addClass('is-editing');
	const input = el.createEl('input', { cls: 'bases-cell-input', attr: { type: 'text', spellcheck: 'false' } });
	input.value = editText(previous);
	let finished = false;
	const finish = (commit: boolean) => {
		if (finished) return;
		finished = true;
		el.removeClass('is-editing');
		if (commit && input.value !== editText(previous)) void save(parsePropertyInput(app, name, input.value, previous));
		onDone();
	};
	input.addEventListener('keydown', (evt) => {
		if (evt.key === 'Enter') {
			evt.preventDefault();
			finish(true);
		} else if (evt.key === 'Escape') {
			evt.preventDefault();
			finish(false);
		}
		evt.stopPropagation();
	});
	input.addEventListener('blur', () => finish(true));
	input.focus();
	input.select();
}

/** Makes a rendered checkbox of a note property toggle it. */
export function wireCheckbox(app: App, el: HTMLElement, entry: BasesEntry, prop: BasesPropertyId, value: Value): boolean {
	if (!(value instanceof BooleanValue) || !isEditable(entry, prop)) return false;
	const box = el.querySelector<HTMLInputElement>('input[type=checkbox]');
	if (!box) return false;
	box.disabled = false;
	box.addEventListener('click', (evt) => evt.stopPropagation());
	box.addEventListener('change', () => {
		const { name } = parsePropertyId(prop);
		void app.fileManager.processFrontMatter(entry.file, (fm) => {
			const key = Object.keys(fm).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
			fm[key] = box.checked;
		});
	});
	return true;
}
