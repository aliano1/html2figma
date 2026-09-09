/**
 * Customer self-service — no passwords, no support inbox for lost keys.
 *
 *   GET  /account              sign-in form (email) — or, with ?token=, the account page
 *   POST /account/link         emails a one-time sign-in link (valid 30 min); always answers the same way
 *   POST /account/key          mints a new license key, shown once            (needs token)
 *   POST /account/revoke       revokes a key by its visible prefix              (needs token)
 *   GET  /portal?token=        Stripe billing portal: card, invoices, cancel   (needs token)
 *
 * Tokens are HMAC-signed `{ email, exp }` blobs (H2F_SECRET, or derived from the other secrets), so a
 * link proves control of the mailbox without any server-side session state. Multi-replica safe.
 */
import { PRODUCT } from './brand.mjs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { page } from './billing.mjs';
import { escapeHtml as esc } from './mail.mjs';

const b64u = b => Buffer.from(b).toString('base64url');

export class Accounts {
  constructor({ db, mailer, secret, billing = null, publicUrl = null, linkTtlMs = 30 * 60e3, productName = PRODUCT }) {
    if (!secret) throw new Error('Accounts needs a secret');
    this.db = db; this.mailer = mailer; this.secret = secret; this.billing = billing; this.publicUrl = publicUrl;
    this.linkTtlMs = linkTtlMs; this.productName = productName;
    this.recent = new Map();   // email → [timestamps] for link-request throttling
    this.lastBase = null;
  }

  // ---- tokens ----
  sign(email, ttlMs = this.linkTtlMs) {
    const payload = b64u(JSON.stringify({ e: email.toLowerCase(), x: Date.now() + ttlMs }));
    return payload + '.' + this.mac(payload);
  }
  mac(payload) { return createHmac('sha256', this.secret).update(payload).digest('base64url'); }
  /** → email or null */
  verify(token) {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const want = Buffer.from(this.mac(payload)); const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try { const { e, x } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return x > Date.now() && typeof e === 'string' ? e : null; }
    catch { return null; }
  }

