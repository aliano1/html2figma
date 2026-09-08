// Customer self-service: sign-in links (signed, expiring, throttled, no enumeration), the account page,
// minting and revoking keys, the token-gated billing portal. Unit level with a fake mailer, then the
// real server with mail unconfigured (links land in the log → we read them from the Accounts API instead).
import { spawn } from 'node:child_process';
import pg from 'pg';
import { Accounts } from '../server/account.mjs';
import { Mailer } from '../server/mail.mjs';
import { Db } from '../server/db.mjs';

const DB = process.env.TEST_DATABASE_URL || 'postgres://h2f:h2f@127.0.0.1:5432/h2f_test';
const pool = new pg.Pool({ connectionString: DB });
await pool.query('drop table if exists jobs, usage, api_keys, accounts cascade');
await pool.end();
const db = new Db(DB); await db.migrate();
let fails = 0; const check = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };

// fake transport: records what Resend would have received
const posts = [];
const mailer = new Mailer({ apiKey: 're_test', from: 'html2figma <hi@h2f.test>', fetchImpl: async (url, o) => { posts.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ id: 'em_' + posts.length }) }; } });
const fakeBilling = { portalUrl: async (req, email) => 'https://billing.stripe.test/' + email };
const accounts = new Accounts({ db, mailer, secret: 'unit-secret', billing: fakeBilling, publicUrl: 'https://h2f.test' });
const req = { headers: { host: 'h2f.test' } };

// 1. tokens
const tok = accounts.sign('Jane@Studio.com');
check(accounts.verify(tok) === 'jane@studio.com', 'signed token verifies to the lower-cased email');
check(accounts.verify(tok.slice(0, -2) + 'zz') === null && accounts.verify('garbage') === null && accounts.verify('') === null, 'tampered / malformed tokens rejected');
check(accounts.verify(accounts.sign('x@y.z', -1)) === null, 'expired token rejected');
check(new Accounts({ db, mailer, secret: 'other' }).verify(tok) === null, 'token from another secret rejected');

// 2. sign-in links: only for existing accounts, same answer either way, throttled
await db.createAccount('jane@studio.com', 'pro');
const unknown = await accounts.requestLink(req, 'nobody@x.com');
check(unknown.ok && posts.length === 0, 'unknown email: ok, nothing sent (no enumeration)');
check((await accounts.requestLink(req, 'not an email')).ok === false, 'malformed email refused');
const known = await accounts.requestLink(req, ' Jane@Studio.com ');
check(known.ok && posts.length === 1 && posts[0].to[0] === 'jane@studio.com' && posts[0].from === 'html2figma <hi@h2f.test>', 'known email gets a mail from the configured sender');
const link = /https:\/\/h2f\.test\/account\?token=([^\s]+)/.exec(posts[0].text);
check(link && accounts.verify(decodeURIComponent(link[1])) === 'jane@studio.com', 'the mail carries a valid account link');
await accounts.requestLink(req, 'jane@studio.com'); await accounts.requestLink(req, 'jane@studio.com'); await accounts.requestLink(req, 'jane@studio.com');
check(posts.length === 3, `link requests throttled to 3 per 10 minutes (${posts.length} sent)`);

