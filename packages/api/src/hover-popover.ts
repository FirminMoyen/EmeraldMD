/**
 * `HoverPopover`: a floating box next to an element, shown after a short
 * delay and hidden once the mouse has left both the element and the box
 * (plugin API). The Page preview core plugin fills it with a note.
 *
 * DOM: `.popover.hover-popover`, appended to the page while shown.
 */

import { Component } from './component';

export enum PopoverState {
	Showing,
	Shown,
	Hiding,
	Hidden,
}

/** Something that can own a popover (a view, a renderer…); it holds at most one at a time. */
export interface HoverParent {
	hoverPopover: HoverPopover | null;
}

export interface Point {
	x: number;
	y: number;
}

/** How long the mouse may be away from the link and the popover before it hides. */
const HIDE_DELAY = 300;
const GAP = 6;

export class HoverPopover extends Component {
	hoverEl: HTMLElement;
	state: PopoverState = PopoverState.Hidden;
	private readonly parent: HoverParent;
	/** The element the popover is shown for. */
	readonly targetEl: HTMLElement | null;
	private readonly staticPos: Point | null;
	private showTimer: ReturnType<typeof setTimeout> | null = null;
	private hideTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly cleanups: (() => void)[] = [];

	constructor(parent: HoverParent, targetEl: HTMLElement | null, waitTime = 300, staticPos: Point | null = null) {
		super();
		this.parent = parent;
		this.targetEl = targetEl;
		this.staticPos = staticPos;
		this.hoverEl = createDiv('popover hover-popover');
		parent.hoverPopover?.hide();
		parent.hoverPopover = this;
		this.state = PopoverState.Showing;
		this.showTimer = setTimeout(() => this.show(), Math.max(0, waitTime));
		const listen = (el: HTMLElement, type: string, fn: () => void) => {
			el.addEventListener(type, fn);
			this.cleanups.push(() => el.removeEventListener(type, fn));
		};
		for (const el of [targetEl, this.hoverEl]) {
			if (!el) continue;
			listen(el, 'mouseenter', () => this.cancelHide());
			listen(el, 'mouseleave', () => this.scheduleHide());
		}
		const onKey = (evt: KeyboardEvent) => {
			if (evt.key === 'Escape') this.hide();
		};
		const onDown = (evt: MouseEvent) => {
			if (!this.hoverEl.contains(evt.target as Node)) this.hide();
		};
		document.addEventListener('keydown', onKey, true);
		document.addEventListener('mousedown', onDown, true);
		this.cleanups.push(() => document.removeEventListener('keydown', onKey, true), () => document.removeEventListener('mousedown', onDown, true));
	}

	/** Called once the popover is on the page. */
	onShow(): void {}

	hide(): void {
		if (this.state === PopoverState.Hidden) return;
		if (this.showTimer) clearTimeout(this.showTimer);
		this.cancelHide();
		for (const cleanup of this.cleanups.splice(0)) cleanup();
		this.hoverEl.detach();
		this.state = PopoverState.Hidden;
		if (this.parent.hoverPopover === this) this.parent.hoverPopover = null;
		this.unload();
		this.onHide();
	}

	onHide(): void {}

	isPinned(): boolean {
		return false;
	}

	private show(): void {
		this.showTimer = null;
		if (this.state !== PopoverState.Showing) return;
		// The link may have gone (re-render) before the delay ended.
		if (this.targetEl && !this.targetEl.isConnected) return this.hide();
		document.body.appendChild(this.hoverEl);
		this.position();
		this.state = PopoverState.Shown;
		this.load();
		this.onShow();
	}

	/** Below the target, or above when there is no room; kept inside the window. */
	private position(): void {
		const box = this.hoverEl.getBoundingClientRect();
		const width = box.width || 400;
		const height = box.height || 300;
		let x: number;
		let y: number;
		if (this.staticPos) {
			({ x, y } = this.staticPos);
		} else if (this.targetEl) {
			const rect = this.targetEl.getBoundingClientRect();
			x = rect.left;
			y = rect.bottom + GAP;
			if (y + height > window.innerHeight && rect.top - GAP - height > 0) y = rect.top - GAP - height;
		} else {
			x = (window.innerWidth - width) / 2;
			y = (window.innerHeight - height) / 2;
		}
		x = Math.min(Math.max(GAP, x), Math.max(GAP, window.innerWidth - width - GAP));
		y = Math.min(Math.max(GAP, y), Math.max(GAP, window.innerHeight - height - GAP));
		this.hoverEl.style.left = `${x}px`;
		this.hoverEl.style.top = `${y}px`;
	}

	private scheduleHide(): void {
		this.cancelHide();
		this.hideTimer = setTimeout(() => this.hide(), HIDE_DELAY);
	}

	private cancelHide(): void {
		if (this.hideTimer) clearTimeout(this.hideTimer);
		this.hideTimer = null;
	}
}
