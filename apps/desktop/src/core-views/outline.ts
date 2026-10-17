/** Headings of the active note (right sidebar); click to jump. */

import { debounce, ItemView, type WorkspaceLeaf } from '@emeraldmd/api';
import type { TFile } from '@emeraldmd/core';
import type { CoreViewHost } from './host';

export const OUTLINE_VIEW = 'outline';

export class OutlineView extends ItemView {
	private readonly refresh = debounce(() => this.render(), 200, true);

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: CoreViewHost,
	) {
		super(leaf);
		this.icon = 'list';
	}

	getViewType(): string {
		return OUTLINE_VIEW;
	}

	getDisplayText(): string {
		return 'Outline';
	}

	protected override async onOpen(): Promise<void> {
		this.contentEl.addClass('outline-view');
		this.registerEvent(this.app.workspace.on('file-open', () => this.render()));
		this.registerEvent(
			this.app.metadataCache.on('changed', (file: TFile) => {
				if (file === this.app.workspace.getActiveFile()) this.refresh();
			}),
		);
		this.render();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		const file = this.app.workspace.getActiveFile();
		const headings = file ? (this.app.metadataCache.getFileCache(file)?.headings ?? []) : [];
		if (!file || !headings.length) {
			root.createDiv({ cls: 'pane-empty', text: file ? 'No headings in this note.' : 'No note is open.' });
			return;
		}
		const minLevel = Math.min(...headings.map((h) => h.level));
		for (const heading of headings) {
			const row = root.createDiv('tree-item-self outline-item is-clickable');
			row.style.paddingInlineStart = `${8 + (heading.level - minLevel) * 16}px`;
			row.setText(heading.heading);
			row.addEventListener('click', () => {
				const at = heading.position.start.offset;
				void this.host.openFile(file, { from: at, to: at });
			});
		}
	}
}
