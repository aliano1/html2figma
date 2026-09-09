import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist', { recursive: true });

// 1. Figma plugin main thread (must be a single classic script, ES2020, no imports left)
const pluginCtx = await esbuild.context({
  entryPoints: ['src/plugin/code.ts'],
  bundle: true, format: 'iife', target: 'es2020', outfile: 'dist/code.js', logLevel: 'info',
});

// 1b. Capture core as a global (injected into pages by the server via page.evaluate)
const coreCtx = await esbuild.context({
  entryPoints: ['src/core/extract.js'],
  bundle: true, format: 'iife', globalName: '__h2f', target: 'es2020', minify: true, outfile: 'dist/core.iife.js', logLevel: 'info',
});

// 2. Bookmarklet: bundle + minify, then wrap as javascript: URL
const bmCtx = await esbuild.context({
  entryPoints: ['src/bookmarklet/entry.js'],
  bundle: true, format: 'iife', target: 'es2020', minify: true, outfile: 'dist/bookmarklet.js', logLevel: 'info',
  write: true,
});

async function finish() {
  copyFileSync('src/plugin/ui.html', 'dist/ui.html');
  const js = readFileSync('dist/bookmarklet.js', 'utf8').trim();
  const href = 'javascript:' + encodeURIComponent(js);
  writeFileSync('dist/bookmarklet.txt', href);
  writeFileSync('dist/install.html', `<!doctype html><meta charset="utf-8"><title>htmlimport bookmarklet</title>
<body style="font:15px/1.6 system-ui;max-width:640px;margin:60px auto;padding:0 20px">
<h1>htmlimport</h1>
<p>Drag this button to your bookmarks bar:</p>
<p><a href="${href.replace(/"/g, '&quot;')}" style="display:inline-block;background:#c8da2b;color:#111;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">📐 html2figma</a></p>
<p>Then open any page, click the bookmark, press <b>Capture page</b>, and paste the result into the Figma plugin.</p>
<p style="color:#666">Bookmarklet size: ${Math.round(href.length / 1024)} KB. Rebuild with <code>npm run build</code> after editing <code>src/</code>.</p>
</body>`);
  console.log(`bookmarklet: ${Math.round(href.length / 1024)} KB → dist/bookmarklet.txt, dist/install.html`);
}

if (watch) {
  await pluginCtx.watch(); await bmCtx.watch(); await coreCtx.watch();
  console.log('watching…');
} else {
  await pluginCtx.rebuild(); await bmCtx.rebuild(); await coreCtx.rebuild();
  await finish();
  await pluginCtx.dispose(); await bmCtx.dispose(); await coreCtx.dispose();
}
