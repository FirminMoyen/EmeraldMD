// Bundles the webview UI into dist/ (Tauri's frontendDist).
// `--preview` instead builds dist-preview/: the same UI with Tauri's commands
// mocked by a demo vault (dev/preview-entry.ts), for checking it in a browser.
import { build } from 'esbuild';
import { cp, rm } from 'node:fs/promises';

const preview = process.argv.includes('--preview');
const outdir = preview ? 'dist-preview' : 'dist';

await rm(outdir, { recursive: true, force: true });
await cp('static', outdir, { recursive: true });
await build({
	entryPoints: [preview ? 'dev/preview-entry.ts' : 'src/main.ts'],
	outfile: `${outdir}/app.js`,
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	sourcemap: true,
	minify: process.env.NODE_ENV === 'production',
	logLevel: 'info',
});
