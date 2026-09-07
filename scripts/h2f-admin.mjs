#!/usr/bin/env node
/**
 * Account / license-key admin for multi-tenant mode. Needs DATABASE_URL.
 *
 *   node scripts/h2f-admin.mjs account <email> [plan]          create (or re-plan) an account: free | pro | team | unlimited
 *   node scripts/h2f-admin.mjs key <email> [label]             mint a license key (printed once)
 *   node scripts/h2f-admin.mjs revoke <h2f_live_…>             revoke a key
 *   node scripts/h2f-admin.mjs plan <email> <plan> [credits]   change plan, optional custom monthly credits
 *   node scripts/h2f-admin.mjs usage <email>                   this month's credits + last 20 captures
 *   node scripts/h2f-admin.mjs accounts                        list accounts with usage this month
 *
 * On Railway: open the service → Console (or `railway run node scripts/h2f-admin.mjs …` locally with the CLI).
 */
import { Db, PLANS } from '../server/db.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
const [cmd, a, b, c] = process.argv.slice(2);
const db = new Db(url);
await db.migrate();
try {
  if (cmd === 'account') {
    if (!a) throw new Error('email required');
    const plan = b || 'free'; if (!PLANS[plan]) throw new Error(`plan must be one of ${Object.keys(PLANS).join(', ')}`);
    const acct = await db.createAccount(a, plan);
    console.log(`account ${acct.email} · plan ${acct.plan} · ${db.limits(acct).credits} credits/month`);
  } else if (cmd === 'key') {
    if (!a) throw new Error('email required');
    const { key, account } = await db.createKey(a, b || null);
    console.log(`license key for ${account.email} (${account.plan}) — shown once:\n\n  ${key}\n`);
  } else if (cmd === 'revoke') {
    console.log((await db.revokeKey(a)) ? 'revoked' : 'no such active key');
  } else if (cmd === 'plan') {
    if (!PLANS[b]) throw new Error(`plan must be one of ${Object.keys(PLANS).join(', ')}`);
    const acct = await db.setPlan(a, b, c ? Number(c) : null);
    if (!acct) throw new Error('no such account');
    console.log(`${acct.email} → ${acct.plan}${c ? ` (${c} credits/month)` : ''}`);
  } else if (cmd === 'usage') {
    const acct = (await db.pool.query('select * from accounts where email=$1', [a.toLowerCase()])).rows[0];
    if (!acct) throw new Error('no such account');
    const q = await db.quota(acct);
    console.log(`${acct.email} · ${q.plan} · ${q.used}/${q.credits} credits used, ${q.remaining} left, resets ${q.resetsAt.slice(0, 10)}`);
    const rows = (await db.pool.query('select created_at, url, widths, credits, ms, status, error from usage where account_id=$1 order by created_at desc limit 20', [acct.id])).rows;
    for (const r of rows) console.log(`  ${r.created_at.toISOString().slice(0, 16)}  ${r.status.padEnd(5)}  ${String(r.credits).padStart(2)} cr  ${String(Math.round((r.ms || 0) / 1000)).padStart(3)} s  ${r.url.slice(0, 70)}${r.error ? '  — ' + r.error.slice(0, 60) : ''}`);
  } else if (cmd === 'accounts') {
    const rows = (await db.pool.query(`select a.email, a.plan, a.created_at, coalesce(sum(u.credits) filter (where u.created_at >= $1 and u.status <> 'error'), 0)::int as used
      from accounts a left join usage u on u.account_id = a.id group by a.id order by a.created_at`, [db.monthStart()])).rows;
    for (const r of rows) console.log(`${r.email.padEnd(36)} ${r.plan.padEnd(10)} ${String(r.used).padStart(5)} credits this month   since ${r.created_at.toISOString().slice(0, 10)}`);
    if (!rows.length) console.log('no accounts yet');
  } else {
    console.log('commands: account | key | revoke | plan | usage | accounts (see header of this file)');
  }
} catch (e) { console.error('error:', e.message); process.exitCode = 1; }
finally { await db.close(); }
