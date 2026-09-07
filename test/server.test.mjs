// Starts a static origin for test/page.html, runs the capture server locally, POSTs a capture at two widths,
// and checks that cross-origin video + icon-font stars came back rasterised.
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const mime = { html: 'text/html', png: 'image/png', mp4: 'video/mp4', webm: 'video/webm', woff2: 'font/woff2' };
const srv = http.createServer((q, r) => {
  try { const p = join('test', q.url === '/' ? 'page.html' : q.url.split('?')[0]); const buf = readFileSync(p);
    r.setHeader('content-type', mime[p.split('.').pop()] || 'application/octet-stream'); r.setHeader('accept-ranges', 'bytes'); r.end(buf); }
  catch { r.statusCode = 404; r.end(); }
}).listen(8099);

const proc = spawn('node', ['server/index.mjs'], { env: { ...process.env, PORT: '8123', H2F_ALLOW_ANON: '1' }, stdio: ['ignore', 'inherit', 'inherit'] });
await new Promise(r => setTimeout(r, 1500));
for (let i = 0; i < 20; i++) { try { const h = await fetch('http://127.0.0.1:8123/healthz'); if (h.ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }

const t0 = Date.now();
const res = await fetch('http://127.0.0.1:8123/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://localhost:8099/', widths: [1280, 390], screenshot: true }) });
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
  check(/^data:image\/jpeg/.test(capture.screenshot || ''), `${viewport[0]}: reference screenshot returned (${(capture.screenshot || '').length >> 10} KB)`);
  const face = (capture.fonts || []).find(f => f.family === 'Caladea');
  check(!!face && face.weight === '500' && /CaladeaBold\.woff2$/.test(face.file) && /^http/.test(face.url), `${viewport[0]}: loaded @font-face recorded (${JSON.stringify(face)})`);
  writeFileSync(`test/capture-${viewport[0]}.json`, JSON.stringify(capture));
}
if (out.captures) {
  const first = out.captures[0].capture;
  writeFileSync('test/capture.json', JSON.stringify(first));
  // /fonts: woff2 → installable TTF
  const fr = await fetch('http://127.0.0.1:8123/fonts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ faces: first.fonts }) });
  const fj = await fr.json(); const file = fj.files && fj.files[0];
  const head = file && file.data ? Buffer.from(file.data, 'base64').subarray(0, 4) : null;
  check(fr.status === 200 && file && file.name === 'CaladeaBold.ttf' && head && head.readUInt32BE(0) === 0x00010000, `/fonts converts the page's woff2 to a TTF (${file && file.name}, ${file && file.data ? Buffer.from(file.data, 'base64').length : 0} bytes, ${file && file.error})`);
  // /diff: reference vs itself → ~100 %; reference vs a blank page → far lower, with regions
  const blank = 'data:image/png;base64,' + Buffer.from(await (async () => { const { chromium } = await import('playwright'); const b = await chromium.launch({ executablePath: process.env.CHROME || undefined }); const p = await b.newPage({ viewport: { width: 1280, height: 400 } }); const png = await p.screenshot({ fullPage: true }); await b.close(); return png; })()).toString('base64');
  const d1 = await (await fetch('http://127.0.0.1:8123/diff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reference: first.screenshot, candidate: first.screenshot }) })).json();
  const d2 = await (await fetch('http://127.0.0.1:8123/diff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reference: first.screenshot, candidate: blank }) })).json();
  check(d1.similarity > 0.999 && /^data:image\/png/.test(d1.diff || ''), `/diff identical images → ${(d1.similarity * 100).toFixed(1)} % (${d1.error || ''})`);
  check(d2.similarity < 0.95 && d2.regions && d2.regions.length > 0, `/diff against a blank page → ${((d2.similarity || 0) * 100).toFixed(1)} %, ${d2.regions && d2.regions.length} hot cells (${d2.error || ''})`);
}
proc.kill('SIGTERM'); srv.close();
console.log(fails ? `\n${fails} check(s) failed` : '\nall server checks passed');
process.exit(fails ? 1 : 0);
