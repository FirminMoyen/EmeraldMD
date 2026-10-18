/** Context menus: `.menu > .menu-item > .menu-item-icon + .menu-item-title`. */

import { Component } from './component';
import { setIcon } from './icons';

export interface MenuPositionDef {
	x: number;
	y: number;
	width?: number;
	overlap?: boolean;
	left?: boolean;
}

export class MenuItem {
	/** @internal */
	dom: HTMLElement;
	/** @internal */
	section = '';
	private iconEl: HTMLElement;
	private titleEl: HTMLElement;
	private callback: ((evt: MouseEvent | KeyboardEvent) => unknown) | null = null;
	private disabled = false;
	private readonly menu: Menu;
	/** @internal The menu shown next to this item (`setSubmenu`). */
	submenu: Menu | null = null;

	/** @internal Created by `Menu.addItem`. */
	constructor(menu: Menu) {
		this.menu = menu;
		this.dom = createDiv('menu-item');
		this.iconEl = this.dom.createDiv('menu-item-icon');
		this.titleEl = this.dom.createDiv('menu-item-title');
		this.dom.addEventListener('click', (evt) => this.handleEvent(evt));
		this.dom.addEventListener('mouseenter', () => {
			this.menu.select(this);
			if (this.submenu) this.menu.openSubmenu(this);
			else this.menu.closeSubmenu();
		});
	}

	/** A menu shown next to this item, to add items to. */
	setSubmenu(): Menu {
		if (!this.submenu) {
			this.submenu = new Menu();
			this.submenu.parentMenu = this.menu;
			this.dom.addClass('has-submenu');
			setIcon(this.dom.createDiv('menu-item-icon mod-submenu'), 'chevron-right');
		}
		return this.submenu;
	}

	/** @internal */
	handleEvent(evt: MouseEvent | KeyboardEvent): void {
		if (this.disabled) return;
		if (this.submenu) {
			this.menu.openSubmenu(this);
			return;
		}
		this.menu.root().hide();
		try {
			const result = this.callback?.(evt);
			if (result instanceof Promise) result.catch((err: unknown) => console.error(err));
		} catch (err) {
			console.error(err);
		}
	}

	setTitle(title: string | DocumentFragment): this {
		this.titleEl.setText(title);
		return this;
	}

	setIcon(icon: string | null): this {
		if (icon) setIcon(this.iconEl, icon);
		else this.iconEl.empty();
		return this;
	}

	setChecked(checked: boolean | null): this {
		this.dom.toggleClass('mod-checked', checked === true);
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		this.dom.toggleClass('is-disabled', disabled);
		return this;
	}

	setWarning(isWarning: boolean): this {
		this.dom.toggleClass('mod-warning', isWarning);
		return this;
	}

	setIsLabel(isLabel: boolean): this {
		this.dom.toggleClass('is-label', isLabel);
		return this;
	}

	onClick(callback: (evt: MouseEvent | KeyboardEvent) => unknown): this {
		this.callback = callback;
		return this;
	}

	setSection(section: string): this {
		this.section = section;
		return this;
	}
}

export class MenuSeparator {
	/** @internal */
	dom = createDiv('menu-separator');
}

export class Menu extends Component {
	/** @internal */
	dom: HTMLElement;
	/** @internal */
	items: (MenuItem | MenuSeparator)[] = [];
	private selected: MenuItem | null = null;
	private hideCallbacks: (() => unknown)[] = [];
	private parentEl: HTMLElement | null = null;
	/** @internal The menu this one is a submenu of. */
	parentMenu: Menu | null = null;
	private openedSubmenu: Menu | null = null;

	constructor() {
		super();
		this.dom = createDiv('menu');
		this.dom.tabIndex = -1;
		this.dom.addEventListener('keydown', (evt) => this.onKeyDown(evt));
	}

	setNoIcon(): this {
		this.dom.addClass('mod-no-icon');
		return this;
	}

	setUseNativeMenu(_useNativeMenu: boolean): this {
		return this;
	}

	addItem(cb: (item: MenuItem) => unknown): this {
		const item = new MenuItem(this);
		this.items.push(item);
		cb(item);
		return this;
	}

	addSeparator(): this {
		this.items.push(new MenuSeparator());
		return this;
	}

