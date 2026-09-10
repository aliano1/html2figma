# Figma Community listing — htmlimport

Everything for the publish form, in the order Figma asks for it. Assets are in this folder.

## Assets

| Field | File | Notes |
|---|---|---|
| Icon | `icon-128.png` (also 256 / 512 for other uses) | Figma recommends 128 × 128 |
| Cover | `cover-1920x1080.png` | Figma recommends 1920 × 1080 |
| Carousel (optional, up to 9) | — | Add 2–3 real screenshots after your first public captures: a page next to its Figma import, the plugin panel mid-capture, the layers panel. Real results sell better than illustrations. |

The icon and cover are original artwork (`icon.svg`, `cover.html` are the sources — re-render with `node listing/render-icon.mjs` / `node listing/render.mjs`).

## Name

```
htmlimport
```

Figma's brand rules: no "Figma" or "Fig" inside a product name; "for Figma" after the name is fine.

## Tagline (one line)

```
Import any web page as editable Figma layers — real text, fonts, images, at every breakpoint.
```

## Description

```
Paste a URL, get the page back as real Figma layers.

htmlimport renders the page in a real browser and rebuilds it as frames you can actually edit: every text run is a text layer with the page's font family, weight, size and spacing; images come in at their displayed crop; inline SVG stays vector; gradients, shadows, blur and backdrop blur become Figma effects; ::before/::after decorations and icon fonts are captured instead of dropped.

Capture up to four widths in one run — e.g. 1440, 1024 and 390 — each in its own frame. Phone widths render with mobile emulation, so you get the mobile layout, not a squeezed desktop.

Check the result: ask for a reference screenshot and the plugin overlays it on the import and computes a pixel diff, highlighting the areas that differ.

Missing a font? The Fonts panel lists what the page used and downloads the page's own font files so you can install them (respect the font licence).

Pages behind a login, or sites that block automated browsers? The bookmarklet captures the page from your own browser tab and hands it to the plugin — nothing about the page leaves your machine except what you paste.

How it works
1. Get a license key at htmlimport.com — Free includes 5 imports a month, no card needed.
2. Run htmlimport, paste the key once.
3. Paste a URL, pick widths, click Capture. Progress is shown live; a typical page takes under a minute.

Plans: Free (5 imports a month, 2 widths), Pro ($12/month or $96/year, unlimited imports, 4 widths, one person), Team ($39/month or $390/year, unlimited imports for up to 10 people). An import is one page at any number of widths. Manage keys and billing at htmlimport.com/account.

Support: hello@htmlimport.com · Terms and privacy: htmlimport.com/terms
```

(Replace the support address with whatever `H2F_SUPPORT_EMAIL` is.)

## Category and tags

- Category: **Design tools** (secondary if allowed: Development)
- Tags: `import`, `html`, `website`, `web to figma`, `screenshot`, `responsive`, `landing page`, `redesign`, `competitor analysis`, `html to design`

## Support contact

Required. Use the same address as `H2F_SUPPORT_EMAIL`.

## Network access (the review question that matters)

The plugin talks to your server (`htmlimport.com`) and, on the bookmarklet path, loads images that live on whatever site the user is importing — so `allowedDomains` has to be `*`. Figma calls that "unrestricted network access" and asks for a reason. The manifest's `reasoning` field carries it; the same wording goes in the form if asked:

> The plugin sends the URL the user enters to the htmlimport capture service (htmlimport.com) and loads the images referenced by the page being imported; those images live on the page's own domains, which cannot be known in advance.

## Publish from a product-owned Figma account, not a personal one

The account that first publishes a plugin owns it forever (listings cannot be transferred), so publish from an account that belongs to the product:

1. **Inbox for the domain.** Cloudflare → htmlimport.com → Email → Email Routing → create `hello@htmlimport.com` → forward to a mailbox you read → verify the destination. Cloudflare adds the root-domain MX records itself (Resend's records on `mail.htmlimport.com` are unaffected). Set `H2F_SUPPORT_EMAIL=hello@htmlimport.com` in Railway.
2. **Figma account.** In a private window: figma.com → Sign up → *Continue with email* → `hello@htmlimport.com`, name `htmlimport`, unique password in a password manager, enable two-factor in Settings. Starter plan.
3. **Community profile.** Settings → Profile → handle `htmlimport`, avatar `icon-512.png`, bio "Any web page, rebuilt as editable Figma layers. Real text, fonts and images at every breakpoint.", website `https://htmlimport.com`.
4. **Desktop app.** Account menu → *Add account* → sign in as hello@htmlimport.com; switch to it, then Plugins → Development → Import plugin from manifest… → `manifest.json`. Publish from this account only — only the original publisher can update the plugin. Development can continue under any account; the repo is the source of truth.

## Publishing, step by step

1. In the Figma desktop app, open any file → **Plugins → Development → Import plugin from manifest…** → pick `manifest.json` in the repo (you did this already for the dev copy; re-import after the rename so the dev copy is called htmlimport too).
2. **Plugins → Development → htmlimport → Publish** (or right-click the plugin in the Development list → Publish).
3. On first publish Figma **assigns the plugin id** and rewrites the `"id"` in `manifest.json` from `html2figma-dev` to a long number. Commit that change: `git add manifest.json && git commit -m "figma plugin id" && git push`. Never change it again — the id *is* the listing.
4. Fill the form: name, tagline, description, icon, cover, category, tags, support contact; publish from the htmlimport account (see above — the publisher cannot be changed later). Enable comments — questions from users are the cheapest feedback you'll get.
5. Network access: Figma reads `networkAccess` from the manifest and shows "Unrestricted"; confirm the reasoning.
6. **Submit for review.** The listing shows "In review"; approval arrives by email, typically a few days. Common rejection reasons: a name that uses "Figma", a broken first-run experience (test the plugin with an empty license key — the panel must explain what to do, not just error), and network reasoning that's vague.
7. When approved, copy the Community URL (`https://www.figma.com/community/plugin/<id>/htmlimport`) into Railway as `H2F_PLUGIN_URL` — the landing page's hero button switches from "coming soon" to "Install the Figma plugin".

## Updating later

Bump `"version"`-equivalent behaviour is manual in Figma: after `npm run build`, Plugins → Development → htmlimport → **Publish new version** and add release notes. Users get the new version automatically.
