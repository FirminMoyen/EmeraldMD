/**
 * Obsidian's editing commands (ids `editor:…`), working on any `Editor`:
 * formatting (bold, italics, strikethrough, highlight, code, math,
 * comments), links, lists and checklists, headings, quotes, inserts
 * (callout, code block, table…), lines and folding. Default hotkeys follow
 * Obsidian's: ⌘B, ⌘I, ⌘K, ⌘L, ⌘/.
 */

import type { App } from './app';
import type { Command } from './commands';
import type { Editor, EditorPosition } from './editor';
import type { Modifier } from './keymap';

/** Wraps the selection (or the word at the cursor) in `open`…`close`, or unwraps it if it already is. */
export function toggleWrap(editor: Editor, open: string, close = open): void {
	let from = editor.getCursor('from');
	let to = editor.getCursor('to');
	if (from.line === to.line && from.ch === to.ch) {
		const word = editor.wordAt(from);
		if (word) {
			from = word.from;
			to = word.to;
		}
	}
	const start = editor.posToOffset(from);
	const end = editor.posToOffset(to);
	const text = editor.getValue();
	const before = text.slice(Math.max(0, start - open.length), start);
	const after = text.slice(end, end + close.length);
	const selected = text.slice(start, end);
	// Replaces [a, b) with `insert`, then selects [selFrom, selTo) of the new text.
	const apply = (a: number, b: number, insert: string, selFrom: number, selTo: number) => {
		editor.replaceRange(insert, editor.offsetToPos(a), editor.offsetToPos(b));
		editor.setSelection(editor.offsetToPos(selFrom), editor.offsetToPos(selTo));
	};
	if (start >= open.length && before === open && after === close) {
		// Already wrapped around the selection: unwrap.
		return apply(start - open.length, end + close.length, selected, start - open.length, end - open.length);
	}
	if (selected.length >= open.length + close.length && selected.startsWith(open) && selected.endsWith(close)) {
		const inner = selected.slice(open.length, selected.length - close.length);
		return apply(start, end, inner, start, start + inner.length);
	}
	apply(start, end, `${open}${selected}${close}`, start + open.length, end + open.length);
}

const LIST_PREFIX = /^(\s*)((?:[-*+]|\d+[.)])\s+)?(\[.\]\s+)?/;

/** Applies `change` to the text of each selected line (after its indentation). */
function eachLine(editor: Editor, change: (line: string) => string): void {
	editor.processLines(
		() => null,
		(line, text) => {
			const next = change(text);
			return next === text ? undefined : { from: { line, ch: 0 }, to: { line, ch: text.length }, text: next };
		},
	);
}

/** Checklist: plain lines and bullets become `- [ ]`; `- [ ]` and `- [x]` swap. */
export function toggleChecklist(line: string): string {
	const [, indent = '', bullet = '', box = ''] = LIST_PREFIX.exec(line) ?? [];
	const rest = line.slice(indent.length + bullet.length + box.length);
	if (box) return `${indent}${bullet}${box.startsWith('[ ]') ? '[x] ' : '[ ] '}${rest}`;
	return `${indent}${bullet || '- '}[ ] ${rest}`;
}

/** Bullets: added, or removed if the line has one (a numbered or checklist item becomes a bullet). */
export function toggleBullet(line: string): string {
	const [, indent = '', bullet = '', box = ''] = LIST_PREFIX.exec(line) ?? [];
	const rest = line.slice(indent.length + bullet.length + box.length);
	if (/^[-*+]\s/.test(bullet) && !box) return `${indent}${rest}`;
	return `${indent}- ${rest}`;
}

export function toggleNumbered(line: string, n: number): string {
	const [, indent = '', bullet = '', box = ''] = LIST_PREFIX.exec(line) ?? [];
	const rest = line.slice(indent.length + bullet.length + box.length);
	if (/^\d+[.)]\s/.test(bullet)) return `${indent}${rest}`;
	return `${indent}${n}. ${rest}`;
}

export function toggleQuote(line: string): string {
	return /^\s*>\s?/.test(line) ? line.replace(/^(\s*)>\s?/, '$1') : `> ${line}`;
}

/** Makes the line a heading of `level` (0: plain text). */
export function setHeading(line: string, level: number): string {
	const rest = line.replace(/^#{1,6}\s+/, '');
	return level ? `${'#'.repeat(level)} ${rest}` : rest;
}

/** Inserts `text` at the cursor (replacing the selection), with the cursor `cursor` characters into it. */
function insert(editor: Editor, text: string, cursor = text.length, onOwnLine = false): void {
	const from = editor.getCursor('from');
	let prefix = '';
	if (onOwnLine && editor.getLine(from.line).slice(0, from.ch).trim() !== '') prefix = '\n';
	editor.replaceSelection(prefix + text);
	const start = editor.posToOffset(editor.getCursor('from')) - (prefix + text).length;
	const at: EditorPosition = editor.offsetToPos(start + prefix.length + cursor);
	editor.setCursor(at);
}

/** A Markdown link around the selection: `[selection](|)`, or `[](selection)` if it is a URL. */
function insertLink(editor: Editor): void {
	const selected = editor.getSelection();
	if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(selected.trim())) insert(editor, `[](${selected.trim()})`, 1);
	else insert(editor, `[${selected}]()`, selected.length + 3);
}

