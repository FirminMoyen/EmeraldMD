/** Every tag in the vault with its note count, nested by `/` (right sidebar). */

import { debounce, ItemView, setIcon, type WorkspaceLeaf } from '@emeraldmd/api';
import { tagsOf } from '@emeraldmd/graph';
import type { CoreViewHost } from './host';

export const TAGS_VIEW = 'tag';

interface TagNode {
	name: string;
	/** Full tag with `#`, e.g. `#project/alpha`. */
	tag: string;
	/** Notes with this tag or a nested one. */
	count: number;
	children: Map<string, TagNode>;
}

export class TagsView extends ItemView {
	private readonly refresh = debounce(() => this.render(), 500, true);
	private readonly collapsed = new Set<string>();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: CoreViewHost,
	) {
		super(leaf);
		this.icon = 'tags';
	}

	getViewType(): string {
		return TAGS_VIEW;
	}

	getDisplayText(): string {
		return 'Tags';
	}

	protected override async onOpen(): Promise<void> {
		this.contentEl.addClass('tag-container');
		this.registerEvent(this.app.metadataCache.on('resolved', () => this.refresh()));
		this.render();
	}

	private collect(): TagNode {
		const root: TagNode = { name: '', tag: '', count: 0, children: new Map() };
		for (const file of this.app.vault.getMarkdownFiles()) {
			const seen = new Set<string>();
			for (const tag of tagsOf(this.app.metadataCache, file)) {
				let node = root;
				let path = '';
				for (const part of tag.replace(/^#/, '').split('/')) {
					path = path ? `${path}/${part}` : part;
					const key = part.toLowerCase();
					let child = node.children.get(key);
					if (!child) {
						child = { name: part, tag: `#${path}`, count: 0, children: new Map() };
						node.children.set(key, child);
					}
					// A note counts once per tag node, however often it uses the tag.
					if (!seen.has(child.tag.toLowerCase())) {
						seen.add(child.tag.toLowerCase());
						child.count++;
					}
					node = child;
				}
			}
		}
		return root;
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		const tree = this.collect();
		if (!tree.children.size) {
			root.createDiv({ cls: 'pane-empty', text: 'No tags yet.' });
			return;
		}
		this.renderLevel(root, tree, 0);
	}

	private renderLevel(parent: HTMLElement, node: TagNode, depth: number): void {
		const children = [...node.children.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
		for (const child of children) {
			const item = parent.createDiv('tree-item tag-pane-tag');
			const self = item.createDiv('tree-item-self is-clickable');
			self.style.paddingInlineStart = `${8 + depth * 16}px`;
			const collapsed = this.collapsed.has(child.tag);
			if (child.children.size) {
				const toggle = self.createDiv('tree-item-icon collapse-icon');
				setIcon(toggle, collapsed ? 'chevron-right' : 'chevron-down');
				toggle.addEventListener('click', (e) => {
					e.stopPropagation();
					if (collapsed) this.collapsed.delete(child.tag);
					else this.collapsed.add(child.tag);
					this.render();
				});
			}
			self.createDiv({ cls: 'tree-item-inner tag-pane-tag-text', text: `#${child.name}` });
			self.createDiv({ cls: 'tree-item-flair tag-pane-tag-count', text: String(child.count) });
			self.addEventListener('click', () => void this.host.openSearch(`tag:${child.tag}`));
			if (child.children.size && !collapsed) this.renderLevel(item.createDiv('tree-item-children'), child, depth + 1);
		}
	}
}
