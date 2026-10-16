import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { isCached, renderReport, smokeTest, STAGES, type PinnedPlugin, type SmokeResult } from './smoke';

const { plugins } = JSON.parse(readFileSync('compat/plugins.json', 'utf8')) as { plugins: PinnedPlugin[] };
const cached = plugins.filter(isCached);
const results: SmokeResult[] = [];

describe.skipIf(cached.length === 0)('community plugin smoke tests (run `node compat/fetch.mjs` first)', () => {
	for (const plugin of cached) {
		it(`${plugin.id} ${plugin.version}`, async () => {
			const result = await smokeTest(plugin);
			results.push(result);
			// A plugin may not get further than it did when its expectation was recorded, but it may do better.
			const expected = STAGES.indexOf(plugin.expect ?? 'none');
			expect(STAGES.indexOf(result.stage), `${plugin.id}: ${result.error ?? result.leftovers.join(', ')}`).toBeGreaterThanOrEqual(expected);
		});
	}

	afterAll(() => {
		mkdirSync('compat/.cache', { recursive: true });
		writeFileSync('compat/.cache/results.json', JSON.stringify(results, null, 2));
		if (process.env.UPDATE_COMPAT_DOCS) writeFileSync('docs/compat/plugins.md', renderReport(results, plugins));
	});
});
