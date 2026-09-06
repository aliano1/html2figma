// Starts a static origin for test/page.html, runs the capture server locally, POSTs a capture at two widths,
// and checks that cross-origin video + icon-font stars came back rasterised.
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const mime = { html: 'text/html', png: 'image/png', mp4: 'video/mp4' };
const srv = http.createServer((q, r) => {
  try { const p = join('test', q.url === '/' ? 'page.html' : q.url.split('?')[0]); const buf = readFileSync(p);
    r.setHeader('content-type', mime[p.split('.').pop()] || 'application/octet-stream'); r.setHeader('accept-ranges', 'bytes'); r.end(buf); }
  catch { r.statusCode = 404; r.end(); }
}).listen(8099);

const proc = spawn('node', ['server/index.mjs'], { env: { ...process.env, PORT: '8123', H2F_ALLOW_ANON: '1' }, stdio: ['ignore', 'inherit', 'inherit'] });
await new Promise(r => setTimeout(r, 1500));
for (let i = 0; i < 20; i++) { try { const h = await fetch('http://127.0.0.1:8123/healthz'); if (h.ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }

const t0 = Date.now();
const res = await fetch('http://127.0.0.1:8123/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://localhost:8099/', widths: [1280, 390] }) });
const out = await res.json();
console.log('status', res.status, 'ms', Date.now() - t0, 'captures', out.captures && out.captures.length);
let fails = 0; const check = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
check(res.status === 200, 'capture succeeded');
for (const { viewport, capture } of out.captures || []) {
  const nodes = []; (function w(n) { nodes.push(n); (n.c || []).forEach(w); })(capture.tree);
  const video = nodes.find(n => n.t === 'video');
  const stars = nodes.filter(n => n.glyph);
  const shotErrs = nodes.filter(n => n.shotError);
  check(capture.viewport[0] === viewport[0] && [1280, 390].includes(viewport[0]), `viewport ${viewport[0]}`);
  check(video && video.img && video.img.startsWith('data:image/png'), `${viewport[0]}: cross-origin video rasterised (${video ? (video.img || '').slice(0, 20) : 'no video node'})`);
  check(stars.length === 6 && stars.every(s => s.img && s.img.startsWith('data:image/png')), `${viewport[0]}: 6 icon-font glyph elements rasterised (5 ::before stars + 1 text run) (got ${stars.length}, ${stars.filter(s => s.img).length} with image)`);
  check(shotErrs.length === 0, `${viewport[0]}: no screenshot errors ${shotErrs.map(e => e.shotError).join('; ')}`);
  check(!nodes.some(n => n.txt === 'Hidden content that should NOT be captured.'), `${viewport[0]}: closed details excluded`);
  const logo = nodes.find(n => n.filt);
  check(!!logo && /^data:image\/png/.test(logo.img || '') && !(logo.s && logo.s.op), `${viewport[0]}: grayscale logo screenshotted as rendered, opacity not double-applied (filt=${logo && logo.filt}, op=${logo && logo.s && logo.s.op})`);
  writeFileSync(`test/capture-${viewport[0]}.json`, JSON.stringify(capture));
}
if (out.captures) writeFileSync('test/capture.json', JSON.stringify(out.captures[0].capture));
proc.kill('SIGTERM'); srv.close();
console.log(fails ? `\n${fails} check(s) failed` : '\nall server checks passed');
process.exit(fails ? 1 : 0);
