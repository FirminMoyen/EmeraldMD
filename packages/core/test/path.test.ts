import { describe, expect, it } from 'vitest';
import { normalizePath, parentPath, resolveRelative, splitExtension } from '../src/path';

// Mirrors the unit tests in crates/emerald-core/src/path.rs.
describe('paths', () => {
	it('normalizes separators and edges', () => {
		expect(normalizePath('//a\\b//c/')).toBe('a/b/c');
		expect(normalizePath('')).toBe('/');
		expect(normalizePath('a b')).toBe('a b');
		expect(normalizePath('é.md')).toBe('é.md');
	});

	it('splits names', () => {
		expect(parentPath('a/b/c.md')).toBe('a/b');
		expect(parentPath('c.md')).toBe('/');
		expect(splitExtension('c.tar.gz')).toEqual({ basename: 'c.tar', extension: 'gz' });
		expect(splitExtension('.hidden')).toEqual({ basename: '.hidden', extension: '' });
	});

	it('resolves relative paths', () => {
		expect(resolveRelative('a/b', '../c')).toBe('a/c');
		expect(resolveRelative('/', './x')).toBe('x');
		expect(resolveRelative('a', '../../x')).toBeNull();
	});
});
