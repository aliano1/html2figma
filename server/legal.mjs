/**
 * /terms and /privacy — plain-language legal pages generated from the same facts the server runs on.
 *
 * Env: H2F_LEGAL_NAME     who the customer contracts with ("Pixelpox LLC", "Ali Harris, sole proprietor") — default: the product name
 *      H2F_LEGAL_COUNTRY  governing law / seat ("Switzerland", "United States (Delaware)") — default Switzerland
 *      H2F_SUPPORT_EMAIL  contact for questions and data requests
 *
 * This is a reasonable starting point for a small SaaS, not legal advice: have a lawyer read it before
 * you rely on it, especially the liability and refund sections and anything your jurisdiction mandates.
 */
import { PRODUCT } from './brand.mjs';
import { page } from './billing.mjs';
import { escapeHtml as esc } from './mail.mjs';
import { PLANS } from './db.mjs';

const cfg = () => ({
  name: process.env.H2F_LEGAL_NAME || PRODUCT,
  country: process.env.H2F_LEGAL_COUNTRY || 'Switzerland',
  email: process.env.H2F_SUPPORT_EMAIL || '',
  updated: process.env.H2F_LEGAL_UPDATED || '2026-09-09',
});
const contact = c => c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : 'the support address on the website';
const wrap = (title, c, body) => page(`${title} — ${PRODUCT}`, `<style>h2{font-size:18px;margin:26px 0 6px}p,li{color:#333}p.muted{font-size:14px}nav a{margin-right:14px}</style>
<nav><a href="/">${esc(PRODUCT)}</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/account">Account</a></nav>
<h1>${esc(title)}</h1><p class="muted">Last updated ${esc(c.updated)} · ${esc(c.name)} · ${esc(c.country)}</p>
${body}`);

export function termsPage() {
  const c = cfg(); const P = PLANS;
  return wrap('Terms of Service', c, `
<p>These terms govern your use of ${esc(PRODUCT)} — the Figma plugin, the bookmarklet, the capture service at htmlimport.com and the account pages (together, "the Service"), operated by ${esc(c.name)} ("we"). By creating an account or using a license key you agree to them.</p>

<h2>1. What the Service does</h2>
<p>You give the Service the address of a web page (or a capture made by the bookmarklet in your own browser). The Service renders the page and returns a description of its layout, text, images and styles that the plugin rebuilds as editable layers in your Figma file.</p>

<h2>2. Your account and keys</h2>
<p>An account is identified by an email address; sign-in is by one-time links sent to that address. License keys are shown once and stored only as a hash. You are responsible for keeping keys private; anything done with a key counts against your account. You can create and revoke keys at any time from your account page. One person per account on Free and Pro; a Team plan may be shared within one company, one key per person.</p>

<h2>3. Plans, imports and billing</h2>
<p>An import is one captured page, at any number of widths your plan allows. Failed imports are not counted. The Free plan includes ${P.free.imports} imports per calendar month (UTC), not carried over. Pro and Team include unlimited imports for normal design work, subject to a fair-use ceiling of ${P.pro.perDay} imports per day (Pro) and ${P.team.perDay.toLocaleString('en-US')} per day (Team) and to the rate and concurrency limits shown on the pricing page; automated bulk crawling is not a permitted use. Pro is for one person (${P.pro.keys} keys); Team may be shared by up to ${P.team.keys} people within one company (${P.team.keys} keys).</p>
<p>Paid plans are subscriptions billed in advance, monthly or yearly, through Stripe, who handles your card details — we never see them. Prices are in US dollars and exclude any taxes that apply to you unless the checkout page says otherwise. You can cancel at any time from the billing portal; the plan stays active until the end of the period already paid for and then drops to Free, and your keys keep working with Free limits. Except where the law requires it, payments are not refunded for partial periods. If a payment fails and is not resolved, the account drops to Free.</p>
<p>We may change prices or plan limits; changes apply from your next billing period and we will email you beforehand.</p>

<h2>4. Acceptable use</h2>
<p>Use the Service only on pages you are entitled to capture. Websites and their content belong to their owners; capturing a page for reference, redesign, prototyping or analysis is your responsibility to keep within the site's terms and applicable copyright law. Do not use the Service to reproduce a site you have no rights to and pass it off as your own, to bypass paywalls or access controls, to capture pages that contain other people's personal data in bulk, or to probe systems that are not public. Do not attempt to overload the Service, reverse-engineer the plugin beyond what the law permits, or resell captures as a service.</p>
<p>The Service refuses private-network and non-public addresses by design.</p>

<h2>5. Your content and ours</h2>
<p>Whatever the plugin creates in your Figma file is yours to use, subject to the rights of the original site's owner in the underlying content. The Service itself — the plugin, the bookmarklet, the server software and the website — is ours; you get a personal, non-exclusive, non-transferable right to use it while you have an account.</p>

<h2>6. Availability and changes</h2>
<p>We aim to keep the Service up but do not guarantee uninterrupted availability. We may change or discontinue features, and may discontinue the Service as a whole with at least 30 days' notice by email, refunding any prepaid period beyond the shutdown date.</p>

<h2>7. Fonts and third-party material</h2>
<p>The Fonts panel lets you download font files that the captured page served to your browser. Font licences vary; whether you may install or use those files is between you and the font's licensor, and we make no representation about it.</p>

<h2>8. Disclaimer and liability</h2>
<p>The Service is provided "as is". Captures are approximations of a rendered page and may differ from it. To the fullest extent permitted by law, we exclude all warranties, and our total liability to you for any claim relating to the Service is limited to the amount you paid us in the twelve months before the claim. We are not liable for indirect or consequential losses, or for claims arising from how you use captured content. Nothing here limits liability that cannot be limited by law.</p>

<h2>9. Termination</h2>
<p>You can delete your account by emailing ${contact(c)}. We may suspend or close accounts that breach these terms, with a refund of any unused prepaid period unless the breach was serious.</p>

<h2>10. Governing law</h2>
<p>These terms are governed by the laws of ${esc(c.country)}, and disputes go to its courts, without prejudice to mandatory consumer-protection rules where you live.</p>

<h2>11. Changes to these terms</h2>
<p>We may update these terms; material changes are announced by email or on the website at least 14 days before they take effect. Continued use after that means you accept them.</p>

<p>Questions: ${contact(c)}.</p>`);
}

