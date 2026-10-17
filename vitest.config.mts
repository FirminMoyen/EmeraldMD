import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// compat/ runs third-party plugins from a download cache: `npm run compat`.
		// .claude/ holds agent worktrees, each a full checkout with its own tests.
		exclude: [...configDefaults.exclude, 'compat/**', '.claude/**'],
	},
});
