/**
 * html2figma capture server
 *
 *   POST /capture   { url, widths?: [1920, 390], region?: "ams", hideSelectors?: [], waitFor?: css, timeoutMs?, screenshot?: true, async?: true }
 *                   → { url, title, captures: [{ viewport: [w, h], capture }] }   (capture.screenshot = full-page JPEG when asked)
 *                   with async: true → 202 { jobId } at once; then
 *   GET  /jobs/:id  → { status: queued|running|done|error, stage, message, progress 0..1, widthIndex, elapsedMs, result?, error? }
 *   POST /fonts     { faces: [{family, weight, style, url, file}] } → { files: [{name, data(base64 ttf/otf)}] }
 *   POST /diff      { reference: dataURL, candidate: dataURL, cell? } → { similarity, diff: dataURL, regions: [{x,y,w,h,pct}] }
 *   GET  /healthz   → { ok, region, browser, features }
 *
 *   GET  /me        → { email, plan, credits, used, remaining, resetsAt } (license-key users)
 *
 * Auth: `Authorization: Bearer …`. Single-tenant: the shared H2F_API_KEY. Multi-tenant (DATABASE_URL
 * set): per-user license keys `h2f_live_…` with plans, monthly credits and a Postgres job queue — see
 * db.mjs and scripts/h2f-admin.mjs. Without either, the server refuses to start unless H2F_ALLOW_ANON=1.
 *
 * Region routing (Fly.io): if `region` is given and differs from FLY_REGION, the request is
 * replayed in that region via the `fly-replay` header. On other hosts the field is ignored.
 *
 * Runs the same capture core as the bookmarklet (dist/core.iife.js) inside a real Chromium via
 * Playwright, then rasterises what the DOM can't express: cross-origin video frames, tainted
 * canvases, icon-font glyphs (e.g. review stars), oversized SVGs. Those become image nodes.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { Db } from './db.mjs';
import { assertPublicUrl, guardContext } from './safety.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE = readFileSync(join(__dirname, '..', 'dist', 'core.iife.js'), 'utf8');
const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.H2F_API_KEY || '';
const REGION = process.env.FLY_REGION || process.env.RAILWAY_REPLICA_REGION || process.env.H2F_REGION || 'local';
const MAX_WIDTHS = 4;
const MAX_CAPTURE_BYTES = Number(process.env.H2F_MAX_CAPTURE_MB || 60) * 1e6;
const DEFAULT_HIDE = ['#shopify-pc__banner', '.shopify-pc__banner', '#onetrust-consent-sdk', '#CybotCookiebotDialog', '.cc-window', '#cookie-banner', '[id*="cookie-consent"]', '[class*="cookie-consent"]', '.sca-modal-fg', '.freegifts-main-container'];
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

if (!API_KEY && !process.env.DATABASE_URL && process.env.H2F_ALLOW_ANON !== '1') {
  console.error('Refusing to start: set H2F_API_KEY (single-tenant), DATABASE_URL (license keys), or H2F_ALLOW_ANON=1 for local dev.');
  process.exit(1);
}

// ---------- browser (one per process, contexts per request) ----------
let browserP = null;
let browserName = '';
const ARGS = ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--mute-audio',
  '--disable-extensions', '--disable-background-networking', '--renderer-process-limit=2', '--js-flags=--max-old-space-size=512'];
function browser() {
  if (!browserP) {
    browserP = (async () => {
      // Google Chrome ships H.264/AAC (most web video); open-source Chromium does not. Try Chrome first.
      const attempts = process.env.CHROME
        ? [{ executablePath: process.env.CHROME }]
        : [{ channel: 'chrome' }, { channel: 'chromium' }, {}];
      let last;
      for (const a of attempts) {
        try { const b = await chromium.launch({ ...a, args: ARGS }); browserName = a.channel || a.executablePath || 'chromium'; return b; }
        catch (e) { last = e; }
      }
      throw last;
    })().then(b => { b.on('disconnected', () => { browserP = null; }); return b; }, e => { browserP = null; throw e; });
  }
  return browserP;
}

// ---------- one viewport ----------
async function captureViewport(b, opts, width, report = () => {}) {
  const mobile = width < 768;
  const ctx = await b.newContext({
    viewport: { width, height: mobile ? 844 : 1080 },
    deviceScaleFactor: 1,
    isMobile: mobile, hasTouch: mobile,
    userAgent: mobile ? MOBILE_UA : undefined,
    locale: opts.locale || 'en-US',
    timezoneId: opts.timezone || undefined,
    extraHTTPHeaders: opts.headers || {},
  });
  if (opts.cookies) await ctx.addCookies(opts.cookies);
  await guardContext(ctx);   // no hops into private networks, whatever the page redirects to
  const page = await ctx.newPage();
  page.setDefaultTimeout(opts.timeoutMs);
  try {
    report('load', 0.02, 'Loading page');
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
    report('load', 0.15, 'Waiting for the page to settle');
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: 15000 }).catch(() => {});
    await page.addScriptTag({ content: CORE });

    // warm up (lazy images/sections), then let videos reach a frame
    report('warmup', 0.3, 'Scrolling through the page (lazy content)');
    await page.evaluate(() => window.__h2f.warmUp(600, 120));
    await page.evaluate(() => Promise.all([...document.querySelectorAll('video')].map(v => { try { v.muted = true; return v.play().catch(() => {}); } catch { return null; } })));
    await page.waitForTimeout(600);

    report('extract', 0.45, 'Reading layout and styles');
    const cap = await page.evaluate(({ hide }) => {
      const c = window.__h2f.extract({ hideSelectors: hide, markForRaster: true });
      return c;
    }, { hide: [...DEFAULT_HIDE, ...(opts.hideSelectors || [])] });

    // Fetch images server-side with the page's cookies. (Doing it in-page via canvas, as the
    // bookmarklet does, decodes every image at full size inside the renderer — too heavy for a 1 GB box.)
    const capture = cap;
    let nImg = 0; (function c(n) { if (n.img || (n.s && n.s.bgi)) nImg++; (n.c || []).forEach(c); })(capture.tree);
    report('images', 0.6, `Fetching ${nImg} images`);
    await fetchRemaining(ctx, capture);

    // rasterise the marked elements
    let nShot = 0; (function c(n) { if (n.shot) nShot++; (n.c || []).forEach(c); })(capture.tree);
    report('raster', 0.8, nShot ? `Screenshotting ${nShot} elements (video, icons, filters)` : 'Finishing');
    await rasterise(page, capture);

    // reference screenshot of the whole page (what the build is compared against in Figma)
    if (opts.screenshot) {
      report('screenshot', 0.92, 'Taking the reference screenshot');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(150);
      const png = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 88, animations: 'disabled', timeout: 30000 }).catch(() => null);
      if (png) capture.screenshot = 'data:image/jpeg;base64,' + png.toString('base64');
    }

    const bytes = JSON.stringify(capture).length;
    if (bytes > MAX_CAPTURE_BYTES) throw new Error(`page too large to import (${(bytes / 1e6).toFixed(0)} MB of layers and images; limit ${MAX_CAPTURE_BYTES / 1e6} MB)`);
    report('done', 1, 'Done');
    return { viewport: capture.viewport, capture };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// CDN resize hints (Shopify `?width=72`, `_64x64.`, Cloudinary `w_72`): ask for 2x the displayed size so
// thumbnails stay crisp when zoomed in Figma. Falls back to the original URL if the CDN refuses.
function upscaleUrl(url, r) {
  const want = Math.min(2048, Math.ceil((r ? r[2] : 0) * 2));
  if (!want) return url;
  // `width=64&height=64&crop=center` (Shopify) — scale both, or the CDN returns a 128×64 crop
  const wm = url.match(/[?&]width=(\d+)/), hm = url.match(/[?&]height=(\d+)/);
  if (wm && hm && +wm[1] < want) {
    const f = want / +wm[1];
    return url.replace(/([?&])width=\d+/, `$1width=${want}`).replace(/([?&])height=(\d+)/, (m, p, h) => `${p}height=${Math.round(+h * f)}`);
  }
  return url
    .replace(/([?&])width=(\d+)/, (m, p, w) => `${p}width=${Math.max(+w, want)}`)
    .replace(/_(\d+)x(\d*)(_crop_[a-z]+)?(\.[a-z]+)(\?|$)/i, (m, w, h, crop, ext, q) => +w >= want ? m : `_${want}x${h ? Math.round(+h * want / +w) : ''}${crop || ''}${ext}${q}`)
    .replace(/\/w_(\d+)(,|\/)/, (m, w, sep) => +w >= want ? m : `/w_${want}${sep}`);
}

async function fetchRemaining(ctx, capture) {
  const holders = [];
  (function walk(n) {
    if (n.img && /^https?:/.test(n.img)) { n.img = upscaleUrl(n.img, n.r); holders.push([n, 'img']); }
    if (n.s && n.s.bgi && /^https?:/.test(n.s.bgi)) { n.s.bgi = upscaleUrl(n.s.bgi, n.r); holders.push([n.s, 'bgi']); }
    (n.c || []).forEach(walk);
  })(capture.tree);
  const cache = new Map();
  await Promise.all(holders.map(async ([h, k]) => {
    const url = h[k];
    if (!cache.has(url)) cache.set(url, (async () => {
      try {
        let res = await ctx.request.get(url, { timeout: 15000 });
        if (!res.ok() && /width=|_\d+x/.test(url)) res = await ctx.request.get(url.replace(/([?&])width=\d+/, '$1width=800'), { timeout: 15000 });
        if (!res.ok()) return null;
        const type = res.headers()['content-type'] || 'image/png';
        const buf = await res.body();
        if (buf.length > 6 * 1024 * 1024) return null;
        if (type.includes('svg')) return { svg: buf.toString('utf8') };
        return { data: `data:${type.split(';')[0]};base64,${buf.toString('base64')}` };
      } catch { return null; }
    })());
    const r = await cache.get(url);
    if (r && r.svg) h.svgFile = r.svg; else if (r) h[k] = r.data;
  }));
}

async function rasterise(page, capture) {
  const marked = [];
  (function walk(n) { if (n.shot) marked.push(n); (n.c || []).forEach(walk); })(capture.tree);
  for (const n of marked) {
    try {
      const loc = page.locator(`[data-h2f-shot="${n.shot}"]`).first();
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      const png = await loc.screenshot({ type: 'png', omitBackground: true, timeout: 8000, animations: 'disabled' });
      n.img = 'data:image/png;base64,' + png.toString('base64');
      n.s = Object.assign({}, n.s, { fit: n.s && n.s.fit === 'contain' ? 'contain' : 'cover' });
      delete n.s.op;         // the screenshot already shows the element at its own opacity (and filter)
      if (n.t === 'svg') { delete n.svg; n.t = 'div'; }
      delete n.c;            // the screenshot already contains any children
    } catch (e) {
      n.shotError = String(e.message || e).slice(0, 120);
    }
    delete n.shot;
  }
  await page.evaluate(() => document.querySelectorAll('[data-h2f-shot]').forEach(e => e.removeAttribute('data-h2f-shot')));
}

// ---------- fonts: the page's own webfonts as installable TTFs ----------
// woff2 is just a compressed sfnt (TTF/OTF); decompressing gives a file macOS/Windows can install.
// The user is responsible for the font's licence — the plugin says so next to the button.
async function fontFiles(ctx, faces) {
  const { decompress } = await import('wawoff2');
  const out = []; const seen = new Set();
  for (const f of faces.slice(0, 24)) {
    if (seen.has(f.url)) continue; seen.add(f.url);
    try {
      const res = await ctx.request.get(f.url, { timeout: 15000 });
      if (!res.ok()) { out.push({ ...f, error: 'HTTP ' + res.status() }); continue; }
      let buf = await res.body();
      let ext = 'ttf';
      const magic = buf.subarray(0, 4).toString('latin1');
      if (magic === 'wOF2') buf = Buffer.from(await decompress(new Uint8Array(buf)));
      else if (magic === 'wOFF') { out.push({ ...f, error: 'woff1 not supported yet' }); continue; }
      if (buf.subarray(0, 4).toString('latin1') === 'OTTO') ext = 'otf';
      const name = (f.file || (f.family + '-' + f.weight)).replace(/\.[a-z0-9]+$/i, '') + '.' + ext;
      out.push({ family: f.family, weight: f.weight, style: f.style, name, data: buf.toString('base64') });
    } catch (e) { out.push({ ...f, error: String(e.message || e).slice(0, 100) }); }
  }
  return out;
}

// ---------- diff: reference screenshot vs. Figma export ----------
// Both images are page-sized; compare in a blank page via canvas so no native deps are needed.
// Returns a similarity score, a heat-map PNG (red where pixels differ) and the worst grid cells.
async function diffImages(b, a, bImg, cell) {
  const ctx = await b.newContext({ viewport: { width: 800, height: 600 } });
  try {
    const page = await ctx.newPage();
    await page.setContent('<canvas id=c></canvas>');
    return await page.evaluate(async ({ a, bImg, cell }) => {
      const load = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('bad image')); i.src = src; });
      const [A, B] = await Promise.all([load(a), load(bImg)]);
      const W = Math.min(A.width, B.width), H = Math.min(A.height, B.height);
      // both are page-sized at the same page width, so no scaling: draw at natural size, crop to the common area
      const pixels = (im, white) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); if (white) { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); } g.drawImage(im, 0, 0); return g.getImageData(0, 0, W, H).data; };
      const pa = pixels(A, false), pb = pixels(B, true);
      const out = document.getElementById('c'); out.width = W; out.height = H;
      const g = out.getContext('2d'); g.drawImage(A, 0, 0); g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillRect(0, 0, W, H);
      const heat = g.getImageData(0, 0, W, H); const hd = heat.data;
      const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
      const cellDiff = new Float64Array(cols * rows);
      let diff = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const d = Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
        if (d > 90) { diff++; cellDiff[Math.floor(y / cell) * cols + Math.floor(x / cell)]++; hd[i] = 235; hd[i + 1] = 40; hd[i + 2] = 60; hd[i + 3] = 255; }
      }
      g.putImageData(heat, 0, 0);
      const regions = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const pct = cellDiff[r * cols + c] / (cell * cell); if (pct > 0.12) regions.push({ x: c * cell, y: r * cell, w: cell, h: cell, pct: Math.round(pct * 100) }); }
      regions.sort((p, q) => q.pct - p.pct);
      return { width: W, height: H, heightA: A.height, heightB: B.height, similarity: 1 - diff / (W * H), diff: out.toDataURL('image/png'), regions: regions.slice(0, 200) };
    }, { a, bImg, cell });
  } finally { await ctx.close().catch(() => {}); }
}
// ---------- jobs ----------
// Two modes share one shape:
//   single-tenant (no DATABASE_URL): in-memory jobs, one shared H2F_API_KEY — the self-hosted setup.
//   multi-tenant  (DATABASE_URL set): license keys, monthly credits, per-plan concurrency, a Postgres
//   queue that any replica can pull from, usage rows for billing.
const db = process.env.DATABASE_URL ? new Db(process.env.DATABASE_URL) : null;
const WORKER_ID = `${REGION}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
const memJobs = new Map();
const JOB_TTL = 10 * 60 * 1000;
const newJobId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function memJob(widths) {
  const job = { id: newJobId(), status: 'queued', widths, widthIndex: 0, stage: 'queued', progress: 0, message: 'Waiting for a browser', startedAt: Date.now(), result: null, error: null };
  memJobs.set(job.id, job);
  setTimeout(() => memJobs.delete(job.id), JOB_TTL).unref();
  return job;
}

async function runCapture(opts, widths, report) {
  const b = await browser();
  const captures = [];
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i];
    const rep = (stage, frac, message) => report && report({ stage, message: `${w}px · ${message}`, progress: (i + frac) / widths.length, widthIndex: i });
    captures.push(await captureViewport(b, opts, w, rep));   // sequential: predictable memory
  }
  return captures;
}
const friendly = e => { const msg = String(e.message || e); return /Target crashed|Target closed|out of memory/i.test(msg)
  ? 'Browser tab crashed (usually out of memory). Give the service more RAM or capture one width at a time.'
  : msg.slice(0, 300); };

let inflight = 0;
const MAX_INFLIGHT = Number(process.env.H2F_MAX_INFLIGHT || 2);

// multi-tenant worker: pull queued jobs from Postgres while there is capacity
async function workerTick() {
  if (!db || inflight >= MAX_INFLIGHT) return;
  let job; try { job = await db.claim(WORKER_ID); } catch (e) { console.error('claim failed', e.message); return; }
  if (!job) return;
  inflight++;
  const t0 = Date.now();
  const req = job.request;
  let lastWrite = 0, pending = null;
  const report = p => {   // throttle progress writes to ~3/s
    pending = p; const now = Date.now();
    if (now - lastWrite > 300) { lastWrite = now; db.progress(job.id, p).catch(() => {}); pending = null; }
  };
  try {
    const captures = await runCapture(req.opts, req.widths, report);
    const result = { url: req.opts.url, title: captures[0].capture.title, region: REGION, ms: Date.now() - t0, captures };
    await db.finish(job.id, result);
    await db.recordUsage({ accountId: job.account_id, keyHash: job.key_hash, url: req.opts.url, widths: req.widths, credits: req.widths.length, ms: Date.now() - t0, status: 'done', region: REGION });
  } catch (e) {
    console.error('capture failed', req.opts.url, e);
    await db.fail(job.id, friendly(e)).catch(() => {});
    await db.recordUsage({ accountId: job.account_id, keyHash: job.key_hash, url: req.opts.url, widths: req.widths, credits: 0, ms: Date.now() - t0, status: 'error', error: friendly(e), region: REGION }).catch(() => {});
  } finally { inflight--; void pending; }
}
if (db) {
  setInterval(() => { workerTick().catch(e => console.error('worker', e)); }, 500).unref();
  setInterval(() => { db.sweep().catch(() => {}); }, 60_000).unref();
}

// ---------- HTTP ----------
function json(res, status, body, headers = {}) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...headers });
  res.end(s);
}
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject);
  });
}
function bearer(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : (req.headers['x-api-key'] || '').trim();
}
/** → { kind: 'admin' | 'anon' | 'user', account?, keyHash? } or null when unauthorised */
async function authenticate(req) {
  const key = bearer(req);
  if (API_KEY && key === API_KEY) return { kind: 'admin' };
  if (db && key.startsWith('h2f_')) { const a = await db.authenticate(key); return a ? { kind: 'user', ...a } : null; }
  if (!API_KEY && !db) return { kind: 'anon' };
  return null;
}
const jobView = (j, elapsedMs) => ({ id: j.id, status: j.status, stage: j.stage, message: j.message, progress: j.progress, widthIndex: j.widthIndex ?? j.width_index, elapsedMs, error: j.error || null });

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, x-api-key, content-type', 'access-control-allow-methods': 'POST, GET, OPTIONS' }); return res.end(); }
    if (req.url === '/healthz') return json(res, 200, { ok: true, region: REGION, browser: browserName || null, inflight, mode: db ? 'multi-tenant' : 'single-tenant', features: ['screenshot', 'fonts', 'diff', 'jobs', ...(db ? ['accounts'] : [])] });

    const auth = await authenticate(req);
    if (!auth) return json(res, 401, { error: db ? 'invalid or revoked license key' : 'unauthorized' });

    // ---- GET /me: plan + credits for the plugin panel ----
    if (req.method === 'GET' && req.url === '/me') {
      if (auth.kind !== 'user') return json(res, 200, { plan: auth.kind, credits: null, used: 0, remaining: null });
      return json(res, 200, { email: auth.account.email, ...(await db.quota(auth.account)) });
    }

    // ---- GET /jobs/:id ----
    const jobM = req.method === 'GET' && req.url.match(/^\/jobs\/([a-z0-9]+)$/);
    if (jobM) {
      if (db) {
        const j = await db.get(jobM[1], auth.kind === 'user' ? auth.account.id : null);
        if (!j) return json(res, 404, { error: 'unknown or expired job' });
        const elapsedMs = Date.now() - new Date(j.created_at).getTime();
        if (j.status === 'done') { await db.remove(j.id); return json(res, 200, { ...jobView(j, elapsedMs), result: j.result }); }   // one-shot
        return json(res, 200, jobView(j, elapsedMs));
      }
      const job = memJobs.get(jobM[1]);
      if (!job) return json(res, 404, { error: 'unknown or expired job' });
      const elapsedMs = Date.now() - job.startedAt;
      if (job.status === 'done') { memJobs.delete(job.id); return json(res, 200, { ...jobView(job, elapsedMs), result: job.result }); }
      return json(res, 200, jobView(job, elapsedMs));
    }

    if (req.method !== 'POST' || !['/capture', '/fonts', '/diff'].includes(req.url)) return json(res, 404, { error: 'not found' });
    let body;
    try { body = JSON.parse(await readBody(req, req.url === '/diff' ? 80e6 : 1e6) || '{}'); } catch (e) { return json(res, 400, { error: /large/.test(String(e.message)) ? 'body too large' : 'invalid JSON' }); }

    if (req.url === '/fonts') {
      const faces = (Array.isArray(body.faces) ? body.faces : []).filter(f => f && /^https?:\/\//.test(String(f.url || '')));
      if (!faces.length) return json(res, 400, { error: 'no font faces given' });
      for (const f of faces) await assertPublicUrl(f.url);
      const b = await browser(); const ctx = await b.newContext();
      try { return json(res, 200, { files: await fontFiles(ctx, faces) }); } finally { await ctx.close().catch(() => {}); }
    }
    if (req.url === '/diff') {
      if (!/^data:image\//.test(String(body.reference || '')) || !/^data:image\//.test(String(body.candidate || ''))) return json(res, 400, { error: 'reference and candidate must be image data URLs' });
      const b = await browser(); return json(res, 200, await diffImages(b, body.reference, body.candidate, Math.max(8, Math.min(200, Number(body.cell) || 24))));
    }

    // ---- POST /capture ----
    const url = String(body.url || '');
    try { await assertPublicUrl(url); } catch (e) { return json(res, 400, { error: e.message }); }
    let widths = (Array.isArray(body.widths) && body.widths.length ? body.widths : [1920]).map(Number).filter(w => w >= 320 && w <= 3840).slice(0, MAX_WIDTHS);
    if (!widths.length) return json(res, 400, { error: 'no valid widths (320–3840)' });
    if (body.region && process.env.FLY_REGION && body.region !== process.env.FLY_REGION) { res.writeHead(200, { 'fly-replay': `region=${body.region}` }); return res.end(); }
    const opts = { url, hideSelectors: body.hideSelectors, waitFor: body.waitFor, timeoutMs: Math.min(Number(body.timeoutMs) || 45000, 120000), locale: body.locale, timezone: body.timezone, headers: body.headers, cookies: body.cookies, screenshot: !!body.screenshot };

    if (auth.kind === 'user') {
      // plan limits: widths per capture, monthly credits, concurrent jobs, burst rate
      const q = await db.quota(auth.account);
      if (widths.length > q.widthsPerCapture) return json(res, 400, { error: `your plan allows ${q.widthsPerCapture} width${q.widthsPerCapture === 1 ? '' : 's'} per capture` });
      if (q.remaining < widths.length) return json(res, 402, { error: `not enough credits: ${q.remaining} left this month, ${widths.length} needed (resets ${q.resetsAt.slice(0, 10)})`, quota: q });
      if ((await db.activeJobs(auth.account.id)) >= q.concurrency) return json(res, 429, { error: 'a capture is already running on your account — wait for it to finish' });
      if ((await db.recentRequests(auth.keyHash, 60)) >= 10) return json(res, 429, { error: 'too many captures per minute' });
      const id = newJobId();
      await db.enqueue({ id, accountId: auth.account.id, keyHash: auth.keyHash, request: { opts, widths } });
      if (body.async) return json(res, 202, { jobId: id, poll: `/jobs/${id}`, quota: { ...q, remaining: q.remaining - widths.length } });
      // sync callers: wait for the worker
      for (let i = 0; i < 600; i++) {
        await new Promise(r => setTimeout(r, 500));
        const j = await db.get(id, auth.account.id);
        if (!j) return json(res, 500, { error: 'job vanished' });
        if (j.status === 'done') { await db.remove(id); return json(res, 200, j.result); }
        if (j.status === 'error') return json(res, 500, { error: j.error });
      }
      return json(res, 504, { error: 'capture timed out' });
    }

    // admin / anon / single-tenant: run here
    if (inflight >= MAX_INFLIGHT) return json(res, 429, { error: 'busy, retry shortly' });
    if (body.async) {
      const job = memJob(widths);
      inflight++;
      const t0 = Date.now();
      runCapture(opts, widths, p => { job.status = 'running'; Object.assign(job, p); })
        .then(captures => { job.result = { url, title: captures[0].capture.title, region: REGION, ms: Date.now() - t0, captures }; job.status = 'done'; job.progress = 1; job.message = 'Done'; })
        .catch(e => { console.error('capture failed', url, e); job.status = 'error'; job.error = friendly(e); })
        .finally(() => { inflight--; });
      return json(res, 202, { jobId: job.id, poll: `/jobs/${job.id}` });
    }
    inflight++;
    const t0 = Date.now();
    try {
      const captures = await runCapture(opts, widths, null);
      json(res, 200, { url, title: captures[0].capture.title, region: REGION, ms: Date.now() - t0, captures });
    } catch (e) { console.error('capture failed', url, e); json(res, 500, { error: friendly(e) }); }
    finally { inflight--; }
  } catch (e) {
    console.error('request failed', req.url, e);
    if (!res.headersSent) json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
});

(async () => {
  if (db) { await db.migrate(); console.log('database ready (multi-tenant mode)'); }
  server.listen(PORT, () => console.log(`html2figma capture server on :${PORT} (region ${REGION}, ${db ? 'license keys' : API_KEY ? 'shared key' : 'NO AUTH'})`));
  browser().catch(e => console.error('browser launch failed', e));
})().catch(e => { console.error('startup failed', e); process.exit(1); });
process.on('SIGTERM', async () => { try { (await browserP)?.close(); } catch {} try { await db?.close(); } catch {} process.exit(0); });
