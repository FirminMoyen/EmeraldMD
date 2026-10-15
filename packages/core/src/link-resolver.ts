/**
 * TypeScript twin of `VaultIndex::resolve` in crates/emerald-core/src/index.rs.
 * The plugin API needs synchronous resolution, so the webview cannot ask Rust.
 * Both are tested against fixtures/link-resolution.json; change them together.
 */

import { fileName, normalizePath, parentPath, resolveRelative } from './path';

export class LinkResolver {
	private readonly paths = new Set<string>();
	private readonly byLowerPath = new Map<string, string>();
	private readonly byLowerName = new Map<string, string[]>();

	constructor(filePaths: Iterable<string>) {
		for (const path of filePaths) {
			this.paths.add(path);
			this.byLowerPath.set(path.toLowerCase(), path);
			const name = fileName(path).toLowerCase();
			const list = this.byLowerName.get(name);
			if (list) list.push(path);
			else this.byLowerName.set(name, [path]);
		}
	}

	resolve(linkpath: string, sourcePath: string): string | null {
		linkpath = linkpath.trim();
		if (linkpath === '') return null;
		if (linkpath.startsWith('./') || linkpath.startsWith('../')) {
			const target = resolveRelative(parentPath(sourcePath), linkpath);
			return target === null ? null : this.lookupPath(target);
		}
		linkpath = normalizePath(linkpath);
		const exact = this.lookupPath(linkpath);
		if (exact !== null) return exact;

		const lower = linkpath.toLowerCase();
		const lowerMd = lower + '.md';
		let candidates: string[];
		if (lower.includes('/')) {
			const suffix = '/' + lower;
			const suffixMd = '/' + lowerMd;
			candidates = [];
			for (const [key, path] of this.byLowerPath) {
				if (key.endsWith(suffix) || key.endsWith(suffixMd)) candidates.push(path);
			}
		} else {
			candidates = [...(this.byLowerName.get(lower) ?? []), ...(this.byLowerName.get(lowerMd) ?? [])];
		}
		return bestCandidate(candidates, parentPath(sourcePath));
	}

	private lookupPath(path: string): string | null {
		if (this.paths.has(path)) return path;
		const lower = path.toLowerCase();
		return this.byLowerPath.get(lower) ?? this.byLowerPath.get(lower + '.md') ?? null;
	}
}

function bestCandidate(candidates: string[], folder: string): string | null {
	candidates.sort((a, b) => {
		const aHere = parentPath(a) === folder;
		const bHere = parentPath(b) === folder;
		if (aHere !== bHere) return aHere ? -1 : 1;
		if (a.length !== b.length) return a.length - b.length;
		return a < b ? -1 : a > b ? 1 : 0;
	});
	return candidates[0] ?? null;
}
