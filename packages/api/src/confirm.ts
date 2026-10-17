/** A yes/no question in a modal, for app-level prompts ("Update links?"). */

import type { App } from './app';
import { Modal } from './modal';

export interface ConfirmOptions {
	title: string;
	message: string;
	/** Label of the button that answers yes. */
	confirm: string;
	/** Label of the button that answers no. */
	cancel?: string;
}

class ConfirmModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly options: ConfirmOptions,
		private readonly resolve: (yes: boolean) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { title, message, confirm, cancel = 'Cancel' } = this.options;
		this.titleEl.setText(title);
		this.contentEl.createEl('p', { text: message });
		const buttons = this.contentEl.createDiv('modal-button-container');
		buttons.createEl('button', { text: cancel }).addEventListener('click', () => this.answer(false));
		const yes = buttons.createEl('button', { cls: 'mod-cta', text: confirm });
		yes.addEventListener('click', () => this.answer(true));
		yes.focus();
	}

	override onClose(): void {
		if (!this.answered) this.resolve(false);
	}

	private answer(yes: boolean): void {
		this.answered = true;
		this.resolve(yes);
		this.close();
	}
}

/** Asks the user; closing the dialog counts as no. */
export function confirmAction(app: App, options: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => new ConfirmModal(app, options, resolve).open());
}
