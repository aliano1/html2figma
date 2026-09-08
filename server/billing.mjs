/**
 * Stripe billing for multi-tenant mode.
 *
 *   GET  /buy/:plan            → redirects to Stripe Checkout for that plan (pro | team; ?interval=year for yearly)
 *   GET  /welcome?session_id=  → after checkout: creates the account if the webhook hasn't yet, mints the
 *                                license key ONCE and shows it (the key is never stored in plaintext)
 *   POST /stripe/webhook       → keeps plans in sync: checkout.session.completed, customer.subscription.updated/deleted
 *   GET  /portal?email=        → sends the customer to Stripe's billing portal (cancel, change card, invoices)
 *
 * Env: STRIPE_SECRET_KEY (restricted key: write Checkout Sessions + Billing Portal, read Customers/Subscriptions/Prices),
 *      STRIPE_WEBHOOK_SECRET (from the webhook endpoint you create in the Dashboard).
 * Plans are matched by the price's lookup_key `h2f_<plan>_<month|year>` — created by scripts/stripe-setup.mjs.
 * Works identically against a sandbox (sk_test_…) and live keys.
 */
import Stripe from 'stripe';

export const PLAN_PRICES = {   // USD; edit here and re-run scripts/stripe-setup.mjs
  pro: { name: 'html2figma Pro', month: 1500, year: 14400, description: '300 captures a month, 4 widths per capture, 2 in parallel' },
  team: { name: 'html2figma Team', month: 4900, year: 47000, description: '1,500 captures a month, 4 widths per capture, 4 in parallel' },
};

export function planFromLookupKey(key) {
  const m = /^h2f_(pro|team)_(month|year)$/.exec(key || '');
  return m ? m[1] : null;
}

export class Billing {
  /**
   * @param {object} o
   * @param {import('./db.mjs').Db} o.db
   * @param {Stripe} [o.stripe]  injected in tests
   */
  constructor({ db, secretKey, webhookSecret, stripe = null, publicUrl = null }) {
    this.db = db;
    this.stripe = stripe || new Stripe(secretKey);
    this.webhookSecret = webhookSecret;
    this.publicUrl = publicUrl;
  }

  base(req) {
    if (this.publicUrl) return this.publicUrl.replace(/\/$/, '');
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  }

  async priceFor(plan, interval) {
    const key = `h2f_${plan}_${interval}`;
    const r = await this.stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
    if (!r.data[0]) throw new Error(`no active price with lookup_key ${key} — run scripts/stripe-setup.mjs`);
    return r.data[0];
  }

