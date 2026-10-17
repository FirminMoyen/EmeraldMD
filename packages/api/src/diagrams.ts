/**
 * Mermaid diagrams (```mermaid code blocks), loaded on first use and drawn
 * into `.mermaid` elements, as in Obsidian. `loadMermaid()` (plugin API)
 * returns the mermaid object.
 */

type Mermaid = typeof import('./lazy/mermaid').default;

let loading: Promise<Mermaid> | null = null;
let counter = 0;

export function loadMermaid(): Promise<Mermaid> {
	loading ??= import('./lazy/mermaid').then((m) => m.default);
	return loading;
}

/** Draws the diagram into `el` (replacing its content); errors are shown in place. */
export async function renderMermaid(source: string, el: HTMLElement): Promise<void> {
	try {
		const mermaid = await loadMermaid();
		const dark = document.body.classList.contains('theme-dark');
		mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
		const { svg } = await mermaid.render(`emerald-mermaid-${++counter}`, source);
		// Parsed as SVG, not HTML, so nothing in it runs.
		const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
		el.replaceChildren(document.importNode(parsed, true));
		el.removeClass('mermaid-error');
	} catch (err) {
		el.addClass('mermaid-error');
		el.setText(`Mermaid: ${err instanceof Error ? err.message : String(err)}`);
	}
}
