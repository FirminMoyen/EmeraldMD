/**
 * Note composer (core plugin `note-composer`): merge a note into another,
 * or extract a selection or a heading's section into a note.
 *
 * Merging appends the note's text to the other one (properties are merged:
 * missing keys added, lists joined), points the links to it at the other
 * one, and moves it to the trash. Extracting moves the text into a new note
 * (from an optional template) or to the end of an existing one, and leaves a
 * link, an embed, or nothing in its place. Options in
 * `.obsidian/note-composer.json`: `replacementText` (`link`, `embed`,
 * `none`), `template` (a note path), `askBeforeMerging`.
 */

import { normalizePath, TFile, type TAbstractFile } from '@emeraldmd/core';
import type { App } from './app';
import { confirmAction } from './confirm';
import { applyTemplateVariables, InternalPluginInstance } from './core-plugins';
import type { Editor } from './editor';
import type { Menu } from './menu';
import { moment } from './moment';
import { Notice } from './notice';
import { prepareFuzzySearch, renderResults, sortSearchResults, type SearchResult } from './search';
import { SuggestModal } from './suggest';
import { getFrontMatterInfo, parseYaml } from './util';

type Target = { file: TFile; match: SearchResult | null } | { create: string };

/** Picks a note, or (for extracting) a new one named as typed. */
class NotePicker extends SuggestModal<Target> {
	constructor(
		app: App,
		private readonly exclude: TFile,
		private readonly allowCreate: boolean,
		placeholder: string,
		private readonly choose: (target: TFile | string) => void,
	) {
		super(app);
		this.setPlaceholder(placeholder);
		this.setInstructions([
			{ command: '↑↓', purpose: 'to navigate' },
			{ command: '↵', purpose: allowCreate ? 'to choose, or create the note typed' : 'to choose' },
			{ command: 'esc', purpose: 'to dismiss' },
		]);
	}

	getSuggestions(query: string): Target[] {
		const search = prepareFuzzySearch(query);
		const found: { file: TFile; match: SearchResult }[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (file === this.exclude) continue;
			const match = search(file.path.slice(0, -3));
			if (match) found.push({ file, match });
		}
		if (query.trim()) sortSearchResults(found);
		const name = query.trim();
		const exists = found.some((t) => t.file.basename.toLowerCase() === name.toLowerCase());
		return this.allowCreate && name && !exists ? [{ create: name }, ...found] : found;
	}

	renderSuggestion(target: Target, el: HTMLElement): void {
		if ('create' in target) {
			el.createDiv({ cls: 'suggestion-content', text: `Create new note: ${target.create}` });
			return;
		}
		renderResults(el.createDiv('suggestion-content'), target.file.path.slice(0, -3), target.match ?? { score: 0, matches: [] });
	}

	onChooseSuggestion(target: Target): void {
		this.choose('create' in target ? target.create : target.file);
	}
}

/** The section of the heading on `line`: from its line to the next heading of the same or a higher level. */
function sectionAt(text: string, line: number): { from: number; to: number; heading: string } | null {
	const lines = text.split('\n');
	const match = /^(#{1,6})\s+(.*)$/.exec(lines[line] ?? '');
	if (!match) return null;
	const level = match[1]!.length;
	let end = line + 1;
	while (end < lines.length) {
		const next = /^(#{1,6})\s/.exec(lines[end]!);
		if (next && next[1]!.length <= level) break;
		end++;
	}
	const offset = (n: number) => lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0);
	return { from: offset(line), to: Math.min(text.length, offset(end)), heading: match[2]!.trim() };
}

/** Properties of `from` added to `into`: missing keys copied, lists joined. */
export function mergeProperties(into: Record<string, unknown>, from: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(from)) {
		const current = into[key];
		if (current === undefined || current === null || current === '') into[key] = value;
		else if (Array.isArray(current) || Array.isArray(value)) {
			const list = [...(Array.isArray(current) ? current : [current]), ...(Array.isArray(value) ? value : [value])];
			into[key] = list.filter((item, i) => list.findIndex((other) => JSON.stringify(other) === JSON.stringify(item)) === i);
		}
	}
}

export class NoteComposer extends InternalPluginInstance {
	readonly id = 'note-composer';
	readonly name = 'Note composer';
	readonly description = 'Merge notes, and extract selections and headings into notes.';

	get replacementText(): 'link' | 'embed' | 'none' {
		const value = this.options.replacementText;
		return value === 'embed' || value === 'none' ? value : 'link';
	}

