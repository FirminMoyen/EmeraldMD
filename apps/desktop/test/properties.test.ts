// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { startShell, type Shell } from './shell-harness';

const property = (root: ParentNode, key: string) => root.querySelector<HTMLElement>(`.metadata-property[data-property-key="${key}"]`);

describe('properties', () => {
	let shell: Shell;
	const editorEl = () => document.querySelector<HTMLElement>('.markdown-source-view')!;
	const readingEl = () => document.querySelector<HTMLElement>('.markdown-reading-view')!;

	it('shows the frontmatter as properties in Live Preview, and edits go into the note', async () => {
		shell = await startShell({ 'Note.md': '---\ntitle: Draft\ntags:\n  - work\n---\nBody\n' }, {});
		await vi.waitFor(() => expect(property(editorEl(), 'title')).not.toBeNull());
		const field = property(editorEl(), 'title')!.querySelector<HTMLElement>('.metadata-input-longtext')!;
		field.dispatchEvent(new FocusEvent('focus'));
		field.textContent = 'Final';
		field.dispatchEvent(new FocusEvent('blur'));
		expect(shell.editorText()).toBe('---\ntitle: Final\ntags:\n  - work\n---\nBody\n');
		// The same element stays (the field keeps the focus while editing).
		expect(property(editorEl(), 'title')!.querySelector('.metadata-input-longtext')).toBe(field);
		shell.app.commands.executeCommandById('editor:save-file');
		await vi.waitFor(() => expect(shell.backend.read('Note.md')).resolves.toBe('---\ntitle: Final\ntags:\n  - work\n---\nBody\n'));
	});

	it('shows them in the reading view too', async () => {
		shell.app.commands.executeCommandById('markdown:toggle-preview');
		await vi.waitFor(() => expect(property(readingEl(), 'tags')).not.toBeNull());
		expect(readingEl().querySelector('.markdown-preview-sizer > .mod-header > .metadata-container')).not.toBeNull();
		expect(readingEl().querySelector('.multi-select-pill')?.textContent).toBe('work');
		shell.app.commands.executeCommandById('markdown:toggle-preview');
	});

	it('follows "Properties in document"', async () => {
		shell.app.vault.setConfig('propertiesInDocument', 'source');
		await vi.waitFor(() => expect(editorEl().querySelector('.cm-properties-widget')).toBeNull());
		expect(editorEl().querySelector('.cm-line')!.textContent).toBe('---');
		shell.app.vault.setConfig('propertiesInDocument', 'hidden');
		await vi.waitFor(() => expect(editorEl().querySelector('.cm-line')!.textContent).toBe('Body'));
		shell.app.vault.setConfig('propertiesInDocument', 'visible');
		await vi.waitFor(() => expect(editorEl().querySelector('.cm-properties-widget')).not.toBeNull());
	});

	it('adds a property with ⌘;, creating the frontmatter if needed', async () => {
		await shell.app.vault.create('Plain.md', 'Just text\n');
		await shell.app.workspace.openLinkText('Plain', '');
		await vi.waitFor(() => expect(shell.editorText()).toBe('Just text\n'));
		shell.press(';', { mod: true });
		const name = await vi.waitFor(() => {
			const el = editorEl().querySelector<HTMLInputElement>('.metadata-property.is-new .metadata-property-key-input');
			if (!el) throw new Error('no new property');
			return el;
		});
		name.value = 'status';
		name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		expect(shell.editorText()).toBe('---\nstatus:\n---\nJust text\n');
	});
});
