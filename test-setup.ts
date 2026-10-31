/**
 * Runs before every test file. CodeMirror schedules timers (measuring,
 * observing the DOM) that can fire after a file's tests end, when happy-dom
 * has closed its window: they then throw "requestAnimationFrame is not a
 * function". Destroying the editors left in the page cancels them.
 */

import { afterAll } from 'vitest';

afterAll(async () => {
	if (typeof document === 'undefined') return;
	const { EditorView } = await import('@codemirror/view');
	for (const el of document.querySelectorAll<HTMLElement>('.cm-editor')) EditorView.findFromDOM(el)?.destroy();
});
