/**
 * Vault paths are forward-slash separated and relative to the vault root,
 * with no leading or trailing slash. The root folder itself is "/".
 */

export function normalizePath(path: string): string {
	let p = path.replace(/[\\/]+/g, '/').replace(/[  ]/g, ' ');
	p = p.replace(/^\/+|\/+$/g, '').normalize('NFC');
	return p === '' ? '/' : p;
}

export function parentPath(path: string): string {
	const i = path.lastIndexOf('/');
	return i === -1 ? '/' : path.slice(0, i);
}

export function fileName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

/** Splits "Note.md" into { basename: "Note", extension: "md" }. Dotfiles have no extension. */
export function splitExtension(name: string): { basename: string; extension: string } {
	const i = name.lastIndexOf('.');
	if (i <= 0) return { basename: name, extension: '' };
	return { basename: name.slice(0, i), extension: name.slice(i + 1) };
}

export function joinPath(...parts: string[]): string {
	return normalizePath(parts.filter((p) => p !== '' && p !== '/').join('/'));
}

/** Resolves `relative` (which may contain "." and ".." segments) against a vault folder. */
export function resolveRelative(folder: string, relative: string): string | null {
	const segments = folder === '/' ? [] : folder.split('/');
	for (const segment of relative.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			if (segments.length === 0) return null;
			segments.pop();
		} else {
			segments.push(segment);
		}
	}
	return normalizePath(segments.join('/'));
}
