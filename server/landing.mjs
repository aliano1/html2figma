/**
 * The marketing page, served at `/` — self-contained (no external assets), pricing pulled from
 * billing.mjs / db.mjs so it can never disagree with what Stripe charges or what the server enforces.
 *
 * Env: H2F_PLUGIN_URL     Figma Community URL once the plugin is published (until then: "coming soon")
 *      H2F_SUPPORT_EMAIL  shown in the footer and the FAQ
 */
import { PRODUCT } from './brand.mjs';
import { PLAN_PRICES } from './billing.mjs';
import { PLANS } from './db.mjs';
import { escapeHtml as esc } from './mail.mjs';

const money = cents => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 });

export function landingPage({ billing = false, signup = false, pluginUrl = '', supportEmail = '', productName = PRODUCT } = {}) {
  const P = PLANS, $ = PLAN_PRICES;
  const plan = (name, price, sub, lines, cta) => `<div class="plan"><h3>${name}</h3><p class="price">${price}</p><p class="sub">${sub}</p><ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>${cta}</div>`;
  const buy = (p, label) => billing ? `<a class="btn" href="/buy/${p}">${label}</a><a class="alt" href="/buy/${p}?interval=year">or ${money($[p].year)}/year</a>` : `<span class="alt">Checkout not enabled on this server</span>`;
  const free = signup ? `<form method="post" action="/account/signup" class="signup"><input name="email" type="email" required placeholder="you@studio.com"><button class="btn">Start free</button></form>` : `<span class="alt">Ask the operator for a key</span>`;
  const install = pluginUrl ? `<a class="btn" href="${esc(pluginUrl)}">Install the Figma plugin</a>` : `<span class="btn ghost">Figma plugin — Community listing coming soon</span>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(productName)} — any web page, rebuilt as editable Figma layers</title>
<meta name="description" content="Paste a URL, get real Figma frames: editable text with the page's fonts, images, SVG, auto-sized boxes — at desktop, tablet and phone widths in one run.">
<style>
:root{--ink:#111;--muted:#666;--line:#e6e6e6;--bg:#fff;--soft:#f6f6f4;--accent:#111}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
a{color:inherit}.wrap{max-width:1040px;margin:0 auto;padding:0 24px}
nav{display:flex;align-items:center;justify-content:space-between;height:64px}nav .logo{font-weight:700;letter-spacing:-.01em;text-decoration:none}nav .links a{margin-left:22px;text-decoration:none;color:var(--muted)}nav .links a:hover{color:var(--ink)}
.hero{padding:64px 0 40px;display:grid;grid-template-columns:1.1fr 1fr;gap:48px;align-items:center}
h1{font-size:44px;line-height:1.08;letter-spacing:-.02em;margin:0 0 18px}.lead{font-size:19px;color:var(--muted);margin:0 0 26px;max-width:34em}
.cta{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.btn{display:inline-block;background:var(--accent);color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600;border:0;font-size:16px;cursor:pointer}.btn.ghost{background:var(--soft);color:var(--muted);cursor:default}
.alt{color:var(--muted);text-decoration:underline;font-size:14px}
/* illustration: a browser window becoming a layers panel */
.fig{display:grid;grid-template-columns:1fr auto 1fr;gap:14px;align-items:center}
.win{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.06)}.win .bar{height:26px;background:var(--soft);border-bottom:1px solid var(--line);display:flex;gap:6px;align-items:center;padding:0 10px}.win .bar i{width:8px;height:8px;border-radius:50%;background:#ddd;display:block}
.win .body{padding:14px;display:grid;gap:10px}.ph{background:#eceae4;border-radius:6px;height:12px}.ph.h{height:22px;width:70%}.ph.img{height:70px;background:linear-gradient(135deg,#e7e3d8,#d9d4c7)}.ph.s{width:45%}
.arrow{font-size:28px;color:#bbb}
.layers{border:1px solid var(--line);border-radius:12px;background:#fff;font:12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;padding:10px 0;box-shadow:0 12px 40px rgba(0,0,0,.06)}.layers div{padding:6px 12px;display:flex;gap:8px;align-items:center;color:#333}.layers div:before{content:"#";color:#999;width:10px}.layers .t:before{content:"T"}.layers .i:before{content:"▣"}.layers .d1{padding-left:26px}.layers .d2{padding-left:40px}
section{padding:56px 0;border-top:1px solid var(--line)}h2{font-size:28px;letter-spacing:-.015em;margin:0 0 8px}.kicker{color:var(--muted);margin:0 0 28px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}.steps div{background:var(--soft);border-radius:14px;padding:22px}.steps b{display:block;font-size:13px;color:var(--muted);margin-bottom:8px}.steps h3{margin:0 0 6px;font-size:18px}.steps p{margin:0;color:#444}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px 32px}.grid h3{font-size:16px;margin:0 0 4px}.grid p{margin:0;color:var(--muted);font-size:15px}
.plans{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.plan{border:1px solid var(--line);border-radius:16px;padding:24px;display:flex;flex-direction:column}.plan h3{margin:0;font-size:18px}.price{font-size:34px;font-weight:700;letter-spacing:-.02em;margin:10px 0 0}.sub{color:var(--muted);margin:2px 0 14px;font-size:14px}.plan ul{list-style:none;padding:0;margin:0 0 20px;color:#333;font-size:15px}.plan li{padding:5px 0;border-top:1px solid var(--line)}.plan .btn{align-self:flex-start}.plan .alt{display:block;margin-top:8px}.plan.hot{border-color:var(--ink);box-shadow:0 12px 40px rgba(0,0,0,.06)}
.signup{display:flex;gap:8px;flex-wrap:wrap}.signup input{flex:1;min-width:160px;font:15px system-ui;padding:10px 12px;border:1px solid #ccc;border-radius:10px}
.faq h3{font-size:16px;margin:22px 0 4px}.faq p{margin:0;color:#444;max-width:46em}
footer{padding:36px 0 48px;color:var(--muted);font-size:14px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px}footer a{color:var(--muted)}
@media (max-width:820px){nav .links a:first-child{display:none}.hero{grid-template-columns:1fr;padding-top:36px}h1{font-size:34px}.steps,.grid,.plans{grid-template-columns:1fr}.fig{grid-template-columns:1fr}.arrow{transform:rotate(90deg);text-align:center}}
</style></head><body>
<div class="wrap">
<nav><a class="logo" href="/">${esc(productName)}</a><span class="links"><a href="#how">How it works</a><a href="#pricing">Pricing</a><a href="/account">Sign in</a></span></nav>

<div class="hero">
  <div>
    <h1>Any web page, rebuilt as real Figma layers.</h1>
    <p class="lead">Paste a URL. Get editable frames with the page's own fonts, images, SVG and spacing — at desktop, tablet and phone widths in one run. Layers you can restyle, not a screenshot you trace over.</p>
    <div class="cta">${install}<a class="alt" href="#pricing">See pricing</a></div>
  </div>
  <div class="fig" aria-hidden="true">
    <div class="win"><div class="bar"><i></i><i></i><i></i></div><div class="body"><span class="ph h"></span><span class="ph"></span><span class="ph s"></span><span class="ph img"></span><span class="ph"></span><span class="ph s"></span></div></div>
    <div class="arrow">→</div>
    <div class="layers"><div>Page · 1440</div><div class="d1">Header</div><div class="d2 t">Nav item</div><div class="d1">Hero</div><div class="d2 t">Headline</div><div class="d2 t">Body copy</div><div class="d2 i">Product image</div><div class="d1">Footer</div></div>
  </div>
</div>

<section id="how"><h2>How it works</h2><p class="kicker">Three steps, about a minute for a typical page.</p>
<div class="steps">
  <div><b>1</b><h3>Open the plugin</h3><p>Run ${esc(productName)} in any Figma file and paste your license key once.</p></div>
  <div><b>2</b><h3>Paste a URL</h3><p>Pick the widths you want (e.g. 1440 and 390). A real browser renders the page on our servers — with a live progress bar while it works. Pages behind a login? Use the bookmarklet from your own tab instead.</p></div>
  <div><b>3</b><h3>Edit, don't trace</h3><p>Every text run is a text layer with the right font, weight and spacing; images, SVG and even video frames come through. Restyle, rearrange, ship.</p></div>
</div></section>

<section><h2>What comes through</h2><p class="kicker">Built to be compared against the page pixel by pixel — and to lose as little as possible.</p>
<div class="grid">
  <div><h3>Real text, real fonts</h3><p>Text layers with the page's font family, weight, size, letter-spacing and transforms. Missing a font? The Fonts panel downloads the page's own font files so you can install them.</p></div>
  <div><h3>Every breakpoint</h3><p>Up to four widths per import, each in its own frame. Phone widths render with mobile emulation, so you get the mobile layout, not a squeezed desktop.</p></div>
  <div><h3>Images, SVG, video</h3><p>Raster images at their displayed crop, inline SVG as vectors, video posters and frames, CSS gradients, shadows, blur and backdrop blur as effects.</p></div>
  <div><h3>Pseudo-elements and icons</h3><p>::before / ::after decorations, icon fonts and CSS-drawn shapes are captured as layers rather than dropped.</p></div>
  <div><h3>Fidelity check</h3><p>Ask for a reference screenshot and the plugin overlays it and computes a pixel diff, highlighting the areas that differ.</p></div>
  <div><h3>Private pages</h3><p>The bookmarklet runs in your logged-in browser tab and hands the capture to the plugin — nothing about the page leaves your machine except what you paste.</p></div>
</div></section>

<section id="pricing"><h2>Pricing</h2><p class="kicker">An import is one page, at as many widths as your plan allows. Cancel any time from your account page.</p>
<div class="plans">
${plan('Free', '$0', 'no card needed', [`${P.free.imports} imports a month`, `${P.free.widthsPerCapture} widths per import`, '1 import at a time', 'Bookmarklet + URL import'], free)}
${plan('Pro', money($.pro.month) + '<span style="font-size:15px;font-weight:400;color:#666">/month</span>', 'one person', ['Unlimited imports', `${P.pro.widthsPerCapture} widths per import`, `${P.pro.concurrency} imports in parallel`, 'Fonts panel + pixel diff', 'Email support'], buy('pro', 'Get Pro')).replace('class="plan"', 'class="plan hot"')}
${plan('Team', money($.team.month) + '<span style="font-size:15px;font-weight:400;color:#666">/month</span>', `up to ${P.team.keys} people`, ['Unlimited imports', `${P.team.widthsPerCapture} widths per import`, `${P.team.concurrency} imports in parallel`, `${P.team.keys} license keys, one bill`, 'Priority support'], buy('team', 'Get Team'))}
</div></section>

<section class="faq"><h2>Questions</h2>
<h3>How close to the real page is it?</h3><p>Very, on most marketing and e-commerce pages — that's what the pixel diff is for. Heavily animated or canvas-drawn pages capture their current state as images. Sites that block automated browsers may need the bookmarklet.</p>
<h3>What counts as an import?</h3><p>One page, however many widths you pick for it. Importing a page at 1440 and 390 is one import. Failed imports don't count. "Unlimited" has a fair-use ceiling (${P.pro.perDay} imports a day on Pro, ${P.team.perDay.toLocaleString('en-US')} on Team) that no designer reaches by hand — it exists to stop scrapers.</p>
<h3>Do I need the site's fonts installed?</h3><p>Figma needs a font installed to render it. The plugin substitutes the closest match and lists what was missing; the Fonts panel lets you download the page's own font files (check their licence before use).</p>
<h3>Where's my license key?</h3><p>It was shown once after checkout. Sign in at <a href="/account">/account</a> with your email to create a new one or revoke old ones — no password, we email you a link.</p>
<h3>Can I cancel or change plans?</h3><p>Any time from your account page, via Stripe's billing portal. Downgrades apply at the end of the billing period; your key keeps working on the free tier.</p>
${supportEmail ? `<h3>Something else?</h3><p>Email <a href="mailto:${esc(supportEmail)}">${esc(supportEmail)}</a>.</p>` : ''}
</section>

<footer><span>© ${new Date().getFullYear()} ${esc(productName)}</span><span><a href="/account">Account</a> · <a href="#pricing">Pricing</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a>${supportEmail ? ` · <a href="mailto:${esc(supportEmail)}">Support</a>` : ''}</span></footer>
</div>
</body></html>`;
}
