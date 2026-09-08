/**
 * Outbound email — sign-in links and the post-purchase welcome.
 *
 * Uses Resend's HTTP API (https://resend.com — no SDK needed, free tier covers a small product):
 *   RESEND_API_KEY   re_…
 *   H2F_MAIL_FROM    "html2figma <hello@yourdomain.com>"  — a sender on a domain you verified in Resend
 *
 * Without RESEND_API_KEY nothing is sent: the message is logged instead, so the account page still
 * works in development (the sign-in link shows up in the server log).
 */
export class Mailer {
  constructor({ apiKey = process.env.RESEND_API_KEY, from = process.env.H2F_MAIL_FROM || 'html2figma <onboarding@resend.dev>', fetchImpl = globalThis.fetch, log = console } = {}) {
    this.apiKey = apiKey; this.from = from; this.fetch = fetchImpl; this.log = log;
    this.sent = [];   // last few sends, for tests and the dev log
  }
  get configured() { return !!this.apiKey; }

  /** @returns {Promise<{ delivered: boolean, id?: string }>} */
  async send({ to, subject, text, html }) {
    const msg = { from: this.from, to: [to], subject, text, html: html || `<pre style="font:15px/1.5 system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>` };
    this.sent.push({ to, subject, text, at: Date.now() }); if (this.sent.length > 50) this.sent.shift();
    if (!this.apiKey) { this.log.log(`[mail not configured] to ${to} — ${subject}\n${text}`); return { delivered: false }; }
    const r = await this.fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(msg) });
    if (!r.ok) throw new Error(`mail provider ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const { id } = await r.json();
    return { delivered: true, id };
  }
}

export const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
