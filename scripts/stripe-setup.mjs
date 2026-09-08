#!/usr/bin/env node
/**
 * Creates the html2figma products and prices in your Stripe account (sandbox or live — whichever key you pass).
 * Idempotent: prices are found by lookup_key (h2f_pro_month, h2f_pro_year, h2f_team_month, h2f_team_year).
 *
 *   STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-setup.mjs [https://your-server]
 *
 * Prints the checkout links to put on your site. Amounts live in server/billing.mjs (PLAN_PRICES).
 */
import Stripe from 'stripe';
import { PLAN_PRICES } from '../server/billing.mjs';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('STRIPE_SECRET_KEY is not set'); process.exit(1); }
const stripe = new Stripe(key);
const base = (process.argv[2] || process.env.H2F_PUBLIC_URL || 'https://YOUR-SERVER').replace(/\/$/, '');
console.log(`Stripe ${key.startsWith('sk_test') || key.startsWith('rk_test') ? 'SANDBOX' : 'LIVE'} account\n`);

for (const [plan, def] of Object.entries(PLAN_PRICES)) {
  // product: reuse one tagged with metadata.h2f_plan
  let product = (await stripe.products.search({ query: `metadata['h2f_plan']:'${plan}' AND active:'true'` })).data[0];
  if (!product) {
    product = await stripe.products.create({ name: def.name, description: def.description, metadata: { h2f_plan: plan } });
    console.log(`created product ${product.name} (${product.id})`);
  } else console.log(`product ${product.name} exists (${product.id})`);
  for (const interval of ['month', 'year']) {
    const lookup = `h2f_${plan}_${interval}`;
    const existing = (await stripe.prices.list({ lookup_keys: [lookup], active: true, limit: 1 })).data[0];
    const amount = def[interval];
    if (existing && existing.unit_amount === amount) { console.log(`  price ${lookup} exists: $${amount / 100}/${interval} (${existing.id})`); continue; }
    const price = await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: amount, recurring: { interval }, lookup_key: lookup, transfer_lookup_key: true });
    if (existing) await stripe.prices.update(existing.id, { active: false });
    console.log(`  ${existing ? 'replaced' : 'created'} price ${lookup}: $${amount / 100}/${interval} (${price.id})`);
  }
}

console.log(`
Checkout links (put these behind your Buy buttons):
  Pro monthly   ${base}/buy/pro
  Pro yearly    ${base}/buy/pro?interval=year
  Team monthly  ${base}/buy/team
  Team yearly   ${base}/buy/team?interval=year

Next: Dashboard → Developers → Webhooks → Add endpoint
  URL     ${base}/stripe/webhook
  Events  checkout.session.completed, customer.subscription.updated, customer.subscription.deleted
then set STRIPE_WEBHOOK_SECRET (whsec_…) on the server and redeploy.`);
