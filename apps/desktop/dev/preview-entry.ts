/**
 * Browser preview of the desktop UI: the real src/main.ts with Tauri's
 * commands mocked by an in-memory demo vault. Build with
 * `npm run build:preview -w @emeraldmd/desktop`, then serve `dist-preview/`
 * with any static file server. Search is a simple substring stand-in for the
 * Rust engine; everything else runs the app's own code.
 */

import { MemoryBackend, MemoryConfigStore } from '@emeraldmd/api/testing';
import { LinkResolver, type CachedMetadata, type LinkSets, type SearchResults } from '@emeraldmd/core';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';

const files: Record<string, string> = {
	'Welcome.md':
		'# Welcome\n\nThis is the browser preview of EmeraldMD. See [[Projects/Plan]] and [[Ideas]].\n\n## Getting started\n\nTry #inbox and #project/alpha, the quick switcher (⌘O) and the command palette (⌘P).\n\n## Search\n\nSearch for flour or plan.\n',
	'Projects/Plan.md': '---\ntags: [project/alpha]\nstatus: draft\n---\n# Plan\n\nBack to [[Welcome]]. Buy flour.\n\n## Goals\n\n- [ ] ship [[Ideas]]\n- [x] write the plan\n',
	'Ideas.md': '# Ideas\n\nLinked from [[Welcome]] #inbox\n\n- A canvas: [[Board.canvas]]\n',
	'Styles.md':
		'# Styles\n\nA **bold** and *italic* line with ==a highlight==, `inline code`, a [[Welcome|link]], a [[Missing note]] and #tag.\n\n> A quote, with a [[Ideas|link]].\n\n> [!tip] Callouts\n> Follow the theme\'s `--callout-*` colours.\n\n> [!warning]- Folded\n> Hidden until opened.\n\n| Setting | Where |\n| --- | --- |\n| Theme | appearance.json |\n| Snippets | .obsidian/snippets |\n\n```js\nconsole.log("code block");\n```\n\n---\n\n- [ ] a task\n- [x] a done task\n',
	'Journal/2026-10-16.md': '# 2026-10-16\n\nWorked on [[Projects/Plan]] with flour. #journal\n',
	'Board.canvas': JSON.stringify(
		{
			nodes: [
				{ id: 'a', type: 'text', x: 0, y: 0, width: 260, height: 120, text: '# Board\n\nA **canvas** card' },
				{ id: 'b', type: 'file', x: 340, y: 0, width: 300, height: 200, file: 'Ideas.md' },
			],
			edges: [{ id: 'e', fromNode: 'a', toNode: 'b', label: 'see' }],
		},
		null,
		'\t',
	),
};

const backend = new MemoryBackend(files);
/** A demo theme and two snippets, to try Settings → Appearance. */
const config = new MemoryConfigStore({
	'.obsidian/themes/Dusk/manifest.json': JSON.stringify({ name: 'Dusk', version: '1.0.0', minAppVersion: '1.0.0', author: 'EmeraldMD preview' }),
	'.obsidian/themes/Dusk/theme.css': [
		'body { --accent-h: 262; --accent-s: 70%; --accent-l: 62%; --font-text-theme: Georgia, serif; }',
		'.theme-dark { --color-base-00: #1b1830; --color-base-10: #211d3a; --color-base-20: #262142; --color-base-30: #332c57; --color-base-35: #3d3566; }',
		'.theme-light { --color-base-00: #fbfaff; --color-base-10: #f3f0ff; --color-base-20: #ece7ff; --color-base-30: #dcd4fb; }',
		'body { --h1-color: var(--color-purple); --tag-radius: 4px; }',
	].join('\n'),
	'.obsidian/snippets/wide-lines.css': 'body { --file-line-width: 960px; }',
	'.obsidian/snippets/red-links.css': 'body { --link-color: var(--color-red); }',
});

/** Case-insensitive substring search over the demo notes. */
async function search(query: string): Promise<SearchResults> {
	const needle = query.toLowerCase();
	const result: SearchResults = { files: [], totalFiles: 0 };
	for (const entry of backend.entries()) {
		if (entry.kind !== 'file' || !entry.path.endsWith('.md')) continue;
		const text = await backend.read(entry.path);
		const matches = [];
		let offset = 0;
		for (const [line, lineText] of text.split('\n').entries()) {
			const at = lineText.toLowerCase().indexOf(needle);
			if (at >= 0) {
				matches.push({ line, from: offset + at, to: offset + at + needle.length, lineText, textFrom: at, textTo: at + needle.length });
			}
			offset += lineText.length + 1;
		}
		if (matches.length) result.files.push({ path: entry.path, nameMatched: false, matches, matchCount: matches.length });
	}
	result.totalFiles = result.files.length;
	return result;
}

