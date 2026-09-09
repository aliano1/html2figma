# Deploying the capture server

One container, two hosts. Pick one; the code is identical. Both take ~10 minutes.

The server needs one secret, `H2F_API_KEY` — any long random string. Generate one:

```bash
openssl rand -hex 24
```

You'll paste the same value into the Figma plugin (From URL → Server settings).

---

## Option A — Railway (least ops)

1. Push this folder to a GitHub repo (private is fine).
2. railway.com → **New Project → Deploy from GitHub repo** → pick the repo. Railway detects the `Dockerfile` and `railway.json` automatically.
3. In the service → **Variables**, add `H2F_API_KEY` = your key.
4. **Settings → Networking → Generate Domain**. Note the URL (`https://….up.railway.app`).
5. Wait for the deploy (first build ~3–4 min: it pulls the Playwright image and installs Chrome). The health check hits `/healthz`.
6. Region: Settings → **Region** — US East (Virginia) is the right default for US-priced storefronts. To serve another region, duplicate the service and set its region; give the plugin that URL instead. Railway has no per-request region routing, so the plugin's Region dropdown is ignored here.

Verify:

```bash
curl -s https://YOUR-APP.up.railway.app/healthz
curl -s -X POST https://YOUR-APP.up.railway.app/capture \
  -H "authorization: Bearer $H2F_API_KEY" -H "content-type: application/json" \
  -d '{"url":"https://abyamc.com/products/foundation-plus-collection","widths":[1920,390]}' \
  | head -c 300
```

Cost: the Hobby plan ($5/mo) covers this comfortably at personal volume. Every push to `main` redeploys.

### Selling usage: license keys + Postgres (multi-tenant mode)

With one shared `H2F_API_KEY` everyone is the same user. To meter and sell captures, give the server a database:

1. In the Railway project: **+ New → Database → PostgreSQL**. Railway creates a `Postgres` service.
2. Open the **html2figma** service → **Variables** → **+ New Variable → Add Reference** → pick `DATABASE_URL` from the Postgres service (Railway injects the private-network URL). Redeploy.
3. `/healthz` now says `"mode":"multi-tenant"`. The schema is created automatically on start.
4. Create accounts and keys from the service **Console** tab (or locally with `railway run`):

   ```bash
   node scripts/h2f-admin.mjs account jane@studio.com pro      # plans: free (10 credits/mo), pro (300), team (1500), unlimited
   node scripts/h2f-admin.mjs key jane@studio.com "figma"      # prints h2f_live_… once — send it to the customer
   node scripts/h2f-admin.mjs usage jane@studio.com            # credits used this month + last captures
   node scripts/h2f-admin.mjs accounts                         # everyone, with this month's usage
   node scripts/h2f-admin.mjs plan jane@studio.com team        # upgrade; optional custom monthly credits as 4th arg
   node scripts/h2f-admin.mjs revoke h2f_live_…                # kill a key
   ```

   A credit is one captured width. Credits reset on the 1st (UTC). Plans also set widths per capture (free 2, others 4) and concurrent captures (free 1, pro 2, team 4). Ten capture requests per minute per key.

`H2F_API_KEY` keeps working next to the database as an unmetered admin key (handy for your own use and for scripts). The plugin's "License key" field takes either.

### Selling it: Stripe checkout + webhook

Once the database is attached, Stripe turns purchases into accounts and keys with no manual step:

1. Stripe Dashboard → **Developers → API keys → Create restricted key**. Permissions: Checkout Sessions *write*, Billing Portal *write*, Customers *read*, Subscriptions *read*, Prices *read*, Products *write* (for the setup script). Copy the `rk_…` key. (Sandbox keys work the same way for testing.)
2. Railway → html2figma → **Variables**: `STRIPE_SECRET_KEY` = that key. Optional: `H2F_PUBLIC_URL` = `https://your-domain` if you front the service with a custom domain.
3. Create the products and prices once, from the service **Console**:

   ```bash
   node scripts/stripe-setup.mjs https://your-server        # Pro $15/mo · $144/yr, Team $49/mo · $470/yr — amounts in server/billing.mjs
   ```

