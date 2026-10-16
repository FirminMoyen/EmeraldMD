import { normalizePath, parentPath, TFile, type TAbstractFile, type TFolder } from '@emeraldmd/core';
import type { App } from './app';
import type { DataWriteOptions } from './adapter';
import { getFrontMatterInfo, parseYaml, stringifyYaml } from './util';

/** File operations that follow the user's settings (new file location, link format, attachments). */
export class FileManager {
	private readonly app: App;

	constructor(app: App) {
		this.app = app;
	}

	getNewFileParent(sourcePath: string, _newFilePath?: string): TFolder {
		const vault = this.app.vault;
		const location = vault.getConfig('newFileLocation');
		if (location === 'folder') {
			const folder = vault.getFolderByPath(String(vault.getConfig('newFileFolderPath') ?? ''));
			if (folder) return folder;
		} else if (location === 'current') {
			const source = vault.getAbstractFileByPath(sourcePath);
			const folder = source?.parent ?? vault.getFolderByPath(parentPath(sourcePath));
			if (folder) return folder;
		}
		return vault.getRoot();
	}

	/** Renames or moves a file. Links to it are not rewritten yet. */
	async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
		await this.app.vault.rename(file, newPath);
	}

	async promptForDeletion(file: TAbstractFile): Promise<boolean> {
		const ok = window.confirm(`Move "${file.name}" to the vault's .trash folder?`);
		if (ok) await this.trashFile(file);
		return ok;
	}

	async trashFile(file: TAbstractFile): Promise<void> {
		await this.app.vault.trash(file);
	}

	generateMarkdownLink(file: TFile, sourcePath: string, subpath = '', alias?: string): string {
		const vault = this.app.vault;
		const useMarkdown = vault.getConfig('useMarkdownLinks') === true;
		const format = vault.getConfig('newLinkFormat');
		let linktext: string;
		if (format === 'absolute') linktext = file.extension === 'md' && !useMarkdown ? file.path.slice(0, -3) : file.path;
		else linktext = this.app.metadataCache.fileToLinktext(file, sourcePath, !useMarkdown);
		if (useMarkdown) {
			const href = encodeURI(file.extension === 'md' && !linktext.endsWith('.md') ? `${linktext}.md` : linktext) + subpath.replace(/ /g, '%20');
			return `${file.extension === 'md' ? '' : '!'}[${alias ?? file.basename}](${href})`;
		}
		const embed = file.extension === 'md' ? '' : '!';
		return `${embed}[[${linktext}${subpath}${alias ? `|${alias}` : ''}]]`;
	}

	/** Parses the note's frontmatter, lets `fn` change it, and writes it back. */
	async processFrontMatter(file: TFile, fn: (frontmatter: Record<string, unknown>) => void, _options?: DataWriteOptions): Promise<void> {
		await this.app.vault.process(file, (content) => {
			const info = getFrontMatterInfo(content);
			const data = ((info.exists ? parseYaml(info.frontmatter) : null) ?? {}) as Record<string, unknown>;
			fn(data);
			const yaml = Object.keys(data).length ? stringifyYaml(data) : '';
			const body = info.exists ? content.slice(info.contentStart) : content;
			if (!yaml) return info.exists ? body : content;
			return `---\n${yaml}---\n${body}`;
		});
	}

	async getAvailablePathForAttachment(filename: string, sourcePath?: string): Promise<string> {
		const vault = this.app.vault;
		const setting = String(vault.getConfig('attachmentFolderPath') ?? '/');
		const source = sourcePath ?? this.app.workspace.getActiveFile()?.path ?? '';
		let folder: string;
		if (setting === '/' || setting === '') folder = '';
		else if (setting === './' || setting.startsWith('./')) {
			const base = parentPath(source);
			folder = normalizePath(`${base === '/' ? '' : base}/${setting.slice(2)}`);
		} else folder = normalizePath(setting);
		if (folder === '/') folder = '';
		const dot = filename.lastIndexOf('.');
		const base = dot > 0 ? filename.slice(0, dot) : filename;
		const ext = dot > 0 ? filename.slice(dot + 1) : '';
		return vault.getAvailablePath(folder ? `${folder}/${base}` : base, ext);
	}
}