	onEnable(): void {
		const activeNote = () => {
			const file = this.app.workspace.getActiveFile();
			return file?.extension === 'md' ? file : null;
		};
		this.addCommand({
			id: 'note-composer:merge-file',
			name: 'Note composer: Merge current file with another file…',
			checkCallback: (checking) => {
				const file = activeNote();
				if (!file) return false;
				if (!checking) this.pickMergeTarget(file);
				return true;
			},
		});
		this.addCommand({
			id: 'note-composer:split-file',
			name: 'Note composer: Extract current selection…',
			editorCheckCallback: (checking, editor) => {
				const file = activeNote();
				if (!file || !editor.getSelection()) return false;
				if (!checking) this.pickExtractTarget(file, editor);
				return true;
			},
		});
		this.addCommand({
			id: 'note-composer:extract-heading',
			name: 'Note composer: Extract this heading…',
			editorCheckCallback: (checking, editor) => {
				const file = activeNote();
				const section = file && sectionAt(editor.getValue(), editor.getCursor().line);
				if (!file || !section) return false;
				if (!checking) void this.extractHeading(file, editor);
				return true;
			},
		});
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				menu.addItem((item) => item.setTitle('Merge entire file with…').setIcon('git-merge').setSection('action').onClick(() => this.pickMergeTarget(file)));
			}),
		);
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
				const file = activeNote();
				if (!file || !editor.getSelection()) return;
				menu.addItem((item) => item.setTitle('Extract current selection…').setIcon('scissors-line-dashed').setSection('selection').onClick(() => this.pickExtractTarget(file, editor)));
			}),
		);
	}

	pickMergeTarget(file: TFile): void {
		new NotePicker(this.app, file, false, `Merge "${file.basename}" into…`, (target) => {
			if (target instanceof TFile) void this.merge(file, target);
		}).open();
	}

	pickExtractTarget(file: TFile, editor: Editor): void {
		new NotePicker(this.app, file, true, 'Move the selection to…', (target) => void this.extract(file, editor, editor.getSelection(), target)).open();
	}

	/** Appends `source` to `target`, points links to `source` at `target`, and moves `source` to the trash. */
	async merge(source: TFile, target: TFile): Promise<void> {
		const app = this.app;
		if (this.options.askBeforeMerging !== false) {
			const ok = await confirmAction(app, {
				title: 'Merge notes?',
				message: `"${source.basename}" is added to the end of "${target.basename}", links to it are updated, and it moves to the trash.`,
				confirm: 'Merge',
			});
			if (!ok) return;
		}
		try {
			await app.workspace.host.save();
			const text = await app.vault.read(source);
			const info = getFrontMatterInfo(text);
			const body = (info.exists ? text.slice(info.contentStart) : text).replace(/^\s+/, '');
			await app.vault.process(target, (current) => `${current.replace(/\s+$/, '')}\n\n${body}`);
			if (info.exists) {
				const props = parseYaml(info.frontmatter);
				if (props && typeof props === 'object') await app.fileManager.processFrontMatter(target, (fm) => mergeProperties(fm, props as Record<string, unknown>));
			}
			const links = await app.fileManager.redirectLinks(source, target);
			await app.vault.trash(source);
			await app.workspace.getLeaf(false).openFile(target);
			new Notice(`Merged "${source.basename}" into "${target.basename}"${links ? `; ${links} link${links === 1 ? '' : 's'} updated` : ''}.`);
		} catch (err) {
			new Notice(`Could not merge: ${err}`);
		}
	}

	/** Moves `text` (selected in `editor`) to `target` (a note, or the name of a new one), leaving a link, embed or nothing. */
	async extract(source: TFile, editor: Editor, text: string, target: TFile | string, range?: { from: number; to: number }): Promise<void> {
		const app = this.app;
		try {
			let file: TFile;
			if (target instanceof TFile) {
				file = target;
				await app.vault.process(file, (current) => `${current.replace(/\s+$/, '')}\n\n${text}`);
			} else {
				const name = target.replace(/[\\/:]/g, '-').trim();
				const parent = app.fileManager.getNewFileParent(source.path);
				const path = app.vault.getAvailablePath(normalizePath(parent.isRoot() ? name : `${parent.path}/${name}`), 'md');
				file = await app.vault.create(path, await this.newNoteText(text, source, name));
			}
			const link = app.fileManager.generateMarkdownLink(file, source.path);
			const replacement = this.replacementText === 'none' ? '' : this.replacementText === 'embed' ? `!${link}` : link;
			if (range) editor.replaceRange(replacement, editor.offsetToPos(range.from), editor.offsetToPos(range.to));
			else editor.replaceSelection(replacement);
		} catch (err) {
			new Notice(`Could not extract: ${err}`);
		}
	}

	/** "Extract this heading": the section under the heading at the cursor goes to a note named after it. */
	async extractHeading(source: TFile, editor: Editor): Promise<void> {
		const text = editor.getValue();
		const section = sectionAt(text, editor.getCursor().line);
		if (!section) return;
		const body = text.slice(section.from, section.to).split('\n').slice(1).join('\n').replace(/\s+$/, '');
		const end = section.to === text.length ? section.to : section.to - 1;
		await this.extract(source, editor, body, section.heading, { from: section.from, to: end });
	}

	/** A new note's text: the template (with `{{content}}`, `{{fromTitle}}`, `{{newTitle}}`, dates), or just the text. */
	private async newNoteText(text: string, source: TFile, title: string): Promise<string> {
		const templatePath = typeof this.options.template === 'string' ? this.options.template.trim() : '';
		const template = templatePath ? this.app.vault.getFileByPath(templatePath.endsWith('.md') ? templatePath : `${templatePath}.md`) : null;
		if (!template) return text;
		const raw = await this.app.vault.read(template);
		const filled = raw.replace(/\{\{content\}\}/gi, () => text).replace(/\{\{fromTitle\}\}/gi, () => source.basename).replace(/\{\{newTitle\}\}/gi, () => title);
		return applyTemplateVariables(filled, { title, date: moment(), dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' });
	}
}
