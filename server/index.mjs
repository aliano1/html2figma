/**
 * html2figma capture server
 *
 *   POST /capture   { url, widths?: [1920, 390], region?: "ams", hideSelectors?: [], waitFor?: css, timeoutMs? }
 *                   → { url, title, captures: [{ viewport: [w, h], capture }] }
 *   GET  /healthz   → { ok, region, browser }
 *
 * Auth: `Authorization: Bearer <H2F_API_KEY>` (or `x-api-key`). If H2F_API_KEY is unset the
 * server refuses to start unless H2F_ALLOW_ANON=1 (local dev only).
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE = readFileSync(join(__dirname, '..', 'dist', 'core.iife.js'), 'utf8');
const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.H2F_API_KEY || '';
const REGION = process.env.FLY_REGION || process.env.RAILWAY_REPLICA_REGION || process.env.H2F_REGION || 'local';
const MAX_WIDTHS = 4;
const DEFAULT_HIDE = ['#shopify-pc__banner', '.shopify-pc__banner', '#onetrust-consent-sdk', '#CybotCookiebotDialog', '.cc-window', '#cookie-banner', '[id*="cookie-consent"]', '[class*="cookie-consent"]', '.sca-modal-fg', '.freegifts-main-container'];
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

if (!API_KEY && process.env.H2F_ALLOW_ANON !== '1') {
  console.error('Refusing to start: set H2F_API_KEY (or H2F_ALLOW_ANON=1 for local dev).');
  process.exit(1);
}

// ---------- browser (one per process, contexts per request) ----------
let browserP = null;
let browserName = '';
const ARGS = ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--mute-audio'];
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
async function captureViewport(b, opts, width) {
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
  const page = await ctx.newPage();
  page.setDefaultTimeout(opts.timeoutMs);
  try {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: 15000 }).catch(() => {});
    await page.addScriptTag({ content: CORE });

    // warm up (lazy images/sections), then let videos reach a frame
    await page.evaluate(() => window.__h2f.warmUp(600, 120));
    await page.evaluate(() => Promise.all([...document.querySelectorAll('video')].map(v => { try { v.muted = true; return v.play().catch(() => {}); } catch { return null; } })));
    await page.waitForTimeout(600);

    const cap = await page.evaluate(({ hide }) => {
      const c = window.__h2f.extract({ hideSelectors: hide, markForRaster: true });
      return c;
    }, { hide: [...DEFAULT_HIDE, ...(opts.hideSelectors || [])] });

    // inline what the page can fetch itself (same-origin / CORS)
    await page.evaluate(async () => { window.__cap = null; });
    const inlined = await page.evaluate(async (capJson) => {
      const c = JSON.parse(capJson);
      await window.__h2f.inlineImages(c, { maxDim: 1600 });
      return JSON.stringify(c);
    }, JSON.stringify(cap));
    const capture = JSON.parse(inlined);

    // server-side fetch for anything still a URL (CORS-blocked CDNs) — uses the page's cookies
    await fetchRemaining(ctx, capture);

    // rasterise the marked elements
    await rasterise(page, capture);

    return { viewport: capture.viewport, capture };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function fetchRemaining(ctx, capture) {
  const holders = [];
  (function walk(n) {
    if (n.img && /^https?:/.test(n.img)) holders.push([n, 'img']);
    if (n.s && n.s.bgi && /^https?:/.test(n.s.bgi)) holders.push([n.s, 'bgi']);
    (n.c || []).forEach(walk);
  })(capture.tree);
  const cache = new Map();
  await Promise.all(holders.map(async ([h, k]) => {
    const url = h[k];
    if (!cache.has(url)) cache.set(url, (async () => {
      try {
        const res = await ctx.request.get(url, { timeout: 15000 });
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
      if (n.t === 'svg') { delete n.svg; n.t = 'div'; }
      delete n.c;            // the screenshot already contains any children
    } catch (e) {
      n.shotError = String(e.message || e).slice(0, 120);
    }
    delete n.shot;
  }
  await page.evaluate(() => document.querySelectorAll('[data-h2f-shot]').forEach(e => e.removeAttribute('data-h2f-shot')));
}

// ---------- HTTP ----------
function json(res, status, body, headers = {}) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...headers });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(d)); req.on('error', reject);
  });
}
function authed(req) {
  if (!API_KEY) return true;
  const h = req.headers['authorization'] || '';
  return h === `Bearer ${API_KEY}` || req.headers['x-api-key'] === API_KEY;
}

let inflight = 0;
const MAX_INFLIGHT = Number(process.env.H2F_MAX_INFLIGHT || 2);

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, x-api-key, content-type', 'access-control-allow-methods': 'POST, GET, OPTIONS' }); return res.end(); }
  if (req.url === '/healthz') return json(res, 200, { ok: true, region: REGION, browser: browserName || null, inflight });
  if (req.method !== 'POST' || req.url !== '/capture') return json(res, 404, { error: 'not found' });
  if (!authed(req)) return json(res, 401, { error: 'unauthorized' });

  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'invalid JSON' }); }
  const url = String(body.url || '');
  if (!/^https?:\/\//.test(url)) return json(res, 400, { error: 'url must be http(s)' });
  const widths = (Array.isArray(body.widths) && body.widths.length ? body.widths : [1920]).map(Number).filter(w => w >= 320 && w <= 3840).slice(0, MAX_WIDTHS);
  if (!widths.length) return json(res, 400, { error: 'no valid widths (320–3840)' });

  // Fly.io: run in the requested region
  if (body.region && process.env.FLY_REGION && body.region !== process.env.FLY_REGION) {
    res.writeHead(200, { 'fly-replay': `region=${body.region}` }); return res.end();
  }
  if (inflight >= MAX_INFLIGHT) return json(res, 429, { error: 'busy, retry shortly' });
  inflight++;
  const t0 = Date.now();
  try {
    const b = await browser();
    const opts = { url, hideSelectors: body.hideSelectors, waitFor: body.waitFor, timeoutMs: Math.min(Number(body.timeoutMs) || 45000, 120000), locale: body.locale, timezone: body.timezone, headers: body.headers, cookies: body.cookies };
    const captures = [];
    for (const w of widths) captures.push(await captureViewport(b, opts, w));   // sequential: predictable memory
    json(res, 200, { url, title: captures[0].capture.title, region: REGION, ms: Date.now() - t0, captures });
  } catch (e) {
    console.error('capture failed', url, e);
    json(res, 500, { error: String(e.message || e).slice(0, 300) });
  } finally { inflight--; }
});

server.listen(PORT, () => console.log(`html2figma capture server on :${PORT} (region ${REGION}, auth ${API_KEY ? 'on' : 'OFF'})`));
browser().catch(e => console.error('browser launch failed', e));
process.on('SIGTERM', async () => { try { (await browserP)?.close(); } catch {} process.exit(0); });