4. Stripe Dashboard → **Developers → Webhooks → Add endpoint**: URL `https://your-server/stripe/webhook`, events `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy the signing secret → Railway variable `STRIPE_WEBHOOK_SECRET`. Redeploy; `/healthz` lists `billing`.

The customer flow: `https://your-server/buy/pro` (or `/buy/team`, add `?interval=year`) → Stripe Checkout → back to `/welcome`, which creates the account, mints the license key and shows it **once** (only the hash is stored). The webhook keeps plans in sync afterwards: a price change moves the account between Pro and Team, an unpaid or cancelled subscription drops it to Free (the key keeps working with Free limits). Accounts on the `unlimited` plan (yours, comped customers) are never re-planned by Stripe events.

### Customer self-service: `/account` + email

Customers manage themselves at `https://your-server/account`: they enter their email, get a one-time sign-in link (valid 30 minutes, max 3 per 10 minutes, unknown addresses get the same "check your email" answer), and land on a page with their plan, this month's usage, their keys (prefix, label, created, last used), **Create new key** (shown once; up to 10 active), **Revoke**, an upgrade link and the **Billing portal** button (Stripe: card, invoices, cancel). After the first paid checkout the same address gets a welcome email with that link, so a lost key never needs you. `/portal` only works from a signed link — never from an email address alone.

