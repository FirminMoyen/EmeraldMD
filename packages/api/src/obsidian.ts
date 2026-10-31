/**
 * The `obsidian` module as plugins see it: `require('obsidian')` returns
 * this module's exports. Names and shapes follow the public typings
 * (`obsidian@1.14.4`, MIT); docs/compat/api-coverage.md lists what is
 * implemented, partial or missing.
 */

import type { App } from './app';
import { Component } from './component';
import { Modal } from './modal';
import { ButtonComponent } from './setting';
import { WorkspaceParent } from './workspace';

export { Events, getLinkpath, MetadataCache, normalizePath, parseLinktext, TAbstractFile, TFile, TFolder } from '@emeraldmd/core';
export { CapacitorAdapter, FileSystemAdapter } from './adapter';
export { App, RenderContext, SecretStorage, Tasks } from './app';
export { Component } from './component';
export { Editor, editorEditorField, editorInfoField, editorLivePreviewField, editorViewField, livePreviewState } from './editor';
export { FileManager } from './file-manager';
export { addIcon, getIcon, getIconIds, removeIcon, setIcon } from './icons';
export { Keymap, Scope } from './keymap';
export { MarkdownPreviewRenderer, MarkdownRenderChild, MarkdownRenderer } from './markdown';
export { Menu, MenuItem, MenuSeparator } from './menu';
export { Modal } from './modal';
export { moment } from './moment';
export { Notice } from './notice';
export { Platform } from './platform';
export { Plugin } from './plugin';
export { request, requestUrl } from './request';
export { prepareFuzzySearch, prepareSimpleSearch, renderMatches, renderResults, sortSearchResults } from './search';
export {
	AbstractTextComponent,
	BaseComponent,
	ButtonComponent,
	ColorComponent,
	DisplayValueComponent,
	DropdownComponent,
	ExtraButtonComponent,
	MomentFormatComponent,
	ProgressBarComponent,
	SearchComponent,
	SecretComponent,
	Setting,
	SettingGroup,
	SliderComponent,
	TextAreaComponent,
	TextComponent,
	ToggleComponent,
	ValueComponent,
} from './setting';
export { PluginSettingTab, SettingTab } from './setting-tab';
export { AbstractInputSuggest, EditorSuggest, FuzzySuggestModal, PopoverSuggest, SuggestModal } from './suggest';
export { displayTooltip, setTooltip } from './tooltip';
export {
	apiVersion,
	arrayBufferToBase64,
	arrayBufferToHex,
	base64ToArrayBuffer,
	debounce,
	getAllTags,
	getBlobArrayBuffer,
	getFrontMatterInfo,
	getLanguage,
	hexToArrayBuffer,
	htmlToMarkdown,
	iterateCacheRefs,
	iterateRefs,
	parseFrontMatterAliases,
	parseFrontMatterEntry,
	parseFrontMatterStringArray,
	parseFrontMatterTags,
	parseYaml,
	requireApiVersion,
	resolveSubpath,
	sanitizeHTMLToDom,
	stringifyYaml,
	stripHeading,
	stripHeadingForLink,
} from './util';
export { Vault } from './vault';
export { EditableFileView, FileView, ItemView, MarkdownView, TextFileView, View } from './views';
export type { MarkdownPreviewView } from './views';
export { Workspace, WorkspaceItem, WorkspaceLeaf, WorkspaceParent, WorkspaceRibbon, WorkspaceRoot, WorkspaceSidedock } from './workspace';

export type { DataAdapter, DataWriteOptions, ListedFiles, Stat } from './adapter';
export type { UserEvent } from './app';
export type { Command } from './commands';
export type {
	EditorChange,
	EditorCommandName,
	EditorPosition,
	EditorRange,
	EditorRangeOrCaret,
	EditorSelection,
	EditorSelectionOrCaret,
	EditorTransaction,
	MarkdownFileInfo,
} from './editor';
export type { Hotkey, KeymapContext, KeymapEventHandler, KeymapEventListener, KeymapInfo, Modifier } from './keymap';
export type { MarkdownPostProcessor, MarkdownPostProcessorContext, MarkdownSectionInformation } from './markdown';
export type { MenuPositionDef } from './menu';
export type { HoverLinkSource, ObsidianProtocolData, ObsidianProtocolHandler, PluginManifest } from './plugin';
export type { RequestUrlParam, RequestUrlResponse, RequestUrlResponsePromise } from './request';
export type { SearchMatches, SearchMatchPart, SearchResult, SearchResultContainer } from './search';
export type { HSL, RGB } from './setting';
export type { SettingDefinition, SettingDefinitionItem } from './setting-tab';
export type { EditorSuggestContext, EditorSuggestTriggerInfo, FuzzyMatch, Instruction, ISuggestOwner } from './suggest';
export type { TooltipOptions, TooltipPlacement } from './tooltip';
export type { Debouncer, FrontMatterInfo } from './util';
export type { MarkdownSubView, MarkdownViewModeType, ViewStateResult } from './views';
export type { OpenViewState, PaneType, Side, SplitDirection, ViewCreator, ViewState } from './workspace';

