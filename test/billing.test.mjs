// Billing against a local Postgres with a fake Stripe client: checkout → account + key shown once,
// webhook signature verification (real stripe library), plan sync on subscription updates, portal link.
import http from 'node:http';
import { spawn } from 'node:child_process';
import Stripe from 'stripe';
import pg from 'pg';
import { Billing, planFromLookupKey } from '../server/billing.mjs';
import { Db } from '../server/db.mjs';

const DB = process.env.TEST_DATABASE_URL || 'postgres://h2f:h2f@127.0.0.1:5432/h2f_test';
const pool = new pg.Pool({ connectionString: DB });
await pool.query('drop table if exists jobs, usage, api_keys, accounts cascade');
await pool.end();
const db = new Db(DB); await db.migrate();

let fails = 0; const check = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const WH = 'whsec_test_secret';
const real = new Stripe('sk_test_dummy');

// fake Stripe: prices by lookup key, checkout sessions in memory, portal sessions; webhooks delegate to the real verifier
const sessions = new Map();
const fake = {
  webhooks: real.webhooks,
  prices: { list: async ({ lookup_keys: [k] }) => ({ data: /^h2f_(pro|team)_(month|year)$/.test(k) ? [{ id: 'price_' + k, lookup_key: k }] : [] }) },
  checkout: { sessions: {
    create: async p => { const id = 'cs_' + sessions.size; const s = { id, url: 'https://checkout.stripe.test/' + id, status: 'open', payment_status: 'unpaid', customer: null, subscription: null, metadata: p.metadata, customer_details: null }; sessions.set(id, s); return s; },
    retrieve: async id => { const s = sessions.get(id); if (!s) throw new Error('No such checkout session'); return s; },
  } },
  billingPortal: { sessions: { create: async ({ customer }) => ({ url: 'https://billing.stripe.test/' + customer }) } },
};
const welcomed = [];
const billing = new Billing({ db, stripe: fake, webhookSecret: WH, publicUrl: 'https://h2f.test', onWelcome: async a => { welcomed.push(a.email); } });
const req = { headers: { host: 'h2f.test' } };

check(planFromLookupKey('h2f_team_year') === 'team' && planFromLookupKey('h2f_x') === null, 'lookup keys map to plans');

// 1. checkout link
const url = await billing.checkoutUrl(req, 'pro', 'month', 'jane@studio.com');
const sid = url.split('/').pop();
check(url.startsWith('https://checkout.stripe.test/') && sessions.get(sid).metadata.h2f_plan === 'pro', `checkout session created for pro (${url})`);
check(await billing.checkoutUrl(req, 'nope').catch(e => e.message) === 'unknown plan', 'unknown plan refused');

// 2. success page before payment → pending
check((await billing.fulfil(sessions.get(sid))) === null, 'unpaid session → nothing fulfilled');

// 3. payment completes: the webhook (signed) fulfils it, the success page then shows the key once
Object.assign(sessions.get(sid), { status: 'complete', payment_status: 'paid', customer: 'cus_jane', subscription: 'sub_jane', customer_details: { email: 'Jane@Studio.com' } });
const sign = payload => real.webhooks.generateTestHeaderString({ payload, secret: WH });
const evt = JSON.stringify({ id: 'evt_1', object: 'event', type: 'checkout.session.completed', data: { object: { id: sid } } });
const bad = await billing.handleWebhook(evt, sign(evt).replace(/v1=[0-9a-f]{4}/, 'v1=dead')).catch(e => e.message);
check(/signature/i.test(bad), `tampered signature rejected (${bad.slice(0, 60)})`);
const what = await billing.handleWebhook(evt, sign(evt));
check(/checkout: jane@studio.com → pro/.test(what), `webhook fulfilled checkout: ${what}`);
const acct = (await db.pool.query("select * from accounts where email='jane@studio.com'")).rows[0];
check(acct && acct.plan === 'pro' && acct.stripe_customer_id === 'cus_jane' && acct.stripe_subscription_id === 'sub_jane', 'account created with plan, customer and subscription ids');
check((await db.pool.query('select count(*)::int as n from api_keys where account_id=$1', [acct.id])).rows[0].n === 0, 'webhook creates the account but never mints a key (it could not be shown)');
const first = await billing.fulfil(sessions.get(sid));
check(first.key && first.key.startsWith('h2f_live_'), 'success page mints and shows the key');
const second = await billing.fulfil(sessions.get(sid));
check(second.key === null && second.keyPrefix === first.key.slice(0, 13), 'a refresh shows only the prefix — never the key twice');
const keys = (await db.pool.query('select * from api_keys where account_id=$1', [acct.id])).rows;
check(keys.length === 1 && keys[0].label === 'checkout ' + sid, 'exactly one key per checkout session');
const quota = await db.quota((await db.pool.query("select * from accounts where email='jane@studio.com'")).rows[0]);
check(quota.credits === 300 && quota.widthsPerCapture === 4, `pro limits apply (${quota.credits} credits)`);

