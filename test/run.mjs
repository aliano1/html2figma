import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http'; import { join } from 'node:path';
const srv = http.createServer((q, r) => { try { const p = join('test', q.url === '/' ? 'page.html' : q.url); r.setHeader('content-type', p.endsWith('.png') ? 'image/png' : 'text/html'); r.end(readFileSync(p)); } catch { r.statusCode = 404; r.end(); } }).listen(8099);
const bm = readFileSync('dist/bookmarklet.js', 'utf8');
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {}); const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://localhost:8099/'); await page.waitForLoadState('networkidle');
await page.evaluate(bm);
await page.click('#h2f-capture');
await page.waitForFunction(() => document.querySelector('#h2f-actions').style.display === 'flex', null, { timeout: 15000 });
const status = await page.textContent('#h2f-status'); console.log('status:', status);
// intercept download
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#h2f-download')]);
const path = await dl.path(); const json = readFileSync(path, 'utf8'); writeFileSync('test/capture.json', json);
const cap = JSON.parse(json); console.log('viewport', cap.viewport, 'bytes', json.length);
const kinds = {}; (function w(n){ kinds[n.t]=(kinds[n.t]||0)+1; (n.c||[]).forEach(w); })(cap.tree); console.log(kinds);
const texts=[]; (function w(n){ if(n.t==='#text') texts.push(n.txt.trim().slice(0,40)); (n.c||[]).forEach(w); })(cap.tree); console.log(texts);
const imgs=[]; (function w(n){ if(n.img) imgs.push(n.img.slice(0,40)); (n.c||[]).forEach(w); })(cap.tree); console.log(imgs);
await browser.close(); srv.close();
