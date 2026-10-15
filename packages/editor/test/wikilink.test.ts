import { describe, expect, it } from 'vitest';
import { wikilinkAt } from '../src';

describe('wikilinkAt', () => {
	const line = 'See [[Projects/Plan#Goals|the plan]] and ![[img.png]].';
	it('finds the link under the cursor without its alias', () => {
		expect(wikilinkAt(line, 8)).toBe('Projects/Plan#Goals');
		expect(wikilinkAt(line, 45)).toBe('img.png');
	});
	it('returns null outside links', () => {
		expect(wikilinkAt(line, 1)).toBeNull();
	});
});
