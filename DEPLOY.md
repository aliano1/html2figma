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

Response: `{ url, title, region, ms, captures: [{ viewport: [w, h], capture }] }` — each `capture` is exactly what the bookmarklet produces, plus rasterised video frames / glyphs / filtered or transformed elements as inline PNGs, `capture.fonts` (the `@font-face` files the page loaded) and optionally `capture.screenshot`.

`POST /fonts` `{ faces: capture.fonts }` → `{ files: [{ family, weight, style, name, data }] }` — the page's woff2 files decoded to installable TTF/OTF (base64). Font licences belong to the site owner.

`POST /diff` `{ reference: dataURL, candidate: dataURL, cell?: 24 }` → `{ similarity, width, height, diff, regions }` — pixel comparison of the page screenshot with an exported Figma frame; `diff` is a PNG heat-map, `regions` the worst grid cells. Body limit 80 MB.

`GET /healthz` → `{ ok, region, browser, inflight, features }`

Concurrency: `H2F_MAX_INFLIGHT` (default 2) captures per instance; over that returns 429. Each capture uses ~300–600 MB peak, so the 2 GB machine size in `fly.toml` is deliberate.

---

## Notes

- **Chrome vs Chromium.** The Dockerfile installs Google Chrome for H.264/AAC video (most MP4s). If that step fails the server falls back to the bundled Chromium, which plays only VP8/VP9/AV1 — those videos would come back as posters or blanks.
- **Bot protection.** Some sites challenge datacenter IPs (Cloudflare "verify you are human"). If a capture returns a challenge page, that site needs a residential proxy in front of the browser (`headers`/proxy support is the next step) or the bookmarklet path.
- **Auth-only pages.** Pass `cookies` copied from your browser, or use the bookmarklet, which runs in your logged-in tab.
