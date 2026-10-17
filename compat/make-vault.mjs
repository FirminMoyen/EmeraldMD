#!/usr/bin/env node
// Creates a demo vault with community plugins from the compat cache, for
// trying them in the app:
//
//   node compat/fetch.mjs
//   node compat/make-vault.mjs <folder> [plugin-id ...]
//
// Without ids it installs every cached plugin. The plugins are listed as
// enabled in community-plugins.json; EmeraldMD still starts in restricted mode
// until you turn community plugins on in Settings → Community plugins.

import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [target, ...ids] = process.argv.slice(2);
if (!target) {
	console.error('usage: node compat/make-vault.mjs <folder> [plugin-id ...]');
	process.exit(1);
}
const vault = resolve(target);
const { plugins } = JSON.parse(await readFile(join(here, 'plugins.json'), 'utf8'));
const chosen = ids.length ? plugins.filter((p) => ids.includes(p.id)) : plugins;

const notes = {
	'Welcome.md': '# Welcome\n\nA demo vault for community plugins in EmeraldMD.\n\nSee [[Projects/Plan]] and #inbox.\n\n- [ ] Try the command palette (Ctrl/Cmd+P) 📅 2026-10-20\n- [x] Open the vault\n',
	'Projects/Plan.md': '---\ntags: [project]\nstatus: active\n---\n# Plan\n\nBack to [[Welcome]].\n\n```dataview\nLIST FROM #project\n```\n',
};
for (const [path, text] of Object.entries(notes)) {
	await mkdir(dirname(join(vault, path)), { recursive: true });
	await writeFile(join(vault, path), text);
}

const installed = [];
for (const plugin of chosen) {
	const from = join(here, '.cache', 'plugins', plugin.id, plugin.version);
	try {
		await access(join(from, 'main.js'));
	} catch {
		console.warn(`skipped ${plugin.id}: not downloaded (run node compat/fetch.mjs)`);
		continue;
	}
	await cp(from, join(vault, '.obsidian', 'plugins', plugin.id), { recursive: true });
	installed.push(plugin.id);
}
await writeFile(join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(installed, null, 2));
console.log(`Created ${vault} with ${installed.length} plugin(s): ${installed.join(', ')}`);
