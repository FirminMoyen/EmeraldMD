/**
 * MathJax 3 (TeX in, SVG out), in its own chunk: loaded the first time a
 * note has math. SVG output needs no font files; `fontCache: 'local'`
 * keeps each formula self-contained.
 */

import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { browserAdaptor } from 'mathjax-full/js/adaptors/browserAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';

RegisterHTMLHandler(browserAdaptor());

const output = new SVG({ fontCache: 'local' });
// Formulas are converted one at a time, so the root only has to be a DOM
// node MathJax accepts (test DOMs do not always pass its Document check).
const acceptsDocument = (node: unknown): boolean => node instanceof window.Document;
const root = acceptsDocument(document) ? document : document.createDocumentFragment();
const doc = mathjax.document(root, { InputJax: new TeX({ packages: AllPackages }), OutputJax: output });
// The few rules the SVG output needs (display formulas centred, overflow…).
document.head.appendChild(output.styleSheet(doc) as unknown as Node);

/** A `mjx-container` with the formula as SVG. */
export function tex2svg(source: string, display: boolean): HTMLElement {
	return doc.convert(source, { display }) as HTMLElement;
}

export const version: string = mathjax.version;
