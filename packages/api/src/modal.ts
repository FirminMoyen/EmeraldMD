import type { App } from './app';
import { setIcon } from './icons';
import { Scope } from './keymap';

/**
 * A dialog over the workspace. DOM, using the class names themes target:
 * `.modal-container.mod-dim > .modal-bg + .modal > .modal-close-button + .modal-header > .modal-title, .modal-content`.
 */
export class Modal {
	app: App;
	scope: Scope;
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;
	shouldRestoreSelection = true;
	/** @internal */
	isOpen = false;
	private closeCallback: (() => unknown) | null = null;
	private restoreFocusEl: Element | null = null;

	constructor(app: App) {
		this.app = app;
		this.scope = new Scope();
		this.scope.register([], 'Escape', () => {
			this.close();
			return false;
		});
		this.containerEl = createDiv('modal-container mod-dim');
		this.containerEl.createDiv('modal-bg').addEventListener('click', () => this.close());
		this.modalEl = this.containerEl.createDiv('modal');
		const closeButton = this.modalEl.createDiv({ cls: 'modal-close-button', attr: { 'aria-label': 'Close' } });
		setIcon(closeButton, 'x');
		closeButton.addEventListener('click', () => this.close());
		const header = this.modalEl.createDiv('modal-header');
		this.titleEl = header.createDiv('modal-title');
		this.contentEl = this.modalEl.createDiv('modal-content');
	}

	open(): void {
		if (this.isOpen) return;
		this.isOpen = true;
		this.restoreFocusEl = document.activeElement;
		document.body.appendChild(this.containerEl);
		this.app.keymap.pushScope(this.scope);
		this.app.openModals.push(this);
		try {
			const result = this.onOpen() as unknown;
			if (result instanceof Promise) result.catch((err: unknown) => console.error(err));
		} catch (err) {
			console.error(err);
		}
	}

	onHistoryBack(): void {
		this.close();
	}

	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.app.keymap.popScope(this.scope);
		this.app.openModals.splice(this.app.openModals.indexOf(this), 1);
		this.containerEl.detach();
		try {
			this.onClose();
		} catch (err) {
			console.error(err);
		}
		if (this.shouldRestoreSelection && this.restoreFocusEl instanceof HTMLElement && this.restoreFocusEl.isConnected) {
			this.restoreFocusEl.focus();
		}
		this.restoreFocusEl = null;
		this.closeCallback?.();
	}

	onOpen(): Promise<void> | void {}

	onClose(): void {}

	setTitle(title: string): this {
		this.titleEl.setText(title);
		return this;
	}

	setContent(content: string | DocumentFragment): this {
		this.contentEl.setText(content);
		return this;
	}

	setCloseCallback(callback: () => unknown): this {
		this.closeCallback = callback;
		return this;
	}
}