Email goes out through [Resend](https://resend.com) (free tier is plenty to start):

1. Resend → **Domains → Add domain**, add the DNS records it shows for a domain you own (a subdomain like `mail.yourdomain.com` is fine), wait for "Verified".
2. Resend → **API keys → Create** (Sending access only). Railway variable `RESEND_API_KEY` = `re_…`.
3. Railway variable `H2F_MAIL_FROM` = `htmlimport <hello@mail.yourdomain.com>` (must be on the verified domain). The sending subdomain has no inbox, so also set `H2F_SUPPORT_EMAIL` to an address you read — it becomes the Reply-To (override with `H2F_MAIL_REPLY_TO`) and appears on the landing page. Optional `H2F_SECRET` = any long random string used to sign the links (otherwise one is derived from your other secrets — set it explicitly before running more than one service that must agree).

Until `RESEND_API_KEY` is set nothing is sent: links are printed in the server log instead, which is enough for development. `/healthz` lists `email` once mail is configured.

### The landing page: `/`

In multi-tenant mode the server's root is a complete marketing page — what the product does, how it works, pricing (numbers come from `server/billing.mjs` and `server/db.mjs`, so they can't drift from what's charged and enforced), a **Start free** form that creates a Free account and emails the sign-in link (`POST /account/signup`, 10 per hour per IP), the Pro/Team checkout buttons, and a FAQ. `/install` serves the bookmarklet page from `dist/`. Point your domain at the service (Railway → Settings → Networking → Custom Domain) and set `H2F_PUBLIC_URL` to it.

`/terms` and `/privacy` are generated pages (`server/legal.mjs`); set `H2F_LEGAL_NAME` (the entity customers contract with) and `H2F_LEGAL_COUNTRY` (governing law; default Switzerland) once the business entity is decided, and have a lawyer read them before relying on them. Put the same two URLs into Stripe → Settings → Business → Public details.

Optional variables: `H2F_PRODUCT_NAME` (the customer-facing name on every page, email and Stripe product — default `htmlimport`; re-run `stripe-setup.mjs` after changing it so the Stripe products are renamed), `H2F_PLUGIN_URL` (the Figma Community URL once the plugin is published — until then the hero says "coming soon"), `H2F_SUPPORT_EMAIL` (shown in the footer and FAQ).

With a merchant-of-record setup (Stripe Managed Payments, when enabled on your account) tax is handled by Stripe; on a standard account add Stripe Tax to the Checkout Session (`automatic_tax: { enabled: true }` in `server/billing.mjs`) once you've registered where required.

What the server enforces once strangers hold keys: only public http(s) hosts are captured (private ranges, localhost, cloud metadata addresses and non-standard ports are refused, and every request the page makes — including redirects and iframes — is checked again inside the browser), captures over `H2F_MAX_CAPTURE_MB` (default 60) are rejected, and the job queue lives in Postgres so several replicas can share it.

---

## Option B — Fly.io (regions)

Requires the `flyctl` CLI: `brew install flyctl` then `fly auth signup` / `fly auth login`.

```bash
# from the project folder
fly launch --copy-config --no-deploy      # uses fly.toml; pick a unique app name when asked
fly secrets set H2F_API_KEY=your-key
fly deploy                                # first build ~4 min
fly scale count 1 --region iad,ams        # one machine in US East and one in Amsterdam (add more later)
fly status                                # shows machines + regions
```

Your URL is `https://<app-name>.fly.dev`. Verify the same way as above; add `"region":"ams"` to the JSON body to route a capture to Amsterdam — the server replays the request there via `fly-replay`. The plugin's Region dropdown sends this for you. Only regions where you've scaled a machine will work; the list of region codes is `fly platform regions`.

Machines stop when idle (`auto_stop_machines`) and start on the first request, so the first capture after a quiet period takes ~5 s longer. Idle cost is near zero; expect a few dollars a month in use.

Redeploy after code changes with `fly deploy`. Logs: `fly logs`.

---

## Running it locally (dev)

```bash
npm install && npm run build
H2F_ALLOW_ANON=1 npm start                 # http://localhost:8080, no auth
# or with a specific browser binary:
CHROME=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome H2F_ALLOW_ANON=1 npm start
```

Point the plugin's Server URL at `http://localhost:8080`. (Figma desktop allows localhost for development plugins.)

---

## API

`POST /capture`

| field | type | notes |
|---|---|---|
| `url` | string | required, http(s) |
| `widths` | number[] | default `[1920]`, max 4, each 320–3840. Widths < 768 use mobile emulation (touch, iPhone UA) |
| `region` | string | Fly region code; ignored elsewhere |
| `hideSelectors` | string[] | extra CSS selectors to hide (cookie banners etc. are hidden by default) |
| `waitFor` | string | CSS selector to wait for before capturing |
| `timeoutMs` | number | page load timeout, default 45000, max 120000 |
| `locale`, `timezone` | string | browser locale / IANA tz |
| `cookies` | Playwright cookie[] | for logged-in captures |
| `headers` | object | extra request headers |
| `screenshot` | boolean | also return a full-page JPEG of each viewport in `capture.screenshot` (the plugin's reference/diff features need it) |
| `async` | boolean | answer `202 { jobId }` immediately; poll `GET /jobs/:id` → `{ status, stage, message, progress, widthIndex, elapsedMs, position? }` and, once `status` is `done`, `result` (delivered once). `DELETE /jobs/:id` cancels (a queued job is dropped; a running one stops at the next width). The plugin uses this for live progress, queue position and the Cancel button, and cancels a job when its panel is closed. |

Response: `{ url, title, region, ms, captures: [{ viewport: [w, h], capture }] }` — each `capture` is exactly what the bookmarklet produces, plus rasterised video frames / glyphs / filtered or transformed elements as inline PNGs, `capture.fonts` (the `@font-face` files the page loaded) and optionally `capture.screenshot`.

`POST /fonts` `{ faces: capture.fonts }` → `{ files: [{ family, weight, style, name, data }] }` — the page's woff2 files decoded to installable TTF/OTF (base64). Font licences belong to the site owner.

`POST /diff` `{ reference: dataURL, candidate: dataURL, cell?: 24 }` → `{ similarity, width, height, diff, regions }` — pixel comparison of the page screenshot with an exported Figma frame; `diff` is a PNG heat-map, `regions` the worst grid cells. Body limit 80 MB.

`GET /me` → `{ email, plan, credits, used, remaining, resetsAt }` for a license key (`plan: "admin"` and null credits for the shared key).

`GET /healthz` → `{ ok, region, browser, inflight, mode, features }`

Errors you'll see in multi-tenant mode: `401` invalid/revoked key, `402` out of credits (body includes `quota`), `429` a capture is already running / too many per minute, `400` URL refused by the safety checks.

Concurrency: `H2F_MAX_INFLIGHT` (default 2) captures per instance; over that returns 429. Each capture uses ~300–600 MB peak, so the 2 GB machine size in `fly.toml` is deliberate.

---

## Notes

- **Chrome vs Chromium.** The Dockerfile installs Google Chrome for H.264/AAC video (most MP4s). If that step fails the server falls back to the bundled Chromium, which plays only VP8/VP9/AV1 — those videos would come back as posters or blanks.
- **Bot protection.** Some sites challenge datacenter IPs (Cloudflare "verify you are human"). If a capture returns a challenge page, that site needs a residential proxy in front of the browser (`headers`/proxy support is the next step) or the bookmarklet path.
- **Auth-only pages.** Pass `cookies` copied from your browser, or use the bookmarklet, which runs in your logged-in tab.
