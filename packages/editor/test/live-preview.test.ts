// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownEditor } from '../src';

const editors: MarkdownEditor[] = [];

/** An editor in Live Preview with `doc`, the cursor at `cursor` (default: the end). */
function open(doc: string, cursor = doc.length, options: { onOpenLink?: (link: string) => void; onOpenUrl?: (url: string) => void } = {}) {
	const exists = new Set(['Projects/Plan', 'Link']);
	const parent = document.body.appendChild(document.createElement('div'));
	parent.className = 'markdown-source-view';
	const editor = new MarkdownEditor({
		parent,
		...options,
		livePreview: { renderMarkdown: (markdown, el) => void (el.textContent = `rendered: ${markdown}`), isResolved: (link) => exists.has(link) },
	});
	editors.push(editor);
	editor.setValue(doc);
	editor.setLivePreview(true);
	editor.view.dispatch({ selection: { anchor: cursor } });
	return editor;
}

const lines = (editor: MarkdownEditor) => [...editor.view.contentDOM.querySelectorAll('.cm-line')].map((line) => line.textContent);
const moveTo = (editor: MarkdownEditor, pos: number) => editor.view.dispatch({ selection: { anchor: pos } });

afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy();
	document.body.replaceChildren();
});

describe('Live Preview', () => {
	it('hides formatting away from the cursor and shows it where the cursor is', () => {
		const doc = '# Title\n\nSome **bold**, *em*, `code`, ~~gone~~ and ==marked==.\n\nend';
		const editor = open(doc);
		expect(lines(editor)).toEqual(['Title', '', 'Some bold, em, code, gone and marked.', '', 'end']);
		expect(editor.view.contentDOM.querySelector('.cm-line')!.className).toContain('HyperMD-header-1');
		expect(editor.view.contentDOM.querySelector('.cm-highlight')?.textContent).toBe('marked');

		moveTo(editor, doc.indexOf('bold') + 1);
		expect(lines(editor)[2]).toBe('Some **bold**, em, code, gone and marked.');
		moveTo(editor, 3);
		expect(lines(editor)[0]).toBe('# Title');
	});

	it('shows wikilinks by their text and follows them on click', () => {
		const onOpenLink = vi.fn();
		const doc = 'See [[Projects/Plan|the plan]] and [[Ideas]].\n\nend';
		const editor = open(doc, doc.length, { onOpenLink });
		expect(lines(editor)[0]).toBe('See the plan and Ideas.');
		const link = editor.view.contentDOM.querySelector<HTMLElement>('[data-lp-link="Projects/Plan"]')!;
		expect(link.textContent).toBe('the plan');
		expect(link.classList.contains('is-unresolved')).toBe(false);
		expect(editor.view.contentDOM.querySelector('[data-lp-link="Ideas"]')!.classList.contains('is-unresolved')).toBe(true);
		link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
		expect(onOpenLink).toHaveBeenCalledWith('Projects/Plan', false);

		moveTo(editor, 6);
		expect(lines(editor)[0]).toBe('See [[Projects/Plan|the plan]] and Ideas.');
	});

	it('shows Markdown links by their text and opens their URL', () => {
		const onOpenUrl = vi.fn();
		const doc = 'A [site](https://example.org "Title") here.\n\nend';
		const editor = open(doc, doc.length, { onOpenUrl });
		expect(lines(editor)[0]).toBe('A site here.');
		editor.view.contentDOM.querySelector('[data-lp-href]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
		expect(onOpenUrl).toHaveBeenCalledWith('https://example.org');
	});

	it('leaves code alone', () => {
		const doc = 'Inline `[[not a link]]` here.\n\n```\n**raw** [[raw]]\n```\n\nend';
		const editor = open(doc);
		expect(lines(editor)[0]).toBe('Inline [[not a link]] here.');
		expect(lines(editor)[3]).toBe('**raw** [[raw]]');
		const code = editor.view.contentDOM.querySelectorAll('.HyperMD-codeblock');
		expect(code).toHaveLength(3);
		expect(code[0]!.className).toContain('HyperMD-codeblock-begin');
	});

	it('draws bullets and task checkboxes, and toggles tasks on click', () => {
		const doc = '- item\n- [ ] todo\n- [x] done\n\nend';
		const editor = open(doc);
		// The space after the marker stays, after the bullet or checkbox.
		expect(lines(editor).slice(0, 3)).toEqual([' item', ' todo', ' done']);
		expect(editor.view.contentDOM.querySelectorAll('.list-bullet')).toHaveLength(1);
		const boxes = editor.view.contentDOM.querySelectorAll<HTMLInputElement>('.task-list-item-checkbox');
		expect([...boxes].map((b) => b.checked)).toEqual([false, true]);
		expect(editor.view.contentDOM.querySelector('.HyperMD-task-line[data-task="x"]')?.textContent).toBe(' done');

		boxes[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
		expect(editor.getValue()).toBe('- item\n- [x] todo\n- [x] done\n\nend');
	});

	it('renders callouts, tables and embeds while the cursor is outside them', () => {
		const doc = '---\ntags: [x]\n---\n> [!tip] Hint\n> Body\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n![[image.png]]\n\nend';
		const editor = open(doc);
		const dom = editor.view.dom;
		expect(dom.querySelector('.cm-callout')?.textContent).toBe('rendered: > [!tip] Hint\n> Body');
		expect(dom.querySelector('.cm-table-widget')?.textContent).toBe('rendered: | a | b |\n| - | - |\n| 1 | 2 |');
		expect(dom.querySelector('.cm-embed-block')?.textContent).toBe('rendered: ![[image.png]]');

		moveTo(editor, doc.indexOf('Hint'));
		expect(dom.querySelector('.cm-callout')).toBeNull();
		expect(lines(editor)[3]).toBe('> [!tip] Hint');
	});

	it('switches back to source mode', () => {
		const doc = '# Title\n\n[[Link]]\n\nend';
		const editor = open(doc);
		editor.setLivePreview(false);
		expect(lines(editor)).toEqual(['# Title', '', '[[Link]]', '', 'end']);
		expect(editor.view.dom.parentElement!.classList.contains('is-live-preview')).toBe(false);
		// Line classes stay in source mode, for themes.
		expect(editor.view.contentDOM.querySelector('.HyperMD-header-1')).not.toBeNull();
	});
});

describe('math and diagrams in Live Preview', () => {
	it('renders formulas and diagrams while the cursor is elsewhere', () => {
		const doc = 'Area $\\pi r_1 * r_2$ here.\n\n$$\nx^2\n$$\n\n```mermaid\ngraph TD; A-->B\n```\n\nend';
		const editor = open(doc);
		const dom = editor.view.dom;
		expect(dom.querySelector('.cm-math')?.textContent).toBe('rendered: $\\pi r_1 * r_2$');
		expect(dom.querySelector('.cm-math-block')?.textContent).toBe('rendered: $$\nx^2\n$$');
		expect(dom.querySelector('.cm-mermaid')?.textContent).toBe('rendered: ```mermaid\ngraph TD; A-->B\n```');
		// The formula is one node: no emphasis inside it.
		expect(dom.querySelector('.cm-em')).toBeNull();
		moveTo(editor, doc.indexOf('r_1'));
		expect(lines(editor)[0]).toBe('Area $\\pi r_1 * r_2$ here.');
	});
});

describe("plugins' code blocks in Live Preview", () => {
	it('renders blocks a plugin draws, keeps their clicks, and shows the source from the edit button', () => {
		const parent = document.body.appendChild(document.createElement('div'));
		const editor = new MarkdownEditor({
			parent,
			livePreview: { renderMarkdown: (markdown, el) => void (el.textContent = `rendered: ${markdown}`), isRenderedCodeBlock: (lang) => lang === 'base' },
		});
		editors.push(editor);
		const doc = '```base\nviews: []\n```\n\n```js\nx\n```\n\nend';
		editor.setValue(doc);
		editor.setLivePreview(true);
		editor.view.dispatch({ selection: { anchor: doc.length } });
		const block = editor.view.dom.querySelector('.cm-preview-code-block.cm-lang-base')!;
		expect(block.textContent).toBe('rendered: ```base\nviews: []\n```');
		// Other languages stay code.
		expect(editor.view.dom.querySelectorAll('.cm-preview-code-block')).toHaveLength(1);
		(block.querySelector('.edit-block-button') as HTMLElement).click();
		expect(editor.view.state.selection.main.head).toBe(doc.indexOf('views'));
		expect(editor.view.dom.querySelector('.cm-preview-code-block')).toBeNull();
	});
});

describe('read-only notes', () => {
	it('can be read but not edited', async () => {
		const { DEFAULT_EDITOR_SETTINGS } = await import('../src');
		const editor = open('hello', 0);
		editor.configure({ ...DEFAULT_EDITOR_SETTINGS, readOnly: true });
		expect(editor.view.state.readOnly).toBe(true);
		expect(editor.view.contentDOM.getAttribute('contenteditable')).toBe('false');
		editor.configure({ ...DEFAULT_EDITOR_SETTINGS });
		expect(editor.view.state.readOnly).toBe(false);
	});
});

describe('Vim key bindings', () => {
	it('turns on with the setting and edits with Vim keys', async () => {
		const { DEFAULT_EDITOR_SETTINGS } = await import('../src');
		const editor = open('hello world', 0);
		editor.setLivePreview(false);
		expect(editor.view.scrollDOM.classList.contains('cm-vimMode')).toBe(false);
		editor.configure({ ...DEFAULT_EDITOR_SETTINGS, vim: true });
		expect(editor.view.scrollDOM.classList.contains('cm-vimMode')).toBe(true);
		const key = (k: string) => editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
		editor.view.focus();
		key('d');
		key('w');
		expect(editor.getValue()).toBe('world');
		editor.configure({ ...DEFAULT_EDITOR_SETTINGS, vim: false });
		expect(editor.view.scrollDOM.classList.contains('cm-vimMode')).toBe(false);
	});
});

describe('properties in Live Preview', () => {
	function withProperties(doc: string, mode: () => 'visible' | 'hidden' | 'source' = () => 'visible') {
		const parent = document.body.appendChild(document.createElement('div'));
		const shown: string[] = [];
		const editor = new MarkdownEditor({
			parent,
			livePreview: {
				renderProperties: (yaml, el) => {
					el.textContent = `props: ${yaml}`;
					shown.push(yaml);
					return { update: (next) => ((el.textContent = `props: ${next}`), true) };
				},
				validProperties: (yaml) => !yaml.includes('['),
				propertiesInDocument: mode,
			},
		});
		editors.push(editor);
		editor.setValue(doc);
		editor.setLivePreview(true);
		return { editor, shown };
	}

	it('draws the frontmatter as properties, keeps the cursor out of it, and updates in place', () => {
		const { editor, shown } = withProperties('---\ntitle: A\n---\nBody');
		const widget = editor.view.dom.querySelector('.cm-properties-widget')!;
		expect(widget.textContent).toBe('props: title: A');
		expect(lines(editor)).toEqual(['Body']);
		// The note opens after its frontmatter, and the cursor cannot go back into it.
		expect(editor.view.state.selection.main.head).toBe(editor.getValue().indexOf('Body'));
		moveTo(editor, 2);
		expect(editor.view.state.selection.main.head).toBe(editor.getValue().indexOf('Body'));

		editor.view.dispatch({ changes: { from: 4, to: 12, insert: 'title: B' } });
		expect(editor.view.dom.querySelector('.cm-properties-widget')).toBe(widget);
		expect(widget.textContent).toBe('props: title: B');
		expect(shown).toEqual(['title: A']);
	});

	it('leaves invalid YAML and the source setting as text, and hides properties when asked', () => {
		expect(lines(withProperties('---\ntags: [a\n---\nBody').editor)).toEqual(['---', 'tags: [a', '---', 'Body']);
		expect(lines(withProperties('---\na: 1\n---\nBody', () => 'source').editor)).toEqual(['---', 'a: 1', '---', 'Body']);
		const hidden = withProperties('---\na: 1\n---\nBody', () => 'hidden').editor;
		expect(lines(hidden)).toEqual(['Body']);
		expect(hidden.view.dom.querySelector('.cm-properties-widget')).toBeNull();
	});
});
