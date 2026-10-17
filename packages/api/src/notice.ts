/** A transient message in the top-right corner (`.notice-container > .notice`). */

const DEFAULT_DURATION_MS = 5000;

function noticeContainer(): HTMLElement {
	let container = document.body.querySelector<HTMLElement>(':scope > .notice-container');
	if (!container) {
		container = document.createElement('div');
		container.className = 'notice-container';
		document.body.appendChild(container);
	}
	return container;
}

export class Notice {
	/** @deprecated Same element as `messageEl`. */
	noticeEl: HTMLElement;
	containerEl: HTMLElement;
	messageEl: HTMLElement;
	private timer: ReturnType<typeof setTimeout> | undefined;

	/** @param duration Milliseconds before hiding; 0 keeps it until clicked. */
	constructor(message: string | DocumentFragment, duration?: number) {
		this.containerEl = noticeContainer().createDiv('notice');
		this.messageEl = this.containerEl.createDiv('notice-message');
		this.noticeEl = this.messageEl;
		this.setMessage(message);
		this.containerEl.addEventListener('click', () => this.hide());
		const ms = duration ?? DEFAULT_DURATION_MS;
		if (ms > 0) this.timer = setTimeout(() => this.hide(), ms);
	}

	setMessage(message: string | DocumentFragment): this {
		this.messageEl.setText(message);
		return this;
	}

	hide(): void {
		clearTimeout(this.timer);
		this.containerEl.detach();
	}
}
