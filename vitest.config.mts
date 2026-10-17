import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// compat/ runs third-party plugins from a download cache: `npm run compat`.
		exclude: [...configDefaults.exclude, 'compat/**'],
	},
});
