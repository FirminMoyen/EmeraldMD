/**
 * Tabs in the main area. Each tab remembers its note, the editor's state
 * (text, selection, undo history), its scroll position, reading or editing
 * mode, and its own back/forward history; the shell shows one at a time in
 * the single note view.
 *
 * DOM as themes expect it: `.workspace-tab-header-container >
 * .workspace-tab-header-container-inner > .workspace-tab-header(.is-active) >
 * .workspace-tab-header-inner > (-icon, -title, -close-button)`, then
 * `.workspace-tab-header-new-tab`.
 */

import { setIcon, setTooltip, type ViewState } from '@emeraldmd/api';
import type { TFile } from '@emeraldmd/core';
import type { EditorState } from '@codemirror/state';

export interface Tab {
	file: TFile | null;
	/** The editor's state while the tab is in the background. */
	state: EditorState | null;
	scroll: number;
	mode: 'source' | 'preview';
	history: { back: TFile[]; forward: TFile[] };
	/** What the root leaf shows when it is not the note editor: another kind of file (canvas) or a plugin's view. */
	viewState: ViewState | null;
	/** Title and icon of such a view, for the tab header. */
	title?: string;
	icon?: string;
	/** When the tab was last current; closing the current tab goes back to the most recent other one. */
	lastActive: number;
}

export interface TabBarHost {
	activate(tab: Tab): void;
	close(tab: Tab): void;
	newTab(): void;
}

export function emptyTab(mode: Tab['mode'] = 'source'): Tab {
	return { file: null, state: null, scroll: 0, mode, history: { back: [], forward: [] }, viewState: null, lastActive: 0 };
}

/** Whether a tab shows nothing ("New tab"). */
export function isEmptyTab(tab: Tab): boolean {
	return !tab.file && !tab.viewState;
}

export class TabBar {
	tabs: Tab[] = [];
	active: Tab | null = null;
	readonly containerEl: HTMLElement;
	private readonly innerEl: HTMLElement;

	constructor(private readonly host: TabBarHost) {
		this.containerEl = createDiv('workspace-tab-header-container');
		this.innerEl = this.containerEl.createDiv('workspace-tab-header-container-inner');
		const add = this.containerEl.createDiv('workspace-tab-header-new-tab').createDiv({ cls: 'clickable-icon', attr: { 'aria-label': 'New tab' } });
		setIcon(add, 'plus');
		setTooltip(add, 'New tab (⌘T)');
		add.addEventListener('click', () => host.newTab());
	}

	render(): void {
		this.innerEl.empty();
		for (const tab of this.tabs) {
			const type = tab.viewState?.type ?? (tab.file ? 'markdown' : 'empty');
			const header = this.innerEl.createDiv({ cls: ['workspace-tab-header', 'tappable', ...(tab === this.active ? ['is-active', 'mod-active'] : [])], attr: { 'data-type': type } });
			const inner = header.createDiv('workspace-tab-header-inner');
			setIcon(inner.createDiv('workspace-tab-header-inner-icon'), tab.icon ?? (type === 'markdown' ? 'file-text' : type === 'canvas' ? 'layout-dashboard' : 'file'));
			const title = tab.file ? (tab.file.extension === 'md' ? tab.file.basename : tab.file.name) : (tab.title ?? 'New tab');
			inner.createDiv({ cls: 'workspace-tab-header-inner-title', text: title });
			header.setAttribute('aria-label', tab.file?.path ?? title);
			const close = inner.createDiv({ cls: 'workspace-tab-header-inner-close-button', attr: { 'aria-label': 'Close' } });
			setIcon(close, 'x');
			close.addEventListener('click', (event) => {
				event.stopPropagation();
				this.host.close(tab);
			});
			header.addEventListener('mousedown', (event) => {
				// Middle click closes, as in browsers and Obsidian.
				if (event.button === 1) {
					event.preventDefault();
					this.host.close(tab);
				}
			});
			header.addEventListener('click', () => this.host.activate(tab));
		}
		this.innerEl.querySelector('.workspace-tab-header.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	/** The tab before or after `tab` (for Ctrl+Tab), wrapping around. */
	neighbour(tab: Tab, step: 1 | -1): Tab {
		const i = this.tabs.indexOf(tab);
		return this.tabs[(i + step + this.tabs.length) % this.tabs.length]!;
	}
}
