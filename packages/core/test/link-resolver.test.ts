import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LinkResolver } from '../src/link-resolver';

const fixture = JSON.parse(
	readFileSync(new URL('../../../fixtures/link-resolution.json', import.meta.url), 'utf8'),
) as { files: string[]; cases: { link: string; source: string; expected: string | null }[] };

describe('LinkResolver (shared fixture with the Rust index)', () => {
	const resolver = new LinkResolver(fixture.files);
	for (const { link, source, expected } of fixture.cases) {
		it(`${JSON.stringify(link)} from ${source}`, () => {
			expect(resolver.resolve(link, source)).toBe(expected);
		});
	}
});
