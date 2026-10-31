// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasView, type CanvasData } from '../src';

afterEach(() => document.body.replaceChildren());

function canvas(data: CanvasData = { nodes: [], edges: [] }, options: ConstructorParameters<typeof CanvasView>[1] = {}) {
	const changes: CanvasData[] = [];
	const view = new CanvasView(document.body.appendChild(document.createElement('div')), { ...options, onChange: (d) => changes.push(JSON.parse(JSON.stringify(d))) });
	view.setData(data);
	return { view, changes };
}

describe('canvas editing from the app', () => {
	it('adds cards, colours them, groups them, and undoes and redoes', () => {
		const { view, changes } = canvas();
		const [a, b] = view.addNodes(
			[
				{ type: 'text', text: 'A', width: 200, height: 60 },
				{ type: 'file', file: 'Note.md', width: 200, height: 100 },
			],
			{ x: 0, y: 0 },
		);
		expect(view.getData().nodes.map((n) => n.type)).toEqual(['text', 'file']);
		expect(b!.y).toBeGreaterThan(a!.y);
		expect(view.getSelection().nodes).toHaveLength(2);

		view.setColor('4');
		expect(view.getData().nodes.every((n) => n.color === '4')).toBe(true);
		expect(view.el.querySelectorAll('.canvas-node.mod-canvas-color-4')).toHaveLength(2);

		const group = view.groupSelection('Pair')!;
		expect(view.getData().nodes[0]).toBe(group);
		expect(group.x).toBeLessThan(a!.x);
		expect(group.width).toBeGreaterThan(200);
		expect(changes).toHaveLength(3);

		view.undo();
		expect(view.getData().nodes).toHaveLength(2);
		view.undo();
		expect(view.getData().nodes.every((n) => !n.color)).toBe(true);
		view.redo();
		expect(view.getData().nodes.every((n) => n.color === '4')).toBe(true);
		// A new edit drops what could be redone.
		expect(view.canRedo()).toBe(true);
		view.addNodes([{ type: 'text', text: 'C', width: 100, height: 40 }]);
		expect(view.canRedo()).toBe(false);
	});

	it('labels and removes edges, and undoes with ⌘Z', () => {
		const data: CanvasData = {
			nodes: [
				{ id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
				{ id: 'b', type: 'text', text: 'B', x: 300, y: 0, width: 100, height: 60 },
			],
			edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
		};
		const { view } = canvas(data);
		const edge = view.getData().edges[0]!;
		view.setEdgeLabel(edge, 'leads to');
		expect(view.el.querySelector('.canvas-edge-label')?.textContent).toBe('leads to');
		view.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }));
		expect(view.getData().edges[0]!.label).toBeUndefined();
	});

	it('hands right-clicks and drops to the app, with what was clicked selected', () => {
		const onContextMenu = vi.fn();
		const onDrop = vi.fn(() => true);
		const data: CanvasData = { nodes: [{ id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 }], edges: [] };
		const { view } = canvas(data, { onContextMenu, onDrop });
		view.el.querySelector('.canvas-node')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		expect(onContextMenu).toHaveBeenCalledTimes(1);
		expect(onContextMenu.mock.calls[0]![1]).toEqual({ node: view.getData().nodes[0], edge: undefined, at: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }) });
		expect(view.getSelection().nodes.map((n) => n.id)).toEqual(['a']);
		view.el.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
		expect(onDrop).toHaveBeenCalled();
	});
});