interface EditorCommandOptions {
	/** Follows the wikilink or URL at the cursor (`newTab`: in a new tab). */
	followLink?: (editor: Editor, newTab: boolean) => boolean;
}

/** The editing commands, to register with `app.commands.addCommand`. */
export function editorCommands(options: EditorCommandOptions = {}): Command[] {
	const mod = (key: string, ...extra: Modifier[]) => [{ modifiers: ['Mod', ...extra] as Modifier[], key }];
	const wrap = (id: string, name: string, open: string, close?: string, hotkeys?: Command['hotkeys']): Command => ({
		id,
		name,
		hotkeys,
		editorCallback: (editor) => toggleWrap(editor, open, close),
	});
	const lines = (id: string, name: string, change: (line: string, i: number) => string, hotkeys?: Command['hotkeys']): Command => ({
		id,
		name,
		hotkeys,
		editorCallback: (editor) => {
			let i = 0;
			eachLine(editor, (line) => change(line, ++i));
		},
	});
	const exec = (id: string, name: string, command: Parameters<Editor['exec']>[0], hotkeys?: Command['hotkeys']): Command => ({
		id,
		name,
		hotkeys,
		editorCallback: (editor) => editor.exec(command),
	});
	const commands: Command[] = [
		wrap('editor:toggle-bold', 'Toggle bold', '**', '**', mod('B')),
		wrap('editor:toggle-italics', 'Toggle italics', '*', '*', mod('I')),
		wrap('editor:toggle-strikethrough', 'Toggle strikethrough', '~~'),
		wrap('editor:toggle-highlight', 'Toggle highlight', '=='),
		wrap('editor:toggle-code', 'Toggle code', '`'),
		wrap('editor:toggle-inline-math', 'Toggle math', '$'),
		wrap('editor:toggle-comments', 'Toggle comment', '%%', '%%', mod('/')),
		{ id: 'editor:insert-link', name: 'Insert Markdown link', hotkeys: mod('K'), editorCallback: (editor) => insertLink(editor) },
		{ id: 'editor:insert-wikilink', name: 'Add internal link', editorCallback: (editor) => insert(editor, `[[${editor.getSelection()}]]`, 2 + editor.getSelection().length) },
		{ id: 'editor:insert-embed', name: 'Add embed', editorCallback: (editor) => insert(editor, `![[${editor.getSelection()}]]`, 3 + editor.getSelection().length) },
		lines('editor:toggle-checklist-status', 'Toggle checkbox status', toggleChecklist, mod('L')),
		lines('editor:toggle-bullet-list', 'Toggle bullet list', toggleBullet),
		lines('editor:toggle-numbered-list', 'Toggle numbered list', toggleNumbered),
		lines('editor:toggle-blockquote', 'Toggle blockquote', toggleQuote),
		...[0, 1, 2, 3, 4, 5, 6].map((level) =>
			lines(level ? `editor:set-heading-${level}` : 'editor:set-heading-0', level ? `Set as heading ${level}` : 'Remove heading', (line) => setHeading(line, level)),
		),
		{ id: 'editor:insert-callout', name: 'Insert callout', editorCallback: (editor) => insert(editor, `> [!note]\n> ${editor.getSelection()}`, 12 + editor.getSelection().length, true) },
		{ id: 'editor:insert-codeblock', name: 'Insert code block', editorCallback: (editor) => insert(editor, `\`\`\`\n${editor.getSelection()}\n\`\`\``, 3, true) },
		{ id: 'editor:insert-mathblock', name: 'Insert math block', editorCallback: (editor) => insert(editor, `$$\n${editor.getSelection()}\n$$`, 3 + editor.getSelection().length, true) },
		{ id: 'editor:insert-horizontal-rule', name: 'Insert horizontal rule', editorCallback: (editor) => insert(editor, '---\n', 4, true) },
		{
			id: 'editor:insert-table',
			name: 'Insert table',
			editorCallback: (editor) => insert(editor, '|  |  |\n| --- | --- |\n|  |  |\n', 2, true),
		},
		exec('editor:swap-line-up', 'Move line up', 'swapLineUp'),
		exec('editor:swap-line-down', 'Move line down', 'swapLineDown'),
		exec('editor:delete-paragraph', 'Delete paragraph', 'deleteLine'),
		exec('editor:toggle-fold', 'Toggle fold on the current line', 'toggleFold'),
		exec('editor:fold-all', 'Fold all headings and lists', 'foldAll'),
		exec('editor:unfold-all', 'Unfold all headings and lists', 'unfoldAll'),
	];
	if (options.followLink) {
		const follow = options.followLink;
		commands.push(
			{ id: 'editor:follow-link', name: 'Follow link under cursor', hotkeys: [{ modifiers: ['Alt'], key: 'Enter' }], editorCheckCallback: (checking, editor) => (checking ? true : follow(editor, false)) },
			{ id: 'editor:open-link-in-new-leaf', name: 'Open link under cursor in new tab', editorCheckCallback: (checking, editor) => (checking ? true : follow(editor, true)) },
		);
	}
	return commands;
}

/** Registers the editing commands. */
export function registerEditorCommands(app: App, options: EditorCommandOptions = {}): void {
	for (const command of editorCommands(options)) app.commands.addCommand(command);
}