  base(req) {
    if (this.publicUrl) return this.publicUrl.replace(/\/$/, '');
    if (req) { const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0]; this.lastBase = `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`; }
    return this.lastBase || 'https://YOUR-SERVER';
  }
  link(email, req) { return `${this.base(req)}/account?token=${encodeURIComponent(this.sign(email))}`; }

  // ---- mail ----
  throttled(email) {
    const now = Date.now(); const list = (this.recent.get(email) || []).filter(t => now - t < 10 * 60e3);
    this.recent.set(email, list);
    if (list.length >= 3) return true;
    list.push(now); return false;
  }
  /** Sign-in link for an existing account. Silent for unknown addresses (no enumeration). */
  async requestLink(req, emailRaw) {
    const email = String(emailRaw || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'That does not look like an email address.' };
    if (this.throttled(email)) return { ok: true };
    const account = await this.db.accountByEmail(email);
    if (!account) return { ok: true };
    await this.mailer.send({ to: email, subject: `Sign in to ${this.productName}`,
      text: `Here is your sign-in link for ${this.productName}. It works once and expires in 30 minutes.\n\n${this.link(email, req)}\n\nIf you did not request it, ignore this email.` });
    return { ok: true };
  }
  /** Free tier sign-up: creates the account on first sight, then behaves exactly like requestLink. */
  async signup(req, emailRaw, ip = '') {
    const email = String(emailRaw || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'That does not look like an email address.' };
    if (this.throttledIp(ip)) return { ok: false, error: 'Too many sign-ups from this network — try again in an hour.' };
    if (!(await this.db.accountByEmail(email))) {
      await this.db.createAccount(email, 'free');
      if (!this.throttled(email)) await this.mailer.send({ to: email, subject: `Your free ${this.productName} account`,
        text: `Welcome to ${this.productName}. Your free plan includes ${this.freeCredits} captures a month.\n\nOpen your account page to create a license key, then paste it into the Figma plugin under From URL → License key:\n\n${this.link(email, req)}\n\nThe link works for 30 minutes; request a new one any time at ${this.base(req)}/account.` });
      return { ok: true };
    }
    return this.requestLink(req, email);
  }
  throttledIp(ip) {
    if (!ip) return false;
    const now = Date.now(); const list = (this.recent.get('ip:' + ip) || []).filter(t => now - t < 60 * 60e3);
    this.recent.set('ip:' + ip, list);
    if (list.length >= 10) return true;
    list.push(now); return false;
  }
  get freeCredits() { return this.db.limits({ plan: 'free' }).credits; }

  /** After the first paid checkout: receipt-style welcome with the account link. */
  async sendWelcome(account, req = null) {
    const base = this.base(req);
    await this.mailer.send({ to: account.email, subject: `Welcome to ${this.productName} — you're on ${account.plan}`,
      text: `Thanks for subscribing to ${this.productName} ${account.plan}.\n\nYour license key was shown on the confirmation page (it is only ever shown once). If you missed it, create a new one from your account page:\n\n${this.link(account.email, req)}\n\nThe same page shows your monthly usage and has the billing portal for invoices, card changes and cancellation. Sign-in links expire after 30 minutes — request a fresh one any time at ${base}/account.\n\nPaste the key into the Figma plugin under From URL → License key.` });
  }

  // ---- pages ----
  signInPage({ email = '', sent = false, error = null } = {}) {
    if (sent) return page('Check your email', `<h1>Check your email</h1><p>If <b>${esc(email)}</b> has an ${esc(this.productName)} account, a sign-in link is on its way. It expires in 30 minutes.</p><p class="muted">Nothing arrived? Check spam, or make sure you used the email from your Stripe receipt.</p>`);
    return page('Sign in', `<h1>Your ${esc(this.productName)} account</h1>
<p>Enter the email you used at checkout and we'll send a sign-in link — no password.</p>
${error ? `<p style="color:#b91c1c">${esc(error)}</p>` : ''}
<form method="post" action="/account/link" style="display:flex;gap:8px;flex-wrap:wrap"><input name="email" type="email" required value="${esc(email)}" placeholder="you@studio.com" style="flex:1;min-width:220px;font:16px system-ui;padding:10px 12px;border:1px solid #ccc;border-radius:8px"><button class="btn" style="font:16px system-ui;background:#111;color:#fff;border:0;padding:10px 16px;border-radius:8px;cursor:pointer">Email me a link</button></form>
<p class="muted">No account yet? <a href="/buy/pro">Get Pro</a> · <a href="/buy/team">Get Team</a></p>`);
  }
  accountPage({ account, quota, keys, token, newKey = null, notice = null }) {
    const t = encodeURIComponent(token);
    const fmt = d => d ? new Date(d).toISOString().slice(0, 10) : '—';
    const label = k => /^checkout /.test(k.label || '') ? 'purchase' : (k.label || '');
    const sorted = [...keys].sort((a, b) => (a.revoked_at ? 1 : 0) - (b.revoked_at ? 1 : 0));   // active first
    const rows = sorted.map(k => `<tr${k.revoked_at ? ' class="muted"' : ''}><td><code style="display:inline;padding:2px 6px;white-space:nowrap">${esc(k.prefix)}…</code></td><td>${esc(label(k))}</td><td>${fmt(k.created_at)}</td><td>${fmt(k.last_used_at)}</td><td>${k.revoked_at ? 'revoked' : `<form method="post" action="/account/revoke" style="display:inline"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="prefix" value="${esc(k.prefix)}"><button style="font:13px system-ui;background:none;border:1px solid #ccc;border-radius:6px;padding:4px 8px;cursor:pointer">Revoke</button></form>`}</td></tr>`).join('');
    return page('Your account', `<style>.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid #eee;white-space:nowrap}th{color:#666;font-weight:500}tr.muted{color:#888}.bar{height:8px;background:#eee;border-radius:4px;overflow:hidden}.bar i{display:block;height:100%;background:#111}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}</style>
<h1>${esc(account.email)}</h1>
<p class="row"><span>Plan: <b>${esc(quota.plan)}</b></span>${this.billing && account.stripe_customer_id ? `<a class="btn" href="/portal?token=${t}">Billing portal</a>` : ''}${this.billing && quota.plan !== 'team' && quota.plan !== 'unlimited' ? `<a href="/buy/${quota.plan === 'pro' ? 'team' : 'pro'}?email=${encodeURIComponent(account.email)}">Upgrade to ${quota.plan === 'pro' ? 'Team' : 'Pro'}</a>` : ''}</p>
<p>${quota.used} of ${quota.credits >= 1e9 ? '∞' : quota.credits} credits used this month${quota.credits < 1e9 ? ` · resets ${quota.resetsAt.slice(0, 10)}` : ''}</p>
${quota.credits < 1e9 ? `<div class="bar"><i style="width:${Math.min(100, Math.round(100 * quota.used / quota.credits))}%"></i></div>` : ''}
${notice ? `<p style="color:#166534">${esc(notice)}</p>` : ''}
${newKey ? `<h2 style="font-size:18px">Your new license key</h2><p>Shown <b>once</b> — copy it now and paste it into the plugin (From URL → License key).</p><code>${esc(newKey)}</code>` : ''}
<h2 style="font-size:18px">License keys</h2>
<div class="wrap"><table><tr><th>Key</th><th>Label</th><th>Created</th><th>Last used</th><th></th></tr>${rows || '<tr><td colspan="5" class="muted">No keys yet</td></tr>'}</table></div>
<form method="post" action="/account/key" class="row" style="margin-top:14px"><input type="hidden" name="token" value="${esc(token)}"><input name="label" placeholder="Label (optional, e.g. laptop)" style="font:14px system-ui;padding:8px 10px;border:1px solid #ccc;border-radius:8px"><button class="btn" style="font:14px system-ui;border:0;cursor:pointer">Create new key</button></form>
<p class="muted">Lost a key? Create a new one and revoke the old. Keys count against the same monthly credits. This page's link expires 30 minutes after it was issued — <a href="/account?email=${encodeURIComponent(account.email)}">request another</a>.</p>`);
  }

  // ---- routing ----
  /** @returns {Promise<boolean>} handled */
  async handle(req, res, u, readBody) {
    const html = (status, body) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(body); return true; };
    const form = async () => new URLSearchParams(await readBody(req, 1e4));
    const authed = async token => {
      const email = this.verify(token); if (!email) return null;
      const account = await this.db.accountByEmail(email); if (!account) return null;
      return { account, token };
    };
    const render = async (s, extra = {}) => html(200, this.accountPage({ account: s.account, quota: await this.db.quota(s.account), keys: await this.db.listKeys(s.account.id), token: s.token, ...extra }));
    const expired = () => html(401, this.signInPage({ error: 'That sign-in link is invalid or has expired — request a new one.' }));

    if (u.pathname === '/account' && req.method === 'GET') {
      const token = u.searchParams.get('token');
      if (!token) return html(200, this.signInPage({ email: u.searchParams.get('email') || '' }));
      const s = await authed(token); if (!s) return expired();
      this.base(req);
      return render(s);
    }
    if (u.pathname === '/account/link' && req.method === 'POST') {
      const f = await form(); const email = f.get('email') || '';
      const r = await this.requestLink(req, email);
      return html(r.ok ? 200 : 400, this.signInPage({ email, sent: r.ok, error: r.error }));
    }
    if (u.pathname === '/account/signup' && req.method === 'POST') {
      const f = await form(); const email = f.get('email') || '';
      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
      const r = await this.signup(req, email, ip);
      return html(r.ok ? 200 : 400, this.signInPage({ email, sent: r.ok, error: r.error }));
    }
    if (u.pathname === '/account/key' && req.method === 'POST') {
      const f = await form(); const s = await authed(f.get('token')); if (!s) return expired();
      const active = (await this.db.listKeys(s.account.id)).filter(k => !k.revoked_at).length;
      if (active >= 10) return render(s, { notice: 'You already have 10 active keys — revoke one first.' });
      const { key } = await this.db.createKey(s.account.email, (f.get('label') || 'account page').slice(0, 40));
      return render(s, { newKey: key });
    }
    if (u.pathname === '/account/revoke' && req.method === 'POST') {
      const f = await form(); const s = await authed(f.get('token')); if (!s) return expired();
      const ok = await this.db.revokeKeyByPrefix(s.account.id, f.get('prefix') || '');
      return render(s, { notice: ok ? `Revoked ${f.get('prefix')}…` : 'That key was already revoked.' });
    }
    if (u.pathname === '/portal' && req.method === 'GET') {
      const s = await authed(u.searchParams.get('token')); if (!s) return expired();
      if (!this.billing) return html(404, page('No billing', '<h1>Billing is not enabled on this server</h1>'));
      try { res.writeHead(303, { location: await this.billing.portalUrl(req, s.account.email) }); res.end(); return true; }
      catch (e) { return html(404, page('No subscription', `<h1>No subscription found</h1><p>${esc(e.message || e)}</p>`)); }
    }
    return false;
  }
}
