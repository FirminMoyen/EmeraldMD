/**
 * Icons. Plugins name icons by Lucide id ("dice-5", or "lucide-dice-5") or by
 * a custom id registered with `addIcon` (SVG content in a 0 0 100 100 box).
 * Rendered icons are `<svg class="svg-icon lucide-…">`, which themes style.
 */

import { icons as lucide } from 'lucide';

type IconNode = [tag: string, attrs: Record<string, string | number | undefined>][];

const SVG_NS = 'http://www.w3.org/2000/svg';

const customIcons = new Map<string, string>();

/** Icon ids from before Obsidian adopted Lucide that plugins still pass. */
const LEGACY_ALIASES: Record<string, string> = {
	'any-key': 'keyboard',
	'bullet-list': 'list',
	'calendar-with-checkmark': 'calendar-check',
	checkmark: 'check',
	cross: 'x',
	dice: 'dice-5',
	document: 'file',
	documents: 'files',
	enter: 'corner-down-left',
	gear: 'settings',
	'go-to-file': 'file-symlink',
	hashtag: 'hash',
	help: 'help-circle',
	'left-arrow': 'arrow-left',
	'magnifying-glass': 'search',
	'pdf-file': 'file-text',
	'popup-open': 'external-link',
	'price-tag': 'tag',
	reset: 'rotate-ccw',
	'right-arrow': 'arrow-right',
	'right-triangle': 'chevron-right',
	sync: 'refresh-cw',
	switch: 'repeat',
	'three-horizontal-bars': 'menu',
	'links-coming-in': 'arrow-down-left',
	'links-going-out': 'arrow-up-right',
	trash: 'trash-2',
	'up-and-down-arrows': 'arrow-up-down',
	'vertical-three-dots': 'more-vertical',
	'wrench-screwdriver-glyph': 'wrench',
};

function pascalCase(id: string): string {
	return id
		.split('-')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');
}

function lucideNode(id: string): IconNode | null {
	const name = id.startsWith('lucide-') ? id.slice('lucide-'.length) : id;
	const icons = lucide as unknown as Record<string, IconNode>;
	return icons[pascalCase(LEGACY_ALIASES[name] ?? name)] ?? null;
}

function lucideClassName(id: string): string {
	return id.startsWith('lucide-') ? id : `lucide-${id}`;
}

export function addIcon(iconId: string, svgContent: string): void {
	customIcons.set(iconId, svgContent);
}

export function removeIcon(iconId: string): void {
	customIcons.delete(iconId);
}

export function getIcon(iconId: string): SVGSVGElement | null {
	const custom = customIcons.get(iconId);
	if (custom !== undefined) {
		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('xmlns', SVG_NS);
		svg.setAttribute('viewBox', '0 0 100 100');
		svg.setAttribute('class', `svg-icon ${iconId}`);
		svg.innerHTML = custom;
		return svg;
	}
	const node = lucideNode(iconId);
	if (!node) return null;
	const svg = document.createElementNS(SVG_NS, 'svg');
	const attrs: Record<string, string> = {
		xmlns: SVG_NS,
		width: '24',
		height: '24',
		viewBox: '0 0 24 24',
		fill: 'none',
		stroke: 'currentColor',
		'stroke-width': '2',
		'stroke-linecap': 'round',
		'stroke-linejoin': 'round',
		class: `svg-icon ${lucideClassName(iconId)}`,
	};
	for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value);
	for (const [tag, childAttrs] of node) {
		const child = document.createElementNS(SVG_NS, tag);
		for (const [name, value] of Object.entries(childAttrs)) {
			if (value !== undefined) child.setAttribute(name, String(value));
		}
		svg.appendChild(child);
	}
	return svg;
}

export function getIconIds(): string[] {
	const ids = Object.keys(lucide).map(
		(name) =>
			'lucide-' +
			name
				.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
				.replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
				.toLowerCase(),
	);
	return [...customIcons.keys(), ...new Set(ids)];
}

/** Replaces `parent`'s content with the icon. Unknown ids leave it empty. */
export function setIcon(parent: HTMLElement, iconId: string): void {
	parent.replaceChildren();
	const svg = getIcon(iconId);
	if (svg) parent.appendChild(svg);
}
