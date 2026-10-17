/**
 * Math (`$…$`, `$$…$$`) with MathJax, loaded on first use. The DOM is what
 * themes and plugins expect: `.math.math-inline` / `.math.math-block`
 * holding an `mjx-container`, with `is-loaded` once rendered.
 *
 * `loadMathJax`, `renderMath` and `finishRenderMath` are the plugin API;
 * `window.MathJax` offers `tex2svg` (and `tex2chtml`, which here also returns
 * SVG) for plugins that call MathJax directly.
 */

type MathJaxModule = typeof import('./lazy/mathjax');

let module: MathJaxModule | null = null;
let loading: Promise<MathJaxModule> | null = null;

export function loadMathJax(): Promise<void> {
	loading ??= import('./lazy/mathjax').then((loaded) => {
		module = loaded;
		const tex = (source: string, options?: { display?: boolean }) => loaded.tex2svg(source, options?.display ?? false);
		(globalThis as Record<string, unknown>).MathJax = {
			version: loaded.version,
			tex2svg: tex,
			tex2chtml: tex,
			startup: { promise: Promise.resolve() },
			typesetPromise: async () => {},
		};
		return loaded;
	});
	return loading.then(() => undefined);
}

function fill(el: HTMLElement, source: string, display: boolean, mathjax: MathJaxModule): void {
	try {
		el.replaceChildren(mathjax.tex2svg(source, display));
		el.addClass('is-loaded');
	} catch (err) {
		el.setText(source);
		el.addClass('math-error');
		console.error('MathJax could not render', source, err);
	}
}

/** A formula; until MathJax has loaded it shows its source, then fills itself in. */
export function renderMath(source: string, display: boolean): HTMLElement {
	const el = createEl(display ? 'div' : 'span', { cls: ['math', display ? 'math-block' : 'math-inline'] });
	if (module) {
		fill(el, source, display, module);
		return el;
	}
	el.setText(source);
	void loadMathJax()
		.then(() => fill(el, source, display, module!))
		.catch((err: unknown) => console.error('MathJax could not load', err));
	return el;
}

/** Nothing to do: formulas carry their own SVG. */
export async function finishRenderMath(): Promise<void> {}