// 3. welcome mail
await accounts.sendWelcome({ email: 'jane@studio.com', plan: 'pro' });
check(posts.length === 4 && /you're on pro/.test(posts[3].subject) && /\/account\?token=/.test(posts[3].text), 'welcome email names the plan and links to the account page');

// 4. unconfigured mailer logs instead of sending
const logged = [];
const quiet = new Mailer({ apiKey: undefined, log: { log: m => logged.push(m) } });
check((await quiet.send({ to: 'a@b.c', subject: 's', text: 't' })).delivered === false && logged.length === 1 && !quiet.configured, 'without RESEND_API_KEY mail is logged, not sent');

// 5. HTTP: the real server, mail unconfigured — we mint links with the same derived secret the server uses
const env = { ...process.env, PORT: '8126', DATABASE_URL: DB, H2F_API_KEY: 'admin-secret', H2F_SECRET: 'server-secret', H2F_ALLOW_PRIVATE: '1' };
delete env.RESEND_API_KEY; delete env.STRIPE_SECRET_KEY;
const proc = spawn('node', ['server/index.mjs'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
for (let i = 0; i < 40; i++) { try { const h = await fetch('http://127.0.0.1:8126/healthz'); if (h.ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }
const S = 'http://127.0.0.1:8126';
const serverTokens = new Accounts({ db, mailer: quiet, secret: 'server-secret' });
const form = (path, fields) => fetch(S + path, { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });

const signin = await fetch(S + '/account');
check(signin.status === 200 && /Email me a link/.test(await signin.text()), 'GET /account shows the sign-in form without auth');
const bad = await fetch(S + '/account?token=nope');
check(bad.status === 401 && /invalid or has expired/.test(await bad.text()), 'bad token → 401 + sign-in form');
const asked = await form('/account/link', { email: 'jane@studio.com' });
check(asked.status === 200 && /Check your email/.test(await asked.text()), 'POST /account/link answers "check your email"');

const t = serverTokens.sign('jane@studio.com');
const pageRes = await fetch(S + '/account?token=' + encodeURIComponent(t));
const pageHtml = await pageRes.text();
check(pageRes.status === 200 && /jane@studio\.com/.test(pageHtml) && /Plan: <b>pro<\/b>/.test(pageHtml) && /No keys yet/.test(pageHtml), 'account page shows email, plan and (empty) keys');
check(pageRes.headers.get('cache-control') === 'no-store', 'account page is not cacheable');

const minted = await form('/account/key', { token: t, label: 'laptop' });
const mintedHtml = await minted.text();
const key = /h2f_live_[0-9a-f]{32}/.exec(mintedHtml)?.[0];
check(minted.status === 200 && key, 'POST /account/key mints a key and shows it once');
check(/laptop/.test(mintedHtml) && new RegExp(key.slice(0, 13) + '…').test(mintedHtml), 'the key list shows its prefix and label');
const me = await (await fetch(S + '/me', { headers: { authorization: 'Bearer ' + key } })).json();
check(me.plan === 'pro' && me.email === 'jane@studio.com', 'the minted key authenticates against the API');

const again = await (await fetch(S + '/account?token=' + encodeURIComponent(t))).text();
check(!again.includes(key), 'a later page load never shows the full key again');

const revoked = await form('/account/revoke', { token: t, prefix: key.slice(0, 13) });
check(revoked.status === 200 && /Revoked h2f_live_/.test(await revoked.text()), 'POST /account/revoke revokes by prefix');
check((await fetch(S + '/me', { headers: { authorization: 'Bearer ' + key } })).status === 401, 'revoked key no longer authenticates');

const wrongOwner = await form('/account/revoke', { token: serverTokens.sign('someone@else.com'), prefix: key.slice(0, 13) });
check(wrongOwner.status === 401, 'a token for an unknown account is refused');
const noToken = await form('/account/key', { label: 'x' });
check(noToken.status === 401, 'minting without a token is refused');
const portalNoBilling = await fetch(S + '/portal?token=' + encodeURIComponent(t), { redirect: 'manual' });
check(portalNoBilling.status === 404, 'portal without Stripe configured → 404 (still needs a valid token)');

// 6. landing page + free sign-up
const landing = await fetch(S + '/'); const landingHtml = await landing.text();
check(landing.status === 200 && /<h1>Any web page/.test(landingHtml) && /\$15/.test(landingHtml) && /\$49/.test(landingHtml) && /10 credits a month/.test(landingHtml), 'landing page served at / with prices from billing.mjs and limits from db.mjs');
check(/action="\/account\/signup"/.test(landingHtml) && /Checkout not enabled/.test(landingHtml), 'free sign-up form present; buy buttons hidden without Stripe');
check(/coming soon/.test(landingHtml), 'plugin install shows "coming soon" until H2F_PLUGIN_URL is set');
const su = await form('/account/signup', { email: 'newbie@free.tier' });
check(su.status === 200 && /Check your email/.test(await su.text()), 'POST /account/signup answers "check your email"');
const newbie = await db.accountByEmail('newbie@free.tier');
check(newbie && newbie.plan === 'free', 'sign-up created a free account');
const suAgain = await form('/account/signup', { email: 'newbie@free.tier' });
check(suAgain.status === 200 && (await db.pool.query("select count(*)::int as n from accounts where email='newbie@free.tier'")).rows[0].n === 1, 'signing up twice is just a sign-in link, not a second account');
check((await form('/account/signup', { email: 'nope' })).status === 400, 'malformed sign-up email refused');
const install = await fetch(S + '/install');
check(install.status === 200 && /bookmarklet/i.test(await install.text()), '/install serves the bookmarklet page');

proc.kill('SIGTERM');
await db.close();
console.log(fails ? `\n${fails} check(s) failed` : '\nall account checks passed');
process.exit(fails ? 1 : 0);
