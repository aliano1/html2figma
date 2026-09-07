# html2figma

Capture any rendered web page and rebuild it as fully editable Figma layers — the same idea as html.to.design, running entirely on your machine.

Three parts, one shared core:

```
src/core/extract.js      the capture engine — runs inside a web page, returns a JSON tree
src/bookmarklet/entry.js one-click UI that runs the engine in whatever tab you're viewing (free/offline path)
server/index.mjs         capture server — runs the engine in a real Chromium (Playwright), any viewport,
                         any region, and screenshots what the DOM can't express (video, icon fonts, canvas)
src/plugin/builder.ts    turns the JSON into Figma nodes (frames, text, images, vectors)
src/plugin/code.ts       plugin entry: "From URL" (calls the server) and "Paste capture" (bookmarklet)
src/plugin/ui.html       plugin panel
```

Two ways to capture:

- **From URL** (plugin → server): enter your license key, type a URL, tick 1920 / 390 / custom, click. The server renders in a real browser, so you get video frames, icon-font glyphs, the page's fonts and a reference screenshot back. See **DEPLOY.md** to host it on Railway or Fly.io — single-tenant with one shared key, or multi-tenant with license keys, monthly credits and usage metering (Postgres).
- **Bookmarklet** (your browser → plugin): captures exactly what you see — your login, your region, dismissed popups. No server, nothing leaves your machine. Can't grab cross-origin video frames or resize the viewport for you.

## Setup (once)

```bash
npm install
npm run build          # → dist/code.js, dist/ui.html, dist/bookmarklet.txt, dist/install.html
```

**Bookmarklet:** open `dist/install.html` in your browser and drag the button to your bookmarks bar.

**Figma plugin:** in the Figma desktop app → Plugins → Development → *Import plugin from manifest…* → pick `manifest.json` in this folder. It appears under Plugins → Development → html2figma.

## Use — From URL

Deploy the server (DEPLOY.md), then in the plugin: **From URL** → Server settings → paste server URL + API key (saved for next time) → enter the page URL, tick widths, Capture & build. Multiple widths land side by side in one section.

## Use — Bookmarklet

1. Open the page you want. Set the viewport you want (resize the window, or use DevTools device mode for mobile).
2. Click the **html2figma** bookmark → **Capture page**. It scrolls the page once to trigger lazy content, reads the DOM, inlines images, and reports the size.
3. **Copy JSON** (or **Download .json** for big pages).
4. In Figma, run the plugin, paste (or open the file), **Build in Figma**. A ~800-layer product page builds in a few seconds and lands to the right of your existing content.

Repeat step 1–4 per viewport (e.g. 1920 and 390).

### Options in the plugin

- **Reference screenshot** (server captures) — the page's full-page screenshot is placed next to the build, and a hidden 50 % overlay is dropped inside the build frame: toggle its visibility to eyeball differences.
- **Fidelity score + diff map** (server captures) — the build is exported and compared pixel-wise with the screenshot; you get a `% match` in the layer name and a red heat-map of what differs. Use it to find the remaining gaps instead of hunting by eye.
- **Match text widths when a font is missing** — see *Fonts* below.
- **Fallback font** — used when the site's font isn't installed in Figma (default Inter).
- **Font map** — `Komet=Inter, Helvetica Neue=Helvetica`. If you have the real font installed, leave it blank and the site font is used directly.

## Fonts — what happens when the site's font isn't on your machine

Figma can only typeset with fonts installed locally (html.to.design has exactly the same constraint). Three things make that a non-issue in practice:

1. **The right face when the font *is* installed.** The capture records which file the page loaded for each family/weight (`Komet 500` → `KometBold.woff2`), so the builder picks *Komet Bold*, not a guessed "Medium".
2. **Layout-exact fallback when it isn't.** Every text run's rendered width is captured; when Figma substitutes a family, the builder adjusts letter-spacing (within ±8 % of the size) so each line keeps its on-page width. Wraps, centring and neighbours stay where they were — the glyphs differ, the layout doesn't.
3. **Get the font in one click.** After a build the plugin lists every family on the page, flags the ones that were substituted, and offers the page's own webfont files converted to installable TTF/OTF (server does the woff2 decoding). Install, restart Figma, build again → tier 1. Webfonts are licensed by the site owner; the plugin says so next to the button.

## What gets captured