/** Layout containers EmeraldMD does not have yet; exported so `instanceof` checks work. */
export class WorkspaceSplit extends WorkspaceParent {
	parent = null;
}
export class WorkspaceTabs extends WorkspaceParent {
	parent = null;
}
export class WorkspaceContainer extends WorkspaceSplit {}
export class WorkspaceWindow extends WorkspaceContainer {}
export class WorkspaceFloating extends WorkspaceParent {
	parent = null;
}
export class WorkspaceMobileDrawer extends WorkspaceParent {
	parent = null;
	collapsed = true;

	expand(): void {
		this.collapsed = false;
	}

	collapse(): void {
		this.collapsed = true;
	}

	toggle(): void {
		this.collapsed = !this.collapsed;
	}
}

export { HoverPopover, PopoverState, type HoverParent, type Point } from './hover-popover';

/** A file outside the vault. */
export class TExternalFile {
	path: string;
	name: string;

	constructor(path: string) {
		this.path = path;
		this.name = path.slice(path.lastIndexOf('/') + 1);
	}

	getRealPath(): string {
		return this.path;
	}
}

export class ConfirmationButton extends ButtonComponent {
	setInitialFocus(): this {
		queueMicrotask(() => this.buttonEl.focus());
		return this;
	}

	setSecondary(): this {
		this.buttonEl.addClass('mod-secondary');
		return this;
	}

	setCancel(): this {
		this.buttonEl.addClass('mod-cancel');
		return this;
	}
}

/** A dialog with a message and a row of buttons. */
export class ConfirmationModal extends Modal {
	buttonContainerEl: HTMLElement;

	constructor(app: App) {
		super(app);
		this.modalEl.addClass('mod-confirmation');
		this.buttonContainerEl = this.modalEl.createDiv('modal-button-container');
	}

	addClass(cls: string): this {
		this.modalEl.addClass(cls);
		return this;
	}

	addCheckbox(label: string, cb: (value: boolean) => unknown): this {
		const el = this.buttonContainerEl.createEl('label', { cls: 'mod-checkbox' });
		const input = el.createEl('input', { type: 'checkbox' });
		el.appendText(label);
		input.addEventListener('change', () => void cb(input.checked));
		return this;
	}

	addButton(cb: (btn: ConfirmationButton) => unknown): this {
		const button = new ConfirmationButton(this.buttonContainerEl);
		cb(button);
		button.buttonEl.addEventListener('click', () => this.close());
		return this;
	}

	addCancelButton(text = 'Cancel'): this {
		return this.addButton((b) => b.setButtonText(text).setCancel());
	}
}

/** A full-page settings screen (API 1.13). */
export abstract class SettingPage {
	rootEl: HTMLElement;
	titlebarEl: HTMLElement;
	containerEl: HTMLElement;
	title = '';

	constructor() {
		this.rootEl = createDiv('setting-page');
		this.titlebarEl = this.rootEl.createDiv('setting-page-titlebar');
		this.containerEl = this.rootEl.createDiv('setting-page-content');
	}

	abstract display(): void;

	hide(): void {
		this.containerEl.empty();
	}
}

export { BasesView } from './bases/view';
export { BasesEntry, BasesEntryGroup, BasesQueryResult, BasesViewConfig, parsePropertyId, QueryController } from './bases/query';
export {
	BooleanValue,
	DateValue,
	DurationValue,
	FileValue,
	HTMLValue,
	IconValue,
	ImageValue,
	LinkValue,
	ListValue,
	NotNullValue,
	NullValue,
	NumberValue,
	ObjectValue,
	PrimitiveValue,
	RegExpValue,
	RelativeDateValue,
	StringValue,
	TagValue,
	UrlValue,
	Value,
} from './bases/values';

function unavailable(name: string): Promise<never> {
	return Promise.reject(new Error(`${name} is not available in EmeraldMD yet`));
}

export function loadPdfJs(): Promise<never> {
	return unavailable('PDF.js');
}

export function loadPrism(): Promise<never> {
	return unavailable('Prism');
}

export { finishRenderMath, loadMathJax, renderMath } from './math';
export { loadMermaid } from './diagrams';
