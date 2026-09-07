// Multi-tenant mode against a local Postgres (TEST_DATABASE_URL). Boots the server with DATABASE_URL,
// mints keys through the admin CLI, and checks auth, quotas, the queue, metering and the SSRF guard.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import pg from 'pg';

const DB = process.env.TEST_DATABASE_URL || 'postgres://h2f:h2f@127.0.0.1:5432/h2f_test';
const pool = new pg.Pool({ connectionString: DB });
await pool.query('drop table if exists jobs, usage, api_keys, accounts cascade');

const mime = { html: 'text/html', png: 'image/png', webm: 'video/webm', woff2: 'font/woff2' };
const srv = http.createServer((q, r) => {
  try { const p = join('test', q.url === '/' ? 'page.html' : q.url.split('?')[0]); const buf = readFileSync(p); r.setHeader('content-type', mime[p.split('.').pop()] || 'application/octet-stream'); r.end(buf); }
  catch { r.statusCode = 404; r.end(); }
}).listen(8099);

const env = { ...process.env, PORT: '8124', DATABASE_URL: DB, H2F_API_KEY: 'admin-secret', H2F_ALLOW_PRIVATE: '1' };
const proc = spawn('node', ['server/index.mjs'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
for (let i = 0; i < 40; i++) { try { const h = await fetch('http://127.0.0.1:8124/healthz'); if (h.ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }

let fails = 0; const check = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const admin = (...args) => execFileSync('node', ['scripts/h2f-admin.mjs', ...args], { env }).toString();
const api = (path, key, body, method) => fetch('http://127.0.0.1:8124' + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) }, body: body ? JSON.stringify(body) : undefined });

const health = await (await api('/healthz')).json();
check(health.mode === 'multi-tenant' && health.features.includes('accounts'), `server in multi-tenant mode (${health.mode})`);

// accounts + keys via the CLI
admin('account', 'ali@example.com', 'free');
const key = admin('key', 'ali@example.com', 'figma plugin').match(/h2f_live_[0-9a-f]{32}/)[0];
check(!!key, `license key minted (${key.slice(0, 16)}…)`);
admin('plan', 'ali@example.com', 'free', '3');   // custom cap: 3 credits this month

// auth
check((await api('/me')).status === 401, 'no key → 401');
check((await api('/me', 'h2f_live_' + '0'.repeat(32))).status === 401, 'unknown key → 401');
const me = await (await api('/me', key)).json();
check(me.email === 'ali@example.com' && me.plan === 'free' && me.credits === 3 && me.remaining === 3, `/me reports plan and credits (${JSON.stringify(me)})`);

// SSRF guard is bypassed by H2F_ALLOW_PRIVATE for the local test page, but scheme/credential checks still apply
check((await api('/capture', key, { url: 'ftp://example.com/' })).status === 400, 'non-http URL refused');

// a capture through the queue, async, with progress
const t0 = Date.now();
const start = await api('/capture', key, { url: 'http://localhost:8099/', widths: [1280, 390], async: true });
const job = await start.json();
check(start.status === 202 && job.jobId && job.quota.remaining === 1, `async capture accepted, quota shows 1 credit left after this job (${JSON.stringify(job.quota)})`);
let last = null, stages = new Set(), polls = 0;
while (polls++ < 300) { await new Promise(r => setTimeout(r, 300)); last = await (await api('/jobs/' + job.jobId, key)).json(); if (last.stage) stages.add(last.stage); if (last.status === 'done' || last.status === 'error') break; }
check(last.status === 'done' && last.result && last.result.captures.length === 2, `queued job ran on the worker and delivered 2 captures in ${Math.round((Date.now() - t0) / 1000)} s (${last.error || last.status})`);
check(stages.size >= 3, `progress stages recorded in Postgres: ${[...stages].join(' → ')}`);
check((await api('/jobs/' + job.jobId, key)).status === 404, 'result delivered once, row removed');

// metering
const me2 = await (await api('/me', key)).json();
check(me2.used === 2 && me2.remaining === 1, `usage metered: 2 credits used, 1 left (${me2.used}/${me2.credits})`);
const over = await api('/capture', key, { url: 'http://localhost:8099/', widths: [1280, 390] });
check(over.status === 402, `over quota → 402 (${over.status}: ${(await over.json()).error})`);
const okOne = await api('/capture', key, { url: 'http://localhost:8099/', widths: [390] });
check(okOne.status === 200 && (await okOne.json()).captures.length === 1, 'sync capture within the remaining credit succeeds');
check((await api('/capture', key, { url: 'http://localhost:8099/', widths: [390] })).status === 402, 'then the account is out of credits');
const usage = admin('usage', 'ali@example.com');
check(/3\/3 credits used/.test(usage), `admin usage view: ${usage.split('\n')[0]}`);

// plan limits: free allows 2 widths per capture
admin('plan', 'ali@example.com', 'free');
const many = await api('/capture', key, { url: 'http://localhost:8099/', widths: [1920, 1440, 1024, 390] });
check(many.status === 400 && /2 widths/.test((await many.json()).error), 'free plan refuses 4 widths per capture');

// admin key still works and is unmetered; revoked key stops working; another user cannot read this user's job
const adm = await api('/me', 'admin-secret');
check(adm.status === 200 && (await adm.json()).plan === 'admin', 'shared admin key still accepted');
admin('revoke', key);
check((await api('/me', key)).status === 401, 'revoked key → 401');
proc.kill('SIGTERM'); srv.close(); await pool.end();
console.log(fails ? `\n${fails} check(s) failed` : '\nall tenant checks passed');
process.exit(fails ? 1 : 0);
