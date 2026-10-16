/**
 * Default canvas styles. Colours use the app's theme variables, so themes
 * restyle the canvas through the same variables as the rest of the app.
 */
export const CANVAS_CSS = `
.canvas-wrapper {
	position: relative;
	overflow: hidden;
	width: 100%;
	height: 100%;
	outline: none;
	touch-action: none;
	user-select: none;
	background-color: var(--canvas-background, var(--background-primary));
	background-image: radial-gradient(var(--canvas-dot-pattern, var(--background-modifier-border, #ccc)) 1px, transparent 1px);
	background-size: 20px 20px;
	--canvas-color: var(--canvas-default-color, var(--text-faint, #8f9893));
}
.canvas-wrapper .canvas { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.canvas-edges { position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; pointer-events: none; }
.canvas-edge { pointer-events: auto; color: var(--canvas-color); }
.canvas-edge-hit { fill: none; stroke: transparent; stroke-width: 14px; cursor: pointer; }
.canvas-edge-line { fill: none; stroke: currentColor; stroke-width: calc(2px / var(--canvas-zoom, 1)); }
.canvas-edge-arrow { fill: currentColor; }
.canvas-edge.is-selected .canvas-edge-arrow { fill: var(--interactive-accent); }
.canvas-edge-line.is-pending { stroke: var(--interactive-accent); stroke-dasharray: 6 4; }
.canvas-edge.is-selected .canvas-edge-line { stroke: var(--interactive-accent); }
.canvas-edge-label { fill: var(--text-normal); font: 13px var(--font-interface, sans-serif); paint-order: stroke; stroke: var(--background-primary); stroke-width: 4px; }
.canvas-node {
	position: absolute;
	box-sizing: border-box;
	border: 2px solid var(--canvas-color);
	border-radius: 8px;
	background: var(--background-primary);
	box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}
.canvas-node:not(.is-group) { background: color-mix(in srgb, var(--canvas-color) 6%, var(--background-primary)); }
.canvas-node.is-selected { outline: 2px solid var(--interactive-accent); outline-offset: 2px; }
.canvas-node.is-group { background: color-mix(in srgb, var(--canvas-color) 8%, transparent); box-shadow: none; }
.canvas-node-content { width: 100%; height: 100%; overflow: auto; padding: 8px 12px; box-sizing: border-box; font-size: 14px; line-height: 1.5; color: var(--text-normal); white-space: pre-wrap; }
.canvas-node.is-group .canvas-node-content { display: none; }
.canvas-node.is-file .canvas-node-content { font-weight: 600; }
.canvas-group-label { position: absolute; bottom: 100%; left: 0; margin-bottom: 4px; padding: 2px 8px; border-radius: 6px; background: var(--canvas-color); color: var(--text-on-accent, #fff); font-size: 13px; white-space: nowrap; }
.canvas-node-editor { width: 100%; height: 100%; border: 0; outline: none; resize: none; background: transparent; color: inherit; font: inherit; }
.canvas-node-resizer { position: absolute; right: -6px; bottom: -6px; width: 12px; height: 12px; cursor: nwse-resize; }
.canvas-node-connection-point { position: absolute; width: 10px; height: 10px; margin: -5px; border-radius: 50%; background: var(--interactive-accent); opacity: 0; cursor: crosshair; }
.canvas-node:hover > .canvas-node-connection-point, .canvas-node.is-selected > .canvas-node-connection-point { opacity: 1; }
.canvas-node-connection-point[data-side="top"] { left: 50%; top: 0; }
.canvas-node-connection-point[data-side="bottom"] { left: 50%; top: 100%; }
.canvas-node-connection-point[data-side="left"] { left: 0; top: 50%; }
.canvas-node-connection-point[data-side="right"] { left: 100%; top: 50%; }
.mod-canvas-color-1 { --canvas-color: var(--color-red, #e93147); }
.mod-canvas-color-2 { --canvas-color: var(--color-orange, #ec7500); }
.mod-canvas-color-3 { --canvas-color: var(--color-yellow, #e0ac00); }
.mod-canvas-color-4 { --canvas-color: var(--color-green, #08b94e); }
.mod-canvas-color-5 { --canvas-color: var(--color-cyan, #00bfbc); }
.mod-canvas-color-6 { --canvas-color: var(--color-purple, #7852ee); }
`;
