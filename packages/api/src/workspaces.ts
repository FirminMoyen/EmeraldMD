/**
 * Workspaces (core plugin `workspaces`): layouts of tabs and splits saved
 * under a name, to switch between. Kept in `.obsidian/workspaces.json` as
 * Obsidian does, `{ workspaces: { name: layout }, active: name }`, each
 * layout in `workspace.getLayout()`'s format, so Obsidian reads them too.
 */

import type { App } from './app';
import { confirmAction } from './confirm';
import { InternalPluginInstance } from './core-plugins';
import { Modal } from './modal';
import { Notice } from './notice';
import { prepareFuzzySearch, renderResults } from './search';
import { SuggestModal } from './suggest';

interface WorkspacesData {
	workspaces: Record<string, unknown>;
	active: string;
}

export class Workspaces extends InternalPluginInstance {
	readonly id = 'workspaces';
	readonly name = 'Workspaces';
	readonly description = 'Save layouts of tabs and splits under a name, and switch between them.';
	data: WorkspacesData = { workspaces: {}, active: '' };

	private get path(): string {
		return `${this.app.vault.configDir}/workspaces.json`;
	}

	onEnable(): void {
		void this.loadData();
		this.addCommand({ id: 'workspaces:open-modal', name: 'Workspaces: Manage workspace layouts', callback: () => new WorkspacesModal(this.app, this).open() });
		this.addCommand({
			id: 'workspaces:load',
			name: 'Workspaces: Load workspace layout',
			checkCallback: (checking) => {
				if (!Object.keys(this.data.workspaces).length) return false;
				if (!checking) new WorkspacePicker(this.app, this).open();
				return true;
			},
		});
		this.addCommand({
			id: 'workspaces:save',
			name: 'Workspaces: Save current workspace layout',
			checkCallback: (checking) => {
				if (!this.data.active) return false;
				if (!checking) void this.save(this.data.active);
				return true;
			},
		});
		this.addRibbonIcon('layout-dashboard', 'Manage workspace layouts', () => new WorkspacesModal(this.app, this).open());
	}

	async loadData(): Promise<void> {
		try {
			if (!(await this.app.vault.adapter.exists(this.path))) return;
			const data = JSON.parse(await this.app.vault.adapter.read(this.path)) as Partial<WorkspacesData>;
			this.data = {
				workspaces: data.workspaces && typeof data.workspaces === 'object' ? data.workspaces : {},
				active: typeof data.active === 'string' ? data.active : '',
			};
		} catch (err) {
			console.error(`Could not read ${this.path}`, err);
		}
	}

	private async write(): Promise<void> {
		await this.app.vault.adapter.write(this.path, JSON.stringify(this.data, null, 2));
	}

	/** Saves the current layout as `name` (replacing one of that name). */
	async save(name: string): Promise<void> {
		this.data.workspaces[name] = this.app.workspace.getLayout();
		this.data.active = name;
		await this.write();
		new Notice(`Saved the layout "${name}".`);
	}

	/** Shows the layout saved as `name`. */
	async load(name: string): Promise<void> {
		const layout = this.data.workspaces[name];
		if (!layout) return;
		await this.app.workspace.changeLayout(layout);
		this.data.active = name;
		await this.write();
	}

	async delete(name: string): Promise<void> {
		delete this.data.workspaces[name];
		if (this.data.active === name) this.data.active = '';
		await this.write();
	}
}

/** Picks a saved layout to load. */
class WorkspacePicker extends SuggestModal<string> {
	constructor(
		app: App,
		private readonly plugin: Workspaces,
	) {
		super(app);
		this.setPlaceholder('Load a workspace layout…');
	}

	getSuggestions(query: string): string[] {
		const search = prepareFuzzySearch(query);
		return Object.keys(this.plugin.data.workspaces).filter((name) => search(name));
	}

	renderSuggestion(name: string, el: HTMLElement): void {
		const match = prepareFuzzySearch(this.inputEl.value)(name) ?? { score: 0, matches: [] };
		renderResults(el.createDiv('suggestion-content'), name, match);
		if (name === this.plugin.data.active) el.createDiv({ cls: 'suggestion-flair', text: 'current' });
	}

	onChooseSuggestion(name: string): void {
		void this.plugin.load(name);
	}
}

/** Save the current layout under a name; load or delete saved ones. */
class WorkspacesModal extends Modal {
	constructor(
		app: App,
		private readonly plugin: Workspaces,
	) {
		super(app);
		this.modalEl.addClass('mod-workspaces');
	}

	override onOpen(): void {
		this.titleEl.setText('Workspace layouts');
		this.render();
	}

	private render(): void {
		const { contentEl, plugin } = this;
		contentEl.empty();
		const form = contentEl.createDiv('workspaces-save');
		const input = form.createEl('input', { cls: 'workspaces-name', attr: { type: 'text', placeholder: 'Name of the current layout…', spellcheck: 'false' } });
		input.value = plugin.data.active;
		const saveButton = form.createEl('button', { cls: 'mod-cta', text: 'Save' });
		const save = async () => {
			const name = input.value.trim();
			if (!name) return;
			await plugin.save(name);
			this.render();
		};
		saveButton.addEventListener('click', () => void save());
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') void save();
		});
		const list = contentEl.createDiv('workspaces-list');
		const names = Object.keys(plugin.data.workspaces).sort((a, b) => a.localeCompare(b));
		if (!names.length) list.createDiv({ cls: 'workspaces-empty', text: 'No saved layouts yet. Name the current one above to save it.' });
		for (const name of names) {
			const row = list.createDiv({ cls: ['workspaces-item', ...(name === plugin.data.active ? ['is-active'] : [])] });
			row.createDiv({ cls: 'workspaces-item-name', text: name });
			const load = row.createEl('button', { text: 'Load' });
			load.addEventListener('click', async () => {
				this.close();
				await plugin.load(name);
			});
			const remove = row.createEl('button', { cls: 'mod-warning', text: 'Delete' });
			remove.addEventListener('click', async () => {
				const ok = await confirmAction(this.app, { title: 'Delete layout?', message: `The layout "${name}" is deleted.`, confirm: 'Delete' });
				if (!ok) return;
				await plugin.delete(name);
				this.render();
			});
		}
	}
}
