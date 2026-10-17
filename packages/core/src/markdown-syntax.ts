/**
 * Obsidian's Markdown additions as @lezer/markdown extensions, shared by the
 * renderer (packages/api) and the editor (packages/editor) so both read a
 * note the same way:
 *
 * - math: `$…$` (`InlineMath`) and `$$…$$` (`BlockMath`, also on one line),
 *   parsed before emphasis so `$a_1 * b_2$` stays one formula;
 * - footnotes: references `[^id]` (`FootnoteRef`), inline footnotes `^[…]`
 *   (`InlineFootnote`) and definitions `[^id]: text` (`FootnoteDefinition`,
 *   continued by indented lines).
 */

import type { BlockContext, InlineContext, Line, MarkdownConfig } from '@lezer/markdown';

const DOLLAR = 36;
const BACKSLASH = 92;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const CARET = 94;
const NEWLINE = 10;

const isSpace = (ch: number) => ch === 32 || ch === 9 || ch === NEWLINE;
const isDigit = (ch: number) => ch >= 48 && ch <= 57;

/** `$…$` (no space just inside the dollars, no digit just after) and `$$…$$`. */
function parseInlineMath(cx: InlineContext, next: number, pos: number): number {
	if (next !== DOLLAR) return -1;
	const display = cx.char(pos + 1) === DOLLAR;
	const open = display ? 2 : 1;
	const first = cx.char(pos + open);
	if (first === -1 || first === DOLLAR || (!display && isSpace(first))) return -1;
	for (let i = pos + open; i < cx.end; i++) {
		const ch = cx.char(i);
		if (ch === BACKSLASH) {
			i++;
			continue;
		}
		if (!display && ch === NEWLINE) return -1;
		if (ch !== DOLLAR) continue;
		if (display) {
			if (cx.char(i + 1) !== DOLLAR) continue;
		} else if (isSpace(cx.char(i - 1)) || isDigit(cx.char(i + 1))) {
			continue;
		}
		const close = i + open;
		return cx.addElement(cx.elt('InlineMath', pos, close, [cx.elt('InlineMathMark', pos, pos + open), cx.elt('InlineMathMark', i, close)]));
	}
	return -1;
}

/** `$$` at the start of a line, up to the next `$$` (on the same line or a later one). */
function parseBlockMath(cx: BlockContext, line: Line): boolean {
	const rest = line.text.slice(line.pos);
	if (!rest.startsWith('$$')) return false;
	const from = cx.lineStart + line.pos;
	const sameLine = rest.indexOf('$$', 2);
	if (sameLine !== -1) {
		// `$$x$$` alone on its line is a block; with text after it, it is inline math in a paragraph.
		if (rest.slice(sameLine + 2).trim()) return false;
		const to = from + sameLine + 2;
		cx.nextLine();
		cx.addElement(cx.elt('BlockMath', from, to, [cx.elt('BlockMathMark', from, from + 2), cx.elt('BlockMathMark', to - 2, to)]));
		return true;
	}
	let to = -1;
	let closeFrom = -1;
	while (cx.nextLine()) {
		const at = line.text.indexOf('$$', line.pos);
		if (at !== -1) {
			closeFrom = cx.lineStart + at;
			to = closeFrom + 2;
			cx.nextLine();
			break;
		}
	}
	// Unclosed: the formula runs to the end of the document, as in Obsidian.
	if (to === -1) to = cx.prevLineEnd();
	const marks = [cx.elt('BlockMathMark', from, from + 2)];
	if (closeFrom !== -1) marks.push(cx.elt('BlockMathMark', closeFrom, to));
	cx.addElement(cx.elt('BlockMath', from, to, marks));
	return true;
}

/** `[^label]` */
function parseFootnoteRef(cx: InlineContext, next: number, pos: number): number {
	if (next !== OPEN_BRACKET || cx.char(pos + 1) !== CARET) return -1;
	let end = pos + 2;
	for (; end < cx.end; end++) {
		const ch = cx.char(end);
		if (ch === CLOSE_BRACKET) break;
		if (isSpace(ch) || ch === OPEN_BRACKET) return -1;
	}
	if (end === pos + 2 || cx.char(end) !== CLOSE_BRACKET) return -1;
	return cx.addElement(cx.elt('FootnoteRef', pos, end + 1, [cx.elt('FootnoteLabel', pos + 2, end)]));
}

/** `^[text]`, with nested brackets. */
function parseInlineFootnote(cx: InlineContext, next: number, pos: number): number {
	if (next !== CARET || cx.char(pos + 1) !== OPEN_BRACKET) return -1;
	let depth = 0;
	for (let i = pos + 1; i < cx.end; i++) {
		const ch = cx.char(i);
		if (ch === BACKSLASH) {
			i++;
			continue;
		}
		if (ch === OPEN_BRACKET) depth++;
		else if (ch === CLOSE_BRACKET && --depth === 0) {
			if (i === pos + 2) return -1;
			return cx.addElement(cx.elt('InlineFootnote', pos, i + 1, [cx.elt('InlineFootnoteContent', pos + 2, i)]));
		}
	}
	return -1;
}

const DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]?/;
const CONTINUATION = /^( {4}|\t)/;

/** `[^label]: text`, continued by lines indented four spaces or a tab. */
function parseFootnoteDefinition(cx: BlockContext, line: Line): boolean {
	const match = DEFINITION.exec(line.text.slice(line.pos));
	if (!match) return false;
	const from = cx.lineStart + line.pos;
	const labelFrom = from + 2;
	const label = cx.elt('FootnoteLabel', labelFrom, labelFrom + match[1]!.length);
	const contentFrom = from + match[0].length;
	let to = cx.lineStart + line.text.length;
	while (cx.nextLine()) {
		if (line.text.trim() && CONTINUATION.test(line.text)) to = cx.lineStart + line.text.length;
		else if (!line.text.trim() && CONTINUATION.test(cx.peekLine()) && cx.peekLine().trim()) continue;
		else break;
	}
	cx.addElement(cx.elt('FootnoteDefinition', from, to, [label, cx.elt('FootnoteContent', Math.min(contentFrom, to), to)]));
	return true;
}

export const MathSyntax: MarkdownConfig = {
	defineNodes: ['InlineMath', 'InlineMathMark', { name: 'BlockMath', block: true }, 'BlockMathMark'],
	parseInline: [{ name: 'InlineMath', parse: parseInlineMath, before: 'Emphasis' }],
	parseBlock: [{ name: 'BlockMath', parse: parseBlockMath, before: 'FencedCode' }],
};

export const FootnoteSyntax: MarkdownConfig = {
	defineNodes: [
		'FootnoteRef',
		'FootnoteLabel',
		'InlineFootnote',
		'InlineFootnoteContent',
		{ name: 'FootnoteDefinition', block: true },
		'FootnoteContent',
	],
	parseInline: [
		{ name: 'FootnoteRef', parse: parseFootnoteRef, before: 'Link' },
		{ name: 'InlineFootnote', parse: parseInlineFootnote, before: 'Link' },
	],
	parseBlock: [{ name: 'FootnoteDefinition', parse: parseFootnoteDefinition, before: 'LinkReference' }],
};

/** Every Obsidian addition, for `parser.configure()` or `markdown({ extensions })`. */
export const obsidianMarkdown: MarkdownConfig[] = [MathSyntax, FootnoteSyntax];
