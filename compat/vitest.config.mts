import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Community plugin smoke tests. Separate from `npm test`, which must not need downloads.
export default defineConfig({
	test: {
		root: fileURLToPath(new URL('..', import.meta.url)),
		include: ['compat/**/*.test.ts'],
		environment: 'happy-dom',
		testTimeout: 60_000,
		// Plugins run asynchronous code the harness records rather than fails on.
		dangerouslyIgnoreUnhandledErrors: true,
	},
});