// 4. success page first (webhook late) mints and shows the key exactly once
const url2 = await billing.checkoutUrl(req, 'team', 'year', 'bob@agency.com'); const sid2 = url2.split('/').pop();
Object.assign(sessions.get(sid2), { status: 'complete', payment_status: 'paid', customer: 'cus_bob', subscription: 'sub_bob', customer_details: { email: 'bob@agency.com' } });
const shown = await billing.fulfil(sessions.get(sid2));
check(shown.key && shown.key.startsWith('h2f_live_') && shown.account.plan === 'team', 'success page mints and shows the key when the webhook has not arrived');
const evt2 = JSON.stringify({ id: 'evt_2', object: 'event', type: 'checkout.session.completed', data: { object: { id: sid2 } } });
await billing.handleWebhook(evt2, sign(evt2));
check((await db.pool.query("select count(*)::int as n from api_keys k join accounts a on a.id=k.account_id where a.email='bob@agency.com'")).rows[0].n === 1, 'late webhook does not mint a second key');
check(!!(await db.authenticate(shown.key)), 'the shown key authenticates');

// 5. subscription lifecycle: downgrade via price change, then cancellation → free
const upd = JSON.stringify({ id: 'evt_3', object: 'event', type: 'customer.subscription.updated', data: { object: { id: 'sub_bob', customer: 'cus_bob', status: 'active', items: { data: [{ price: { lookup_key: 'h2f_pro_month' } }] } } } });
check(/→ pro/.test(await billing.handleWebhook(upd, sign(upd))), 'plan follows the subscription price (team → pro)');
const unpaid = JSON.stringify({ id: 'evt_4', object: 'event', type: 'customer.subscription.updated', data: { object: { id: 'sub_bob', customer: 'cus_bob', status: 'unpaid', items: { data: [{ price: { lookup_key: 'h2f_pro_month' } }] } } } });
check(/→ free/.test(await billing.handleWebhook(unpaid, sign(unpaid))), 'unpaid subscription drops to free');
const del = JSON.stringify({ id: 'evt_5', object: 'event', type: 'customer.subscription.deleted', data: { object: { id: 'sub_jane', customer: 'cus_jane' } } });
await billing.handleWebhook(del, sign(del));
const jane = (await db.pool.query("select plan, stripe_subscription_id from accounts where email='jane@studio.com'")).rows[0];
check(jane.plan === 'free' && jane.stripe_subscription_id === null, 'cancelled subscription → free, key still valid for the free tier');
check(!!(await db.authenticate(shown.key)), 'keys survive a downgrade (free tier)');
check(welcomed.length === 2 && welcomed.includes('jane@studio.com') && welcomed.includes('bob@agency.com'), `welcome hook fired once per account (${welcomed.join(', ')})`);

// 6. an unlimited account (the owner, a comped customer) is never re-planned by Stripe
await db.createAccount('owner@h2f.test', 'unlimited');
const url3 = await billing.checkoutUrl(req, 'pro', 'month', 'owner@h2f.test'); const sid3 = url3.split('/').pop();
Object.assign(sessions.get(sid3), { status: 'complete', payment_status: 'paid', customer: 'cus_owner', subscription: 'sub_owner', customer_details: { email: 'owner@h2f.test' } });
const own = await billing.fulfil(sessions.get(sid3));
check(own.key && own.account.plan === 'unlimited' && (await db.accountByEmail('owner@h2f.test')).plan === 'unlimited', 'checkout by an unlimited account keeps it unlimited (key still issued)');
const ownDel = JSON.stringify({ id: 'evt_6', object: 'event', type: 'customer.subscription.deleted', data: { object: { id: 'sub_owner', customer: 'cus_owner' } } });
check(/→ unlimited/.test(await billing.handleWebhook(ownDel, sign(ownDel))) && (await db.accountByEmail('owner@h2f.test')).plan === 'unlimited', 'cancelling that subscription leaves it unlimited');
const ownUpd = JSON.stringify({ id: 'evt_7', object: 'event', type: 'customer.subscription.updated', data: { object: { id: 'sub_owner', customer: 'cus_owner', status: 'unpaid', items: { data: [] } } } });
check(/unchanged/.test(await billing.handleWebhook(ownUpd, sign(ownUpd))), 'subscription updates skip unlimited accounts');

// 7. portal
check((await billing.portalUrl(req, 'Jane@studio.com')) === 'https://billing.stripe.test/cus_jane', 'billing portal link for a customer');
check(/no subscription/.test(await billing.portalUrl(req, 'nobody@x.com').catch(e => e.message)), 'portal refuses unknown email');

// 8. the server exposes the routes when STRIPE_SECRET_KEY is set (no real Stripe calls: only /welcome without a session id)
const env = { ...process.env, PORT: '8125', DATABASE_URL: DB, H2F_API_KEY: 'admin-secret', STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_WEBHOOK_SECRET: WH, H2F_ALLOW_PRIVATE: '1' };
const proc = spawn('node', ['server/index.mjs'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
for (let i = 0; i < 40; i++) { try { const h = await fetch('http://127.0.0.1:8125/healthz'); if (h.ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }
const health = await (await fetch('http://127.0.0.1:8125/healthz')).json();
check(health.features.includes('billing'), 'server advertises billing');
const welcome = await fetch('http://127.0.0.1:8125/welcome');
check(welcome.status === 200 && /html2figma/.test(await welcome.text()), '/welcome page served without auth');
const hook = await fetch('http://127.0.0.1:8125/stripe/webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 'nope' } });
check(hook.status === 400, `webhook with a bad signature → 400`);
const openPortal = await fetch('http://127.0.0.1:8125/portal?email=jane@studio.com', { redirect: 'manual' });
check(openPortal.status === 401, `/portal without a signed token is refused (${openPortal.status}) — no portal access by email alone`);
proc.kill('SIGTERM');
await db.close();
console.log(fails ? `\n${fails} check(s) failed` : '\nall billing checks passed');
process.exit(fails ? 1 : 0);
