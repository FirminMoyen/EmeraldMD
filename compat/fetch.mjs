#!/usr/bin/env node
// Downloads the community plugins listed in compat/plugins.json into
// compat/.cache/plugins/<id>/<version>/ and checks their SHA-256 hashes.
//
//   node compat/fetch.mjs          download pinned versions, verify hashes
//   node compat/fetch.mjs --lock   resolve each plugin's current version (the
//                                  "version" in manifest.json on the repo's
//                                  default branch, as the app's installer
//                                  does), check its license on GitHub, and
//                                  pin version + hashes in plugins.json
//
// Downloaded files are third-party code. Only pinned, hash-verified files
// are used by the smoke tests.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const listPath = join(here, 'plugins.json');
const cacheDir = join(here, '.cache', 'plugins');
const lock = process.argv.includes('--lock');
const FILES = ['manifest.json', 'main.js', 'styles.css'];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

async function get(url, { optional = false, json = false } = {}) {
	const headers = { 'User-Agent': 'emeraldmd-compat' };
	if (url.startsWith('https://api.github.com/') && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const res = await fetch(url, { headers, redirect: 'follow' });
	if (res.status === 404 && optional) return null;
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	return json ? res.json() : Buffer.from(await res.arrayBuffer());
}

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

const list = JSON.parse(await readFile(listPath, 'utf8'));
let failed = 0;

for (const plugin of list.plugins) {
	try {
		if (lock) {
			const manifest = await get(`https://raw.githubusercontent.com/${plugin.repo}/HEAD/manifest.json`, { json: true });
			plugin.version = manifest.version;
			const repo = await get(`https://api.github.com/repos/${plugin.repo}`, { json: true });
			plugin.license = repo.license?.spdx_id ?? 'NOASSERTION';
			if (plugin.license !== 'MIT') console.warn(`! ${plugin.id}: license is ${plugin.license}, not MIT`);
			plugin.sha256 = {};
		}
		const dir = join(cacheDir, plugin.id, plugin.version);
		await mkdir(dir, { recursive: true });
		for (const file of FILES) {
			const target = join(dir, file);
			const pinned = plugin.sha256?.[file];
			if (!lock && pinned === undefined && file === 'styles.css') continue;
			if (!lock && (await exists(target)) && sha256(await readFile(target)) === pinned) continue;
			const data = await get(`https://github.com/${plugin.repo}/releases/download/${plugin.version}/${file}`, { optional: file === 'styles.css' });
			if (data === null) continue;
			const hash = sha256(data);
			if (lock) plugin.sha256[file] = hash;
			else if (hash !== pinned) throw new Error(`${file}: hash ${hash} does not match the pinned ${pinned}`);
			await writeFile(target, data);
		}
		console.log(`✓ ${plugin.id} ${plugin.version}`);
	} catch (err) {
		failed++;
		console.error(`✗ ${plugin.id}: ${err.message}`);
	}
}

if (lock) await writeFile(listPath, JSON.stringify(list, null, '\t') + '\n');
if (failed) process.exitCode = 1;
