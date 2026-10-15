// Bundles the webview UI into dist/ (Tauri's frontendDist).
import { build } from 'esbuild';
import { cp, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await cp('static', 'dist', { recursive: true });
await build({
	entryPoints: ['src/main.ts'],
	outfile: 'dist/app.js',
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	sourcemap: true,
	minify: process.env.NODE_ENV === 'production',
	logLevel: 'info',
});
