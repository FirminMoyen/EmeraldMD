// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import '../src';
import { MarkdownEditView, MarkdownPreviewView, MarkdownView } from '../src';
import { createTestApp } from '../src/testing';

it("gives a note view its edit and reading modes, as Obsidian's classes", async () => {
	const { app } = await createTestApp({ 'A.md': 'alpha' });
	const leaf = app.workspace.rootLeaf;
	const view = new MarkdownView(leaf);
	view.file = app.vault.getFileByPath('A.md');
	view.data = 'alpha';
	expect(view.editMode).toBeInstanceOf(MarkdownEditView);
	expect(view.previewMode).toBeInstanceOf(MarkdownPreviewView);
	expect(view.currentMode).toBe(view.editMode);
	expect(view.previewMode.file?.path).toBe('A.md');
	expect(view.editMode.file?.path).toBe('A.md');
	expect(view.editMode.getSelection()).toBe('');
	view.previewMode.applyScroll(0);
	expect(view.previewMode.getScroll()).toBe(0);
});