	setParentElement(el: HTMLElement): this {
		this.parentEl = el;
		return this;
	}

	showAtMouseEvent(evt: MouseEvent): this {
		evt.preventDefault();
		return this.showAtPosition({ x: evt.clientX, y: evt.clientY });
	}

	showAtPosition(position: MenuPositionDef, doc: Document = document): this {
		this.render();
		doc.body.appendChild(this.dom);
		const rect = this.dom.getBoundingClientRect();
		const win = doc.defaultView ?? window;
		let x = position.left ? position.x - rect.width : position.x;
		let y = position.y;
		if (x + rect.width > win.innerWidth) x = Math.max(0, win.innerWidth - rect.width - 4);
		if (y + rect.height > win.innerHeight) y = Math.max(0, win.innerHeight - rect.height - 4);
		this.dom.style.left = `${Math.max(0, x)}px`;
		this.dom.style.top = `${y}px`;
		this.load();
		// A submenu closes with its menu.
		if (this.parentMenu) return this;
		// Close on the next outside click or Escape.
		setTimeout(() => {
			this.registerDomEvent(doc, 'mousedown', (e: Event) => {
				if (!this.contains(e.target as Node)) this.hide();
			});
		});
		this.registerDomEvent(doc, 'keydown', (e: Event) => {
			if ((e as KeyboardEvent).key === 'Escape') this.hide();
		});
		this.dom.focus();
		return this;
	}

	onHistoryBack(): void {
		this.hide();
	}

	/** @internal The outermost menu. */
	root(): Menu {
		return this.parentMenu ? this.parentMenu.root() : this;
	}

	/** @internal Whether `node` is in this menu or one of its open submenus. */
	contains(node: Node): boolean {
		return this.dom.contains(node) || Boolean(this.openedSubmenu?.contains(node));
	}

	/** @internal Shows an item's submenu next to it. */
	openSubmenu(item: MenuItem): void {
		if (!item.submenu || this.openedSubmenu === item.submenu) return;
		this.closeSubmenu();
		const rect = item.dom.getBoundingClientRect();
		this.openedSubmenu = item.submenu;
		item.submenu.showAtPosition({ x: rect.right, y: rect.top });
	}

	/** @internal */
	closeSubmenu(): void {
		this.openedSubmenu?.hide();
		this.openedSubmenu = null;
	}

	hide(): this {
		this.closeSubmenu();
		if (!this.dom.isConnected) return this;
		this.dom.detach();
		this.unload();
		for (const cb of this.hideCallbacks) cb();
		return this;
	}

	close(): void {
		this.hide();
	}

	onHide(callback: () => unknown): void {
		this.hideCallbacks.push(callback);
	}

	/** @internal */
	select(item: MenuItem | null): void {
		this.selected?.dom.removeClass('selected');
		this.selected = item;
		item?.dom.addClass('selected');
	}

	static forEvent(_evt: PointerEvent | MouseEvent): Menu {
		return new Menu();
	}

	private render(): void {
		this.dom.empty();
		if (this.parentEl || this.parentMenu) this.dom.addClass('mod-submenu');
		// Items with a section are grouped by section, in first-seen order.
		const sections: string[] = [];
		for (const item of this.items) {
			if (item instanceof MenuItem && !sections.includes(item.section)) sections.push(item.section);
		}
		let first = true;
		for (const section of sections) {
			if (!first) this.dom.appendChild(new MenuSeparator().dom);
			first = false;
			for (const item of this.items) {
				if (item instanceof MenuItem && item.section === section) this.dom.appendChild(item.dom);
				else if (item instanceof MenuSeparator && section === sections[0] && sections.length === 1) this.dom.appendChild(item.dom);
			}
		}
	}

	private onKeyDown(evt: KeyboardEvent): void {
		const items = this.items.filter((i): i is MenuItem => i instanceof MenuItem);
		if (items.length === 0) return;
		const index = this.selected ? items.indexOf(this.selected) : -1;
		if (evt.key === 'ArrowDown') this.select(items[(index + 1) % items.length]!);
		else if (evt.key === 'ArrowUp') this.select(items[(index - 1 + items.length) % items.length]!);
		else if (evt.key === 'Enter' && this.selected) this.selected.handleEvent(evt);
		else return;
		evt.preventDefault();
	}
}
