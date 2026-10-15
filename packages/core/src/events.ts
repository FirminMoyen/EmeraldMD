// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Callback = (...data: any[]) => unknown;

export interface EventRef {
	e: Events;
	name: string;
	fn: Callback;
	ctx?: unknown;
}

/** Minimal event emitter with the same shape as the plugin API's `Events` class. */
export class Events {
	private _events: Record<string, EventRef[]> = {};

	on(name: string, callback: Callback, ctx?: unknown): EventRef {
		const ref: EventRef = { e: this, name, fn: callback, ctx };
		(this._events[name] ??= []).push(ref);
		return ref;
	}

	off(name: string, callback: Callback): void {
		const refs = this._events[name];
		if (!refs) return;
		this._events[name] = refs.filter((ref) => ref.fn !== callback);
	}

	offref(ref: EventRef): void {
		const refs = this._events[ref.name];
		if (!refs) return;
		this._events[ref.name] = refs.filter((r) => r !== ref);
	}

	trigger(name: string, ...data: unknown[]): void {
		for (const ref of [...(this._events[name] ?? [])]) {
			this.tryTrigger(ref, data);
		}
	}

	tryTrigger(ref: EventRef, args: unknown[]): void {
		try {
			ref.fn.apply(ref.ctx, args);
		} catch (err) {
			console.error(err);
		}
	}
}
