import type { EventRef } from '@emeraldmd/core';

/** Base class for everything with a load/unload lifecycle: plugins, views, render children. */
export class Component {
	/** @internal */
	_loaded = false;
	/** @internal Cleanup callbacks, run on unload. */
	_events: (() => unknown)[] = [];
	/** @internal */
	_children: Component[] = [];

	load(): void {
		if (this._loaded) return;
		this._loaded = true;
		this.onload();
		for (const child of [...this._children]) child.load();
	}

	onload(): void {}

	unload(): void {
		if (!this._loaded) return;
		this._loaded = false;
		for (let child = this._children.pop(); child; child = this._children.pop()) child.unload();
		for (const cb of this._events.splice(0)) {
			try {
				cb();
			} catch (err) {
				console.error(err);
			}
		}
		this.onunload();
	}

	onunload(): void {}

	addChild<T extends Component>(component: T): T {
		this._children.push(component);
		if (this._loaded) component.load();
		return component;
	}

	removeChild<T extends Component>(component: T): T {
		const i = this._children.indexOf(component);
		if (i !== -1) {
			this._children.splice(i, 1);
			component.unload();
		}
		return component;
	}

	register(cb: () => unknown): void {
		this._events.push(cb);
	}

	registerEvent(eventRef: EventRef): void {
		this.register(() => eventRef.e.offref(eventRef));
	}

	registerDomEvent(
		el: Window | Document | HTMLElement,
		type: string,
		callback: (this: HTMLElement, ev: Event) => unknown,
		options?: boolean | AddEventListenerOptions,
	): void {
		const listener = callback as EventListener;
		el.addEventListener(type, listener, options);
		this.register(() => el.removeEventListener(type, listener, options));
	}

	/** Not in the public typings, but used by plugins: unregisters a scope handler on unload. */
	registerScopeEvent(handler: { scope: { unregister(handler: unknown): void } }): void {
		this.register(() => handler.scope.unregister(handler));
	}

	registerInterval(id: number): number {
		this.register(() => clearInterval(id));
		return id;
	}
}

/**
 * Like `component.load()`, but waits for an async `onload` (plugins may
 * return a promise from it). Children added during `onload` load
 * immediately because the component already counts as loaded.
 */
export async function loadAsync(component: Component): Promise<void> {
	if (component._loaded) return;
	component._loaded = true;
	await (component.onload() as unknown as Promise<void> | void);
	for (const child of [...component._children]) child.load();
}
