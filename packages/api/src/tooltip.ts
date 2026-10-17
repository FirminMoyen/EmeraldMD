export type TooltipPlacement = 'bottom' | 'right' | 'left' | 'top';

export interface TooltipOptions {
	placement?: TooltipPlacement;
	classes?: string[];
	gap?: number;
	delay?: number;
}

let activeTooltip: HTMLElement | null = null;
let tooltipTimer: ReturnType<typeof setTimeout> | undefined;

function hideTooltip(): void {
	clearTimeout(tooltipTimer);
	activeTooltip?.remove();
	activeTooltip = null;
}

/** Shows a tooltip next to `targetEl` until the pointer leaves it. */
export function displayTooltip(targetEl: HTMLElement, content: string | DocumentFragment, options: TooltipOptions = {}): void {
	hideTooltip();
	const tooltip = document.body.createDiv({ cls: ['tooltip', ...(options.classes ?? [])] });
	tooltip.setText(content);
	const placement = options.placement ?? 'bottom';
	const gap = options.gap ?? 8;
	tooltip.dataset.placement = placement;
	const rect = targetEl.getBoundingClientRect();
	const tip = tooltip.getBoundingClientRect();
	let left = rect.left + rect.width / 2 - tip.width / 2;
	let top = rect.bottom + gap;
	if (placement === 'top') top = rect.top - tip.height - gap;
	if (placement === 'left' || placement === 'right') {
		top = rect.top + rect.height / 2 - tip.height / 2;
		left = placement === 'left' ? rect.left - tip.width - gap : rect.right + gap;
	}
	tooltip.style.left = `${Math.max(4, Math.min(left, window.innerWidth - tip.width - 4))}px`;
	tooltip.style.top = `${Math.max(4, top)}px`;
	activeTooltip = tooltip;
	targetEl.addEventListener('mouseleave', hideTooltip, { once: true });
}

const tooltipOptions = new WeakMap<HTMLElement, TooltipOptions>();

function onTooltipHover(this: HTMLElement): void {
	const text = this.getAttribute('aria-label');
	if (!text) return;
	const options = tooltipOptions.get(this) ?? {};
	clearTimeout(tooltipTimer);
	tooltipTimer = setTimeout(() => {
		if (this.matches(':hover')) displayTooltip(this, text, options);
	}, options.delay ?? 500);
}

/** Sets the hover tooltip of `el`; an empty string removes it. */
export function setTooltip(el: HTMLElement, tooltip: string, options?: TooltipOptions): void {
	if (!tooltip) {
		el.removeAttribute('aria-label');
		el.removeEventListener('mouseenter', onTooltipHover);
		return;
	}
	el.setAttribute('aria-label', tooltip);
	if (options?.placement) el.setAttribute('data-tooltip-position', options.placement);
	tooltipOptions.set(el, options ?? {});
	el.addEventListener('mouseenter', onTooltipHover);
}