  /** Stripe Checkout URL for a plan */
  async checkoutUrl(req, plan, interval = 'month', email = null) {
    if (!PLAN_PRICES[plan]) throw new Error('unknown plan');
    if (!['month', 'year'].includes(interval)) throw new Error('interval must be month or year');
    const price = await this.priceFor(plan, interval);
    const base = this.base(req);
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: `${base}/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/buy/${plan}?cancelled=1`,
      allow_promotion_codes: true,
      customer_email: email || undefined,
      billing_address_collection: 'auto',
      subscription_data: { metadata: { h2f_plan: plan } },
      metadata: { h2f_plan: plan },
    });
    return session.url;
  }

  /** Account for a Stripe customer — created on first sight (idempotent on customer id, then email). */
  async accountForCustomer(customerId, email, plan) {
    const byCustomer = await this.db.pool.query('select * from accounts where stripe_customer_id=$1', [customerId]);
    if (byCustomer.rows[0]) { if (plan) await this.db.pool.query('update accounts set plan=$2 where id=$1', [byCustomer.rows[0].id, plan]); return { ...byCustomer.rows[0], plan: plan || byCustomer.rows[0].plan }; }
    const acct = await this.db.createAccount(email, plan || 'free');
    await this.db.pool.query('update accounts set stripe_customer_id=$2 where id=$1', [acct.id, customerId]);
    return { ...acct, stripe_customer_id: customerId };
  }

  planFromSubscription(sub) {
    for (const item of sub.items?.data || []) { const p = planFromLookupKey(item.price?.lookup_key); if (p) return p; }
    return sub.metadata?.h2f_plan || null;
  }

  /**
   * Called after checkout by the success page (mint = true: shows the key once) and by the webhook
   * (mint = false: the webhook usually lands before the customer does, and a key minted there could
   * never be shown — only its hash is stored). Returns { account, key? }.
   */
  async fulfil(session, { mint = true } = {}) {
    if (session.payment_status !== 'paid' && session.status !== 'complete') return null;
    const email = session.customer_details?.email || session.customer_email;
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    const plan = session.metadata?.h2f_plan || 'pro';
    if (!email || !customerId) throw new Error('checkout session has no customer');
    const account = await this.accountForCustomer(customerId, email, plan);
    if (session.subscription) await this.db.pool.query('update accounts set stripe_subscription_id=$2 where id=$1', [account.id, typeof session.subscription === 'string' ? session.subscription : session.subscription.id]);
    // one key per checkout session: the session id is recorded on the key so a refresh never mints a second one
    const existing = await this.db.pool.query('select prefix from api_keys where account_id=$1 and label=$2', [account.id, 'checkout ' + session.id]);
    if (existing.rows[0]) return { account, key: null, keyPrefix: existing.rows[0].prefix };
    if (!mint) return { account, key: null, keyPrefix: null };
    try {
      const { key } = await this.db.createKey(account.email, 'checkout ' + session.id);
      return { account, key };
    } catch (e) {
      if (e.code !== '23505') throw e;   // unique violation: the webhook and the success page raced — the other one minted it
      const again = await this.db.pool.query('select prefix from api_keys where account_id=$1 and label=$2', [account.id, 'checkout ' + session.id]);
      return { account, key: null, keyPrefix: again.rows[0]?.prefix };
    }
  }

  /** Webhook: verify signature, apply the event. Returns a short description for logs. */
  async handleWebhook(rawBody, signature) {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = await this.stripe.checkout.sessions.retrieve(event.data.object.id, { expand: ['subscription'] });
        const r = await this.fulfil(session, { mint: false });
        return r ? `checkout: ${r.account.email} → ${r.account.plan}` : 'checkout: not paid yet';
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const plan = this.planFromSubscription(sub);
        const active = ['active', 'trialing', 'past_due'].includes(sub.status);
        const r = await this.db.pool.query('update accounts set plan=$2 where stripe_customer_id=$1 returning email', [sub.customer, active && plan ? plan : 'free']);
        return `subscription ${sub.status}: ${r.rows[0]?.email || sub.customer} → ${active && plan ? plan : 'free'}`;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const r = await this.db.pool.query("update accounts set plan='free', stripe_subscription_id=null where stripe_customer_id=$1 returning email", [sub.customer]);
        return `subscription ended: ${r.rows[0]?.email || sub.customer} → free`;
      }
      default:
        return `ignored ${event.type}`;
    }
  }

  async portalUrl(req, email) {
    const r = await this.db.pool.query('select stripe_customer_id from accounts where email=$1', [email.toLowerCase()]);
    if (!r.rows[0]?.stripe_customer_id) throw new Error('no subscription for that email');
    const s = await this.stripe.billingPortal.sessions.create({ customer: r.rows[0].stripe_customer_id, return_url: this.base(req) + '/welcome?portal=1' });
    return s.url;
  }
}

// ---------- tiny HTML pages ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:8vh auto;padding:0 20px;color:#1a1a1a}code{font:14px ui-monospace,monospace;background:#f3f4f6;padding:10px 14px;border-radius:8px;display:block;word-break:break-all;user-select:all}h1{font-size:22px}p.muted{color:#666}a.btn{display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none}</style>
${body}`;
}
export function welcomePage(r) {
  if (!r) return page('Payment pending', `<h1>Almost there</h1><p>Your payment is still being confirmed. Refresh this page in a few seconds.</p>`);
  if (r.key) return page('Your license key', `<h1>Thanks — you're on ${esc(r.account.plan)}</h1>
<p>This is your license key. It is shown <b>once</b>; copy it now and paste it into the html2figma plugin (From URL → License key).</p>
<code>${esc(r.key)}</code>
<p class="muted">Manage or cancel your subscription any time from the <a href="/portal?email=${encodeURIComponent(r.account.email)}">billing portal</a>. Lost the key? Reply to your receipt email and we'll issue a new one.</p>`);
  if (!r.keyPrefix) return page('Payment received', `<h1>Payment received</h1><p>Your account is on ${esc(r.account.plan)}. Refresh this page to get your license key.</p>`);
  return page('License key already issued', `<h1>Key already issued</h1><p>The key for this purchase (starting <code style="display:inline;padding:2px 6px">${esc(r.keyPrefix)}…</code>) was shown when you completed checkout. If you didn't save it, reply to your receipt email and we'll issue a replacement.</p>
<p><a href="/portal?email=${encodeURIComponent(r.account.email)}">Billing portal</a></p>`);
}
