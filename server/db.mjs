/**
 * Persistence for multi-tenant mode: accounts, license keys, usage metering and the job queue.
 * Enabled when DATABASE_URL is set (Railway Postgres → the variable is injected automatically once
 * you reference it). Without it the server runs single-tenant on H2F_API_KEY exactly as before.
 *
 * Keys look like `h2f_live_<32 hex>`; only the SHA-256 is stored. Credits: one per captured width.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

export const PLANS = {
  free: { credits: 10, concurrency: 1, widthsPerCapture: 2 },
  pro: { credits: 300, concurrency: 2, widthsPerCapture: 4 },
  team: { credits: 1500, concurrency: 4, widthsPerCapture: 4 },
  unlimited: { credits: 1e9, concurrency: 8, widthsPerCapture: 4 },
};

const SCHEMA = `
create table if not exists accounts (
  id uuid primary key,
  email text unique not null,
  plan text not null default 'free',
  credits_override int,
  created_at timestamptz not null default now()
);
create table if not exists api_keys (
  key_hash text primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  prefix text not null,
  label text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
create index if not exists api_keys_account on api_keys(account_id);
create table if not exists usage (
  id bigserial primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  key_hash text,
  url text not null,
  widths int[] not null,
  credits int not null,
  ms int,
  status text not null,
  error text,
  region text,
  created_at timestamptz not null default now()
);
create index if not exists usage_account_month on usage(account_id, created_at);
create table if not exists jobs (
  id text primary key,
  account_id uuid references accounts(id) on delete cascade,
  key_hash text,
  status text not null default 'queued',
  stage text not null default 'queued',
  message text,
  progress real not null default 0,
  width_index int not null default 0,
  request jsonb not null,
  result jsonb,
  error text,
  claimed_by text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes'
);
create index if not exists jobs_queue on jobs(status, created_at);
`;

export const hashKey = k => createHash('sha256').update(k).digest('hex');

export class Db {
  constructor(url) {
    this.pool = new pg.Pool({ connectionString: url, max: 6, ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  }
  async migrate() { await this.pool.query(SCHEMA); }
  async close() { await this.pool.end(); }

  // ---- accounts & keys ----
  async createAccount(email, plan = 'free') {
    const id = randomUUID();
    const r = await this.pool.query('insert into accounts(id, email, plan) values($1,$2,$3) on conflict(email) do update set plan = excluded.plan returning *', [id, email.toLowerCase(), plan]);
    return r.rows[0];
  }
  async setPlan(email, plan, creditsOverride = null) {
    const r = await this.pool.query('update accounts set plan=$2, credits_override=$3 where email=$1 returning *', [email.toLowerCase(), plan, creditsOverride]);
    return r.rows[0] || null;
  }
  /** Returns the plaintext key once. */
  async createKey(email, label = null) {
    const acct = (await this.pool.query('select * from accounts where email=$1', [email.toLowerCase()])).rows[0];
    if (!acct) throw new Error('no such account');
    const key = 'h2f_live_' + randomBytes(16).toString('hex');
    await this.pool.query('insert into api_keys(key_hash, account_id, prefix, label) values($1,$2,$3,$4)', [hashKey(key), acct.id, key.slice(0, 13), label]);
    return { key, account: acct };
  }
  async revokeKey(key) {
    const r = await this.pool.query('update api_keys set revoked_at=now() where key_hash=$1 and revoked_at is null', [hashKey(key)]);
    return r.rowCount > 0;
  }
  /** key → { account, keyHash } or null */
  async authenticate(key) {
    if (!key || !key.startsWith('h2f_')) return null;
    const h = hashKey(key);
    const r = await this.pool.query('select a.*, k.key_hash from api_keys k join accounts a on a.id = k.account_id where k.key_hash=$1 and k.revoked_at is null', [h]);
    if (!r.rows[0]) return null;
    this.pool.query('update api_keys set last_used_at=now() where key_hash=$1', [h]).catch(() => {});
    return { account: r.rows[0], keyHash: h };
  }

  // ---- metering ----
  monthStart() { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }
  async creditsUsed(accountId) {
    const r = await this.pool.query("select coalesce(sum(credits),0)::int as used from usage where account_id=$1 and status <> 'error' and created_at >= $2", [accountId, this.monthStart()]);
    return r.rows[0].used;
  }
  limits(account) {
    const p = PLANS[account.plan] || PLANS.free;
    return { ...p, credits: account.credits_override ?? p.credits };
  }
  async quota(account) {
    const lim = this.limits(account);
    const used = await this.creditsUsed(account.id);
    const next = new Date(this.monthStart()); next.setUTCMonth(next.getUTCMonth() + 1);
    return { plan: account.plan, credits: lim.credits, used, remaining: Math.max(0, lim.credits - used), resetsAt: next.toISOString(), concurrency: lim.concurrency, widthsPerCapture: lim.widthsPerCapture };
  }
  async recordUsage({ accountId, keyHash, url, widths, credits, ms, status, error, region }) {
    await this.pool.query('insert into usage(account_id, key_hash, url, widths, credits, ms, status, error, region) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [accountId, keyHash, url.slice(0, 2000), widths, credits, ms, status, error ? String(error).slice(0, 500) : null, region]);
  }
  async activeJobs(accountId) {
    const r = await this.pool.query("select count(*)::int as n from jobs where account_id=$1 and status in ('queued','running')", [accountId]);
    return r.rows[0].n;
  }
  /** capture requests per key in the last minute (rate limiting) */
  async recentRequests(keyHash, seconds = 60) {
    const r = await this.pool.query("select count(*)::int as n from jobs where key_hash=$1 and created_at > now() - ($2 || ' seconds')::interval", [keyHash, String(seconds)]);
    return r.rows[0].n;
  }

  // ---- job queue (works across replicas: claim with SKIP LOCKED) ----
  async enqueue({ id, accountId, keyHash, request }) {
    await this.pool.query('insert into jobs(id, account_id, key_hash, request) values($1,$2,$3,$4)', [id, accountId, keyHash, request]);
  }
  async claim(workerId) {
    const r = await this.pool.query(`
      update jobs set status='running', claimed_by=$1, started_at=now(), updated_at=now()
      where id = (select id from jobs where status='queued' and expires_at > now() order by created_at limit 1 for update skip locked)
      returning *`, [workerId]);
    return r.rows[0] || null;
  }
  async progress(id, { stage, message, progress, widthIndex }) {
    await this.pool.query('update jobs set stage=$2, message=$3, progress=$4, width_index=$5, updated_at=now() where id=$1', [id, stage, message, progress, widthIndex]);
  }
  async finish(id, result) {
    await this.pool.query("update jobs set status='done', progress=1, stage='done', message='Done', result=$2, updated_at=now(), expires_at=now() + interval '10 minutes' where id=$1", [id, result]);
  }
  async fail(id, error) {
    await this.pool.query("update jobs set status='error', error=$2, updated_at=now() where id=$1", [id, String(error).slice(0, 500)]);
  }
  async get(id, accountId) {
    const r = await this.pool.query('select * from jobs where id=$1 and ($2::uuid is null or account_id=$2)', [id, accountId]);
    return r.rows[0] || null;
  }
  /** how many queued jobs are ahead of this one */
  async position(id) {
    const r = await this.pool.query("select count(*)::int as n from jobs where status='queued' and created_at < (select created_at from jobs where id=$1)", [id]);
    return r.rows[0].n;
  }
  /** cancel: a queued job disappears; a running one is flagged and the worker stops at the next stage boundary */
  async cancel(id, accountId) {
    const j = await this.get(id, accountId);
    if (!j) return false;
    if (j.status === 'queued') { await this.remove(id); return true; }
    if (j.status === 'running') { await this.pool.query("update jobs set status='cancelled', updated_at=now() where id=$1", [id]); return true; }
    return false;
  }
  async isCancelled(id) {
    const r = await this.pool.query('select status from jobs where id=$1', [id]);
    return !r.rows[0] || r.rows[0].status === 'cancelled';
  }
  async remove(id) { await this.pool.query('delete from jobs where id=$1', [id]); }
  async sweep() {
    // stale running jobs (a replica died mid-capture) → error; expired rows → gone
    await this.pool.query("update jobs set status='error', error='worker lost' where status='running' and updated_at < now() - interval '8 minutes'");
    await this.pool.query('delete from jobs where expires_at < now()');
  }
}