export function privacyPage() {
  const c = cfg();
  return wrap('Privacy Policy', c, `
<p>This explains what ${esc(PRODUCT)} (operated by ${esc(c.name)}) collects, why, and what happens to it. Short version: we keep the minimum needed to run accounts and billing, we do not track you across the web, and page captures are processed and then discarded.</p>

<h2>What we collect</h2>
<p><b>Account data.</b> Your email address; for paid plans, the Stripe customer and subscription identifiers. We never see or store card numbers — Stripe does.</p>
<p><b>License keys.</b> Only a cryptographic hash of each key, its first characters, an optional label you give it, and when it was created, last used and revoked.</p>
<p><b>Usage records.</b> For each capture: the URL you captured, the widths, how long it took, whether it succeeded, and a timestamp. This is what your monthly credits are metered from and what you see on your account page.</p>
<p><b>Captures.</b> The rendered page — its layout, text, images and styles — is held on the server only while the job runs and for up to 15 minutes afterwards so the plugin can fetch the result; then it is deleted. Reference screenshots and pixel diffs are handled the same way. Bookmarklet captures are made in your own browser and are never uploaded unless you paste them into the plugin, which sends nothing to us.</p>
<p><b>Sign-in links.</b> One-time links are signed tokens containing your email and an expiry; we keep a short-lived, in-memory count of requests per address to limit abuse.</p>
<p><b>Server logs.</b> Standard request logs (time, path, status, IP address, user agent) kept by our hosting provider for a limited period for security and debugging.</p>
<p>No advertising trackers, no analytics cookies, no fingerprinting. The website sets no cookies at all.</p>

<h2>Why (legal bases)</h2>
<p>To provide the Service you asked for (contract): accounts, keys, metering, billing, sign-in emails. To keep the Service secure and prevent abuse (legitimate interest): logs, rate limits, the private-network block. To send you the emails the Service needs — sign-in links, receipts, notices about changes — which are not marketing.</p>

<h2>Who else sees it</h2>
<p>Processors that run parts of the Service: <b>Railway</b> (hosting and database, United States), <b>Stripe</b> (payments), <b>Resend</b> (transactional email), <b>Cloudflare</b> (DNS). Each processes data only to provide its service to us. Web pages you capture are fetched from their own servers, which see a request from our infrastructure, not from you. We do not sell or share personal data for advertising.</p>

<h2>How long</h2>
<p>Account, key and usage data: for as long as you have an account, then deleted within 30 days of a deletion request (invoices are kept as long as tax law requires). Captures: minutes, as described above. Logs: the hosting provider's retention window, typically days to weeks.</p>

<h2>Your rights</h2>
<p>You can ask for a copy of your data, correct it, or have your account and data deleted by emailing ${contact(c)}. Under the Swiss Federal Act on Data Protection and, where it applies to you, the GDPR or similar laws, you also have rights to object to or restrict certain processing and to complain to your local data-protection authority. We answer within 30 days.</p>

<h2>International transfers</h2>
<p>Our servers are in the United States. Where data moves from Switzerland, the EU or the UK, the processors above rely on recognised safeguards (standard contractual clauses or equivalent). Ask us if you want details.</p>

<h2>Security</h2>
<p>Keys are stored hashed; secrets are held in the hosting environment, not in code; all traffic is encrypted in transit. No system is perfectly secure, and if a breach affects you we will tell you without undue delay.</p>

<h2>Children</h2>
<p>The Service is for professionals and is not directed at children under 16.</p>

<h2>Changes</h2>
<p>We will post changes here and, for material ones, email account holders. Contact: ${contact(c)}.</p>`);
}
