/**
 * The modules a plugin's `require` can return. Plugins mark `obsidian`,
 * `@codemirror/*` and `@lezer/*` as externals (see the official sample
 * plugin's build config), so these must be the same instances the editor
 * uses: a second copy of `@codemirror/state` breaks editor extensions.
 */

import * as cmAutocomplete from '@codemirror/autocomplete';
import * as cmCollab from '@codemirror/collab';
import * as cmCommands from '@codemirror/commands';
import * as cmLanguage from '@codemirror/language';
import * as cmLint from '@codemirror/lint';
import * as cmSearch from '@codemirror/search';
import * as cmState from '@codemirror/state';
import * as cmView from '@codemirror/view';
import { obsidianModule } from '@emeraldmd/api';
import * as lezerCommon from '@lezer/common';
import * as lezerHighlight from '@lezer/highlight';
import * as lezerLr from '@lezer/lr';
import moment from 'moment';

export const SHARED_MODULES: Record<string, unknown> = {
	obsidian: obsidianModule,
	moment,
	'@codemirror/autocomplete': cmAutocomplete,
	'@codemirror/collab': cmCollab,
	'@codemirror/commands': cmCommands,
	'@codemirror/language': cmLanguage,
	'@codemirror/lint': cmLint,
	'@codemirror/search': cmSearch,
	'@codemirror/state': cmState,
	'@codemirror/view': cmView,
	'@lezer/common': lezerCommon,
	'@lezer/highlight': lezerHighlight,
	'@lezer/lr': lezerLr,
};

/** Node built-ins and Electron, which desktop-only plugins use. Not available in the webview yet. */
export const NODE_MODULES = new Set([
	'assert',
	'buffer',
	'child_process',
	'crypto',
	'electron',
	'events',
	'fs',
	'fs/promises',
	'http',
	'https',
	'net',
	'os',
	'path',
	'process',
	'stream',
	'url',
	'util',
	'zlib',
]);

/** Properties bundlers probe on modules; reading them is not a sign of a missing API. */
const PROBED = new Set(['__esModule', 'default', 'then', 'toJSON', 'constructor', 'prototype', '$$typeof', 'nodeType', 'inspect']);

/**
 * Wraps `module` so that reading a name it does not export is reported
 * through `onMissing` (the compat harness lists these per plugin).
 */
export function trackMissingExports<T extends object>(module: T, onMissing: (name: string) => void): T {
	const copy = { ...module } as Record<string | symbol, unknown>;
	return new Proxy(copy, {
		get(target, prop) {
			if (typeof prop === 'string' && !(prop in target) && !PROBED.has(prop)) onMissing(prop);
			return target[prop];
		},
	}) as T;
}
