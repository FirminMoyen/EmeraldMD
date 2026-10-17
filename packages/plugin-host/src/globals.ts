/**
 * Globals that plugins use without importing them. Observed in open-source
 * plugins (see docs/compat/internals.md):
 *
 * - `app` and `moment`, instead of `this.app` and the `obsidian` export.
 * - `CodeMirror`: the CodeMirror 5 mode registry, where plugins register
 *   syntax modes for their code blocks (`defineMode`, `getMode`, `modes`).
 *   EmeraldMD keeps the registry so those calls work; nothing highlights
 *   code blocks with it yet.
 * - `CodeMirrorAdapter`: Vim mode's adapter; plugins add to its `commands`.
 *   There is no Vim mode yet, so it is an empty adapter.
 */

import { moment, type App } from '@emeraldmd/api';

type ModeFactory = (config: unknown, spec?: unknown) => unknown;

interface Stream {
	skipToEnd(): void;
}

function createModeRegistry() {
	const modes: Record<string, ModeFactory> = {};
	const mimeModes: Record<string, unknown> = {};
	const nullMode = () => ({ name: 'null', token: (stream: Stream) => (stream.skipToEnd(), null) });
	modes.null = nullMode;
	return {
		modes,
		mimeModes,
		defineMode(name: string, factory: ModeFactory, ...deps: string[]): void {
			void deps;
			modes[name] = factory;
		},
		defineMIME(mime: string, spec: unknown): void {
			mimeModes[mime] = spec;
		},
		getMode(config: unknown, spec: unknown): unknown {
			const resolved = typeof spec === 'string' ? (mimeModes[spec] ?? spec) : spec;
			const name = typeof resolved === 'string' ? resolved : (resolved as { name?: string } | null)?.name;
			const factory = (name && modes[name]) || nullMode;
			return factory(config, resolved);
		},
		findModeByName(name: string): { name: string; mode: string } | null {
			return modes[name] ? { name, mode: name } : null;
		},
	};
}

/** Sets the globals for `app`. Existing `CodeMirror`/`CodeMirrorAdapter` globals are kept. */
export function installPluginGlobals(app: App): void {
	const g = globalThis as Record<string, unknown>;
	g.app = app;
	g.moment = moment;
	g.CodeMirror ??= createModeRegistry();
	g.CodeMirrorAdapter ??= { commands: {} };
}