/**
 * A rough stand-in for the Rust index (links, headings, tags), so the
 * backlinks, outline, tags and graph panes have something to show.
 */
function snapshotIndex(): { metadata: Record<string, CachedMetadata>; links: Record<string, LinkSets> } {
	const paths = backend.entries().filter((e) => e.kind === 'file').map((e) => e.path);
	const resolver = new LinkResolver(paths);
	const metadata: Record<string, CachedMetadata> = {};
	const links: Record<string, LinkSets> = {};
	const pos = (offset: number, length = 0) => ({ start: { line: 0, col: 0, offset }, end: { line: 0, col: 0, offset: offset + length } });
	for (const path of paths.filter((p) => p.endsWith('.md'))) {
		const text = files[path] ?? '';
		const sets: LinkSets = { resolved: {}, unresolved: {} };
		const cache: CachedMetadata = { links: [], tags: [], headings: [] };
		for (const m of text.matchAll(/!?\[\[([^\]|#]+)[^\]]*\]\]/g)) {
			cache.links!.push({ link: m[1]!, original: m[0], displayText: m[1]!, position: pos(m.index, m[0].length) });
			const target = resolver.resolve(m[1]!, path);
			if (target) sets.resolved[target] = (sets.resolved[target] ?? 0) + 1;
			else sets.unresolved[m[1]!] = (sets.unresolved[m[1]!] ?? 0) + 1;
		}
		for (const m of text.matchAll(/(^|\s)(#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) {
			cache.tags!.push({ tag: m[2]!, position: pos(m.index + m[1]!.length) });
		}
		let offset = 0;
		for (const [line, lineText] of text.split('\n').entries()) {
			const h = /^(#{1,6})\s+(.+)$/.exec(lineText);
			if (h) cache.headings!.push({ heading: h[2]!, level: h[1]!.length, position: { start: { line, col: 0, offset }, end: { line, col: lineText.length, offset: offset + lineText.length } } });
			offset += lineText.length + 1;
		}
		const fmTags = /^---\n[\s\S]*?^tags:\s*\[([^\]]*)\]/m.exec(text);
		if (fmTags) cache.frontmatter = { tags: fmTags[1]!.split(',').map((t) => t.trim()) };
		metadata[path] = cache;
		links[path] = sets;
	}
	return { metadata, links };
}

mockWindows('main');
mockIPC(
	async (cmd, args) => {
		const a = (args ?? {}) as Record<string, string>;
		switch (cmd) {
			case 'last_vault':
				return '/preview';
			case 'open_vault':
				return { name: 'Preview vault', basePath: '/preview', files: backend.entries(), ...snapshotIndex() };
			case 'read_file':
				return backend.read(a.path!);
			case 'write_file':
				return backend.write(a.path!, a.data!);
			case 'create_file':
				return backend.create(a.path!, a.data!);
			case 'create_folder':
				return backend.createFolder(a.path!);
			case 'rename_path':
				return backend.rename(a.from!, a.to!);
			case 'trash_path':
				return backend.trash(a.path!);
			case 'search_vault':
				return search(a.query!);
			case 'config_read':
				return config.read(a.path!);
			case 'config_write':
				return config.write(a.path!, a.data!);
			case 'config_list':
				return config.list(a.path!);
			case 'config_trash':
				return config.trash(a.path);
			case 'config_mkdir':
				return config.mkdir(a.path!);
			case 'config_stat': {
				const stat = await config.stat(a.path!);
				return stat && { path: a.path, kind: stat.type, ctime: 0, mtime: 0, size: stat.size };
			}
			case 'show_config_folder':
			case 'reveal_path':
			case 'open_external':
				return null;
			case 'community_plugins_trusted':
				return false;
			case 'remote_vaults':
				return { recent: [], reopenLast: false };
			default:
				console.warn('Preview: command not mocked:', cmd);
				return null;
		}
	},
	{ shouldMockEvents: true },
);

await import('../src/main');