| Web | Figma |
|---|---|
| Block element | Frame, absolute-positioned, with fill / gradient / border / radius / shadow / opacity / clipping |
| Text run | Text layer with family, weight, size, line-height, letter-spacing, colour, alignment, underline, uppercase, text-shadow; width-matched when the font is substituted |
| Paragraph with inline bold/links | One text layer with per-range styling |
| `<img>`, CSS `background-image`, `<canvas>` | Rectangle with image fill (FILL for `cover`, FIT for `contain`) |
| `<video>` | Rectangle with the current frame (server: any video; bookmarklet: same-origin only, else poster) |
| Inline `<svg>` | Editable vector (via `createNodeFromSvg`), `currentColor` resolved |
| Icon-font glyphs (private-use chars) | Server: pixel-exact screenshot of the glyph. Bookmarklet: star shapes, one per glyph |
| CSS filter / transform / clip-path / mask / blend mode | Server: screenshot of the element as rendered (image layer). Bookmarklet: filters on `<img>` baked in via canvas |
| `@font-face` files the page loaded | `capture.fonts` — used for face-aware weights and the *Download fonts* button |
| `::before` / `::after` pseudo-elements | Text or image, anchored to the host box (review stars, chevrons, decorative icons) |
| Closed `<details>` | Only the summary |
| Shadow DOM | Walked like normal children |
| `.sr-only`, skip links, cookie banners | Dropped |

Layer names follow the tag and first class (`div · product-gallery`), and the root frame carries the source URL, viewport and timestamp in shared plugin data.

## Limits (honest list)

- **Positioning is absolute**, not auto-layout. Flex metadata (`s.fx`) is captured on every flex container, so converting to auto-layout is a builder-side change — see roadmap.
- **Fonts** must exist in Figma for glyph-exact text — see *Fonts* above for what happens otherwise (width-matched fallback, one-click download of the page's webfonts).
- **Cross-origin images without CORS** can't be inlined by the bookmarklet; they're left as URLs and the plugin fetches them itself (needs network access, which the manifest allows).
- **Bookmarklet + cross-origin `<video>`**: can't be frame-grabbed (canvas taint); you get the poster or a placeholder. The server path screenshots it instead.
- **Bookmarklet on strict-CSP sites**: some sites block `javascript:` URLs via CSP. Paste the contents of `dist/bookmarklet.js` into the DevTools console instead — identical result.
- **Very large pages** (>8 MB JSON) — use Download rather than Copy.
- **Things Figma layers can't express are screenshotted, not approximated** (server path): CSS `filter` (except `drop-shadow()` → shadow effect, `blur()` → layer blur, `opacity()` → layer opacity, and identity values like `brightness(1)`, which are ignored), rotation/scale/skew transforms, `clip-path`, masks, `mix-blend-mode`, vertical writing modes. `backdrop-filter: blur()` becomes a Figma background blur. The element comes back as an image layer named after the property — but anything containing text is only flattened for geometric cases (transform, clip-path, mask); a tinted card keeps its editable layers and is named with the filter it lost. Whole sections are never flattened (limit ≈ 800×800 px / 4 media children). `text-shadow` maps onto a text effect. The bookmarklet path names such layers with a ⚠ instead.

## Roadmap

1. **Auto-layout** — map `display:flex` + gap + padding + justify/align onto Figma auto-layout when children are laid out along one axis. The data is already in the capture.
2. **Batch endpoint** — `POST /capture` already takes multiple widths; a `urls[]` variant with a job queue is the next step for bulk imports.
3. **Chrome extension** wrapper around the bookmarklet (toolbar button, no CSP issues, direct messaging to the plugin via clipboard or a local relay).
4. Component detection: repeated subtrees (product cards, nav items) → component + instances.

## Development

```bash
npm run watch        # rebuild on change; reload the plugin in Figma (Plugins → Development → Reload)
npm run typecheck
npm test             # 1) captures test/page.html in headless Chromium via the bookmarklet → test/capture.json
                     # 2) runs the real builder on a mock Figma API (test/mock-figma.mjs) and asserts on the node tree
                     #    set CHROME=/path/to/chrome if Playwright's own browser isn't installed
node test/server.test.mjs   # boots the capture server locally, captures the test page at 1280 + 390,
                            # checks cross-origin video + icon-font stars were rasterised
```

`test/bundle-builder.mjs` bundles the builder plus a capture into a single script you can paste into any Plugin API host (e.g. Figma's MCP `use_figma`) to test the builder without installing the plugin.
