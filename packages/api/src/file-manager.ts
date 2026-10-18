import { getLinkpath, normalizePath, parentPath, parseLinktext, TFile, TFolder, type ReferenceCache, type TAbstractFile } from '@emeraldmd/core';
import type { App } from './app';
import type { DataWriteOptions } from './adapter';
import { confirmAction } from './confirm';
import { getFrontMatterInfo, parseYaml, stringifyYaml } from './util';

/** A link in `source` to a file that is being renamed. */
interface IncomingLink {
	source: TFile;
	ref: ReferenceCache;
	target: TFile;
}

/** Files inside a folder, at any depth. */
function filesIn(folder: TFolder): TFile[] {
	return folder.children.flatMap((child) => (child instanceof TFile ? [child] : child instanceof TFolder ? filesIn(child) : []));
}

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

	/**
	 * Renames or moves a file or folder, then rewrites the links to what moved
	 * (wikilinks keep their heading and alias; Markdown links get the new
	 * path). With "Automatically update internal links" (`alwaysUpdateLinks`)
	 * off, the user is asked first.
	 */
	async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
		const incoming = this.linksTo(file instanceof TFile ? [file] : file instanceof TFolder ? filesIn(file) : []);
		await this.app.vault.rename(file, newPath);
		const edits = new Map<TFile, { from: number; to: number; original: string; text: string }[]>();
		for (const { source, ref, target } of incoming) {
			const text = this.rewriteLink(ref, target, source.path);
			if (text === ref.original) continue;
			const list = edits.get(source) ?? [];
			list.push({ from: ref.position.start.offset, to: ref.position.end.offset, original: ref.original, text });
			edits.set(source, list);
		}
		if (edits.size === 0) return;
		const count = [...edits.values()].reduce((n, list) => n + list.length, 0);
		if (this.app.vault.getConfig('alwaysUpdateLinks') !== true) {
			const yes = await confirmAction(this.app, {
				title: 'Update links?',
				message: `Update ${count} link${count === 1 ? '' : 's'} in ${edits.size} file${edits.size === 1 ? '' : 's'} to point to the new location?`,
				confirm: 'Update',
				cancel: "Don't update",
			});
			if (!yes) return;
		}
		for (const [source, list] of edits) {
			if (!this.app.vault.getFileByPath(source.path)) continue;
			await this.app.vault.process(source, (text) => {
				// From the end, so earlier offsets stay valid; a link that changed since it was indexed is left alone.
				for (const edit of [...list].sort((a, b) => b.from - a.from)) {
					if (text.slice(edit.from, edit.to) === edit.original) text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
				}
				return text;
			});
		}
	}

	/**
	 * @internal Points every link to `from` (in other notes) at `to` instead,
	 * keeping headings, blocks and aliases; for merging notes. Returns how
	 * many links changed.
	 */
	async redirectLinks(from: TFile, to: TFile): Promise<number> {
		const edits = new Map<TFile, { from: number; to: number; original: string; text: string }[]>();
		for (const { source, ref } of this.linksTo([from])) {
			if (source === from) continue;
			const text = this.rewriteLink(ref, to, source.path);
			if (text === ref.original) continue;
			const list = edits.get(source) ?? [];
			list.push({ from: ref.position.start.offset, to: ref.position.end.offset, original: ref.original, text });
			edits.set(source, list);
		}
		let count = 0;
		for (const [source, list] of edits) {
			await this.app.vault.process(source, (text) => {
				for (const edit of [...list].sort((a, b) => b.from - a.from)) {
					if (text.slice(edit.from, edit.to) !== edit.original) continue;
					text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
					count++;
				}
				return text;
			});
		}
		return count;
	}

	/** Links (and embeds) in notes that resolve to one of `files`, read before they move. */
	private linksTo(files: TFile[]): IncomingLink[] {
		const { metadataCache, vault } = this.app;
		const targets = new Map(files.map((f) => [f.path, f]));
		const found: IncomingLink[] = [];
		for (const [sourcePath, dests] of Object.entries(metadataCache.resolvedLinks)) {
			if (!Object.keys(dests).some((dest) => targets.has(dest))) continue;
			const source = vault.getFileByPath(sourcePath);
			const cache = metadataCache.getCache(sourcePath);
			if (!source || !cache) continue;
			for (const ref of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
				const target = metadataCache.getFirstLinkpathDest(getLinkpath(ref.link), sourcePath);
				if (target && targets.get(target.path) === target) found.push({ source, ref, target });
			}
		}
		return found;
	}

	/** The link text for `target` as the vault's link format says. */
	private linktextFor(target: TFile, sourcePath: string, omitMdExtension: boolean): string {
		if (this.app.vault.getConfig('newLinkFormat') === 'absolute') {
			return omitMdExtension && target.extension === 'md' ? target.path.slice(0, -'.md'.length) : target.path;
		}
		return this.app.metadataCache.fileToLinktext(target, sourcePath, omitMdExtension);
	}

	/** `ref` rewritten to point at `target` where it is now. */
	private rewriteLink(ref: ReferenceCache, target: TFile, sourcePath: string): string {
		const { subpath } = parseLinktext(ref.link);
		const wiki = /^(!?)\[\[([^\]]*)\]\]$/.exec(ref.original);
		if (wiki) {
			const pipe = wiki[2]!.indexOf('|');
			const alias = pipe === -1 ? '' : wiki[2]!.slice(pipe);
			return `${wiki[1]}[[${this.linktextFor(target, sourcePath, true)}${subpath}${alias}]]`;
		}
		const markdown = /^(!?\[[^\]]*\]\()(\S+?)((?:\s+"[^"]*")?\))$/.exec(ref.original);
		if (!markdown) return ref.original;
		const href = encodeURI(this.linktextFor(target, sourcePath, false)) + subpath.replace(/ /g, '%20');
		return `${markdown[1]}${href}${markdown[3]}`;
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
