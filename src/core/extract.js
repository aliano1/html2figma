/**
 * html2figma — capture core
 *
 * Runs INSIDE a web page (bookmarklet, extension content script, or
 * Playwright `page.evaluate`) and returns a JSON-serialisable tree that the
 * Figma plugin can rebuild. No dependencies, no DOM mutation except hiding
 * elements you ask it to hide.
 *
 * Output node shape (compact keys to keep payloads small):
 *   t   tag name ('#text' for text runs, 'img', 'svg', 'video', or element tag)
 *   r   [x, y, w, h] in page coordinates (scroll-independent)
 *   s   style: bg, grad, bgi, bw[4], bc, br[4], op, sh, ov, pos, fx
 *   c   children
 *   txt / f      text run + font info {ff, fs, fw, fst, lh, ls, col, ta, tt, td}
 *   lines        number of line boxes the run occupies
 *   img / nat    image source URL + natural size; `data` filled in by inliner
 *   svg / svgColor  inline SVG markup + computed `color` (for currentColor)
 *   id / cl      element id and first classes (for layer naming)
 */
export function extract(options = {}) {
  const opts = Object.assign({
    hideSelectors: [],           // e.g. cookie banners
    root: document.body,
    maxSvgLength: 30000,
    captureVideoFrames: true,
    // Server mode: instead of approximating things the DOM can't express (cross-origin video,
    // tainted canvas, icon-font glyphs, huge SVGs), tag the element so the host can screenshot it.
    markForRaster: false,
  }, options);
  let shotSeq = 0;
  const ICON_FONT = /icon|glyph|awesome|material|star|symbol/i;
  const PUA = /[\uE000-\uF8FF]/;
  function markShot(el, node) {
    if (!opts.markForRaster) return false;
    const id = String(++shotSeq);
    el.setAttribute('data-h2f-shot', id);
    node.shot = id;
    return true;
  }

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'IFRAME', 'BR', 'WBR', 'OPTION']);
  const sx = window.scrollX, sy = window.scrollY;
  const rnd = v => Math.round(v * 100) / 100;

  for (const sel of opts.hideSelectors) {
    try { document.querySelectorAll(sel).forEach(e => { e.style.display = 'none'; }); } catch (_) { /* bad selector */ }
  }

  function rect(el) {
    const b = el.getBoundingClientRect();
    return [rnd(b.left + sx), rnd(b.top + sy), rnd(b.width), rnd(b.height)];
  }
  function color(c) {
    if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') return null;
    return c;
  }
  function textRun(node, cs) {
    const txt = node.textContent.replace(/\s+/g, ' ');
    if (!txt.trim()) return null;
    const rg = document.createRange();
    rg.selectNodeContents(node);
    const rs = rg.getClientRects();
    if (!rs.length) return null;
    const b = rg.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) return null;
    // lw: total advance of the run across all its line boxes — lets the builder match the rendered
    // width even when the site's font isn't installed in Figma (letter-spacing compensation)
    let lw = 0; for (const q of rs) lw += q.width;
    return {
      t: '#text', txt, lines: rs.length, lw: rnd(lw),
      r: [rnd(b.left + sx), rnd(b.top + sy), rnd(b.width), rnd(b.height)],
      f: {
        ff: cs.fontFamily, fs: parseFloat(cs.fontSize), fw: cs.fontWeight, fst: cs.fontStyle,
        lh: cs.lineHeight, ls: cs.letterSpacing, col: cs.color, ta: cs.textAlign,
        tt: cs.textTransform, td: cs.textDecorationLine,
        ...(cs.textShadow && cs.textShadow !== 'none' ? { tsh: cs.textShadow } : {}),
      },
    };
  }
  function videoFrame(el) {
    if (!opts.captureVideoFrames) return null;
    try {
      if (el.readyState < 2 || !el.videoWidth) return el.poster || null;
      const c = document.createElement('canvas');
      c.width = el.videoWidth; c.height = el.videoHeight;
      c.getContext('2d').drawImage(el, 0, 0);
      return c.toDataURL('image/jpeg', 0.85);
    } catch (_) { return el.poster || null; }  // cross-origin video taints the canvas
  }

  // position:fixed elements anchored to the bottom of the viewport (sticky add-to-cart bars, cookie
  // strips, chat launchers) are moved to the bottom of the page frame — where they'd sit once you've
  // scrolled to the end. Top-anchored ones (sticky headers) stay put. The offset is inherited by the subtree.
  const pageH = document.documentElement.scrollHeight, vpH = window.innerHeight;
  function fixedInfo(el, cs) {
    if (cs.position !== 'fixed') return null;
    const b = el.getBoundingClientRect();
    const bottom = (b.top + b.height / 2) > vpH / 2;
    return { bottom, dy: bottom ? Math.max(0, pageH - vpH) : 0 };
  }

  function walk(el, dy = 0) {
    if (SKIP.has(el.tagName)) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return null;
    const fi = fixedInfo(el, cs); if (fi && fi.dy) dy = fi.dy;
    const r = rect(el); r[1] = rnd(r[1] + dy);
    if (r[2] <= 0 && r[3] <= 0 && cs.overflow !== 'visible') return null;
    if (r[1] + r[3] < 0) return null;

    const n = { t: el.tagName.toLowerCase(), r };
    const s = {};
    const bg = color(cs.backgroundColor); if (bg) s.bg = bg;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      const m = cs.backgroundImage.match(/url\("?([^")]+)"?\)/);
      if (m) s.bgi = m[1];
      else if (cs.backgroundImage.includes('gradient')) {
        s.grad = cs.backgroundImage;
        // Multi-layer gradients + a non-trivial background-size are almost always scroll-edge fades
        // (e.g. <scroll-shadow>), sized/positioned by JS. Flag them so the builder can skip them.
        const layers = cs.backgroundImage.split(/\)\s*,\s*(?=(?:linear|radial|conic|repeating)-)/).length;
        if (layers > 1 || !/^(auto|cover|100% 100%|auto auto)$/.test(cs.backgroundSize)) s.gradDeco = true;
      }
    }
    const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(parseFloat);
    if (bw.some(w => w > 0) && cs.borderTopStyle !== 'none' && cs.borderTopStyle !== 'hidden') {
      s.bw = bw; s.bc = color(cs.borderTopColor) || color(cs.borderBottomColor) || color(cs.borderLeftColor);
    }
    const br = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(parseFloat);
    if (br.some(x => x > 0)) s.br = br;
    if (parseFloat(cs.opacity) < 1) s.op = parseFloat(cs.opacity);
    if (cs.boxShadow && cs.boxShadow !== 'none') s.sh = cs.boxShadow;
    // CSS filters: drop-shadow() maps onto a Figma shadow; anything else (grayscale, blur, brightness…
    // e.g. press logos in grey) can't be expressed as layer properties → rasterise (server) / bake into the image (bookmarklet).
    let filt = null;
    if (cs.filter && cs.filter !== 'none') {
      const rest = cs.filter.replace(/drop-shadow\((rgba?\([^)]*\))\s+(-?[\d.]+px)\s+(-?[\d.]+px)(?:\s+(-?[\d.]+px))?\)/g, (_, c, x, y, b) => {
        s.sh = (s.sh ? s.sh + ', ' : '') + `${c} ${x} ${y} ${b || '0px'} 0px`; return '';
      }).trim();
      if (rest) filt = rest;
    }
    // Other things Figma layers can't express. Rotation/scale/skew (translation is already in the
    // rects), clip-path, masks, blend modes, backdrop blur, text-shadow, vertical text: screenshot the
    // element as rendered instead of approximating it. Whole sections are never flattened.
    const unsupported = [];
    if (cs.transform && cs.transform !== 'none') {
      const m = cs.transform.match(/matrix\(([^)]+)\)/);
      const v = m ? m[1].split(',').map(parseFloat) : null;
      if (!v || Math.abs(v[0] - 1) > 0.01 || Math.abs(v[3] - 1) > 0.01 || Math.abs(v[1]) > 0.01 || Math.abs(v[2]) > 0.01) unsupported.push('transform');
    }
    if (cs.clipPath && cs.clipPath !== 'none') unsupported.push('clip-path');
    const mask = cs.maskImage || cs.webkitMaskImage; if (mask && mask !== 'none') unsupported.push('mask');
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') unsupported.push('mix-blend-mode');
    const bdf = cs.backdropFilter || cs.webkitBackdropFilter; if (bdf && bdf !== 'none') unsupported.push('backdrop-filter');
    if (cs.writingMode && cs.writingMode !== 'horizontal-tb') unsupported.push('writing-mode');
    if (filt) unsupported.unshift(filt);
    if (unsupported.length) {
      const isMedia = /^(IMG|svg|VIDEO|CANVAS)$/.test(el.tagName);
      const modest = r[2] * r[3] <= 800 * 800 && el.querySelectorAll('img, svg, video, canvas').length <= 4;   // don't flatten whole sections
      if (opts.markForRaster && (isMedia || modest)) { n.filt = unsupported.join(' '); n.rasterAll = true; }
      else if (filt && el.tagName === 'IMG') n.filt = filt;   // bookmarklet: inlineImages bakes CSS filters into the pixels
      else n.unsupported = unsupported;                       // bookmarklet: at least name it in the layer
    }
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') s.ov = 'hidden';
    if (cs.position === 'fixed' || cs.position === 'sticky') { s.pos = cs.position; if (fi && fi.bottom) s.fixedBottom = true; }
    if (cs.display.includes('flex')) {
      s.fx = { d: cs.flexDirection, g: [parseFloat(cs.rowGap) || 0, parseFloat(cs.columnGap) || 0], j: cs.justifyContent, a: cs.alignItems, w: cs.flexWrap,
               p: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat) };
    }

    if (n.rasterAll) { delete n.rasterAll; markShot(el, n); }   // filtered element → server screenshots it as rendered
    if (el.tagName === 'IMG') {
      n.img = el.currentSrc || el.src; n.nat = [el.naturalWidth, el.naturalHeight]; s.fit = cs.objectFit;
    } else if (el.tagName === 'VIDEO') {
      const frame = videoFrame(el);
      s.fit = cs.objectFit || 'cover';
      if (frame && frame.startsWith('data:')) n.img = frame;
      else if (!markShot(el, n)) { if (frame) n.img = frame; }
    } else if (el.tagName === 'svg') {
      n.svg = el.outerHTML.length < opts.maxSvgLength ? el.outerHTML : null;
      if (!n.svg) markShot(el, n);
      n.svgColor = cs.color;
      if (Object.keys(s).length) n.s = s;
      return n;
    } else if (el.tagName === 'CANVAS') {
      try { n.img = el.toDataURL('image/png'); } catch (_) { markShot(el, n); }
    }
    if (Object.keys(s).length) n.s = s;

    const kids = [];
    // ::before / ::after — icon-font glyphs (review stars, chevrons), decorative text, url() images.
    // Pseudo-elements have no DOM node and no rect of their own; we anchor them to the host box.
    const afterKids = [];
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      const content = ps.content;
      if (!content || content === 'none' || content === 'normal' || ps.display === 'none' || parseFloat(ps.opacity) === 0) continue;
      const urlM = content.match(/url\("?([^")]+)"?\)/);
      const pw = parseFloat(ps.width), ph = parseFloat(ps.height);
      const box = [r[0], r[1], isFinite(pw) && pw > 0 ? pw : r[2], isFinite(ph) && ph > 0 ? ph : r[3]];
      if (pseudo === '::after' && isFinite(pw) && pw > 0 && pw < r[2]) box[0] = r[0] + r[2] - pw;
      if (urlM) {
        (pseudo === '::after' ? afterKids : kids).push({ t: 'img', r: box, img: urlM[1], pseudo, s: { fit: 'contain' } });
      } else if (/^["']/.test(content)) {
        const txt = content.slice(1, -1).replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
        if (!txt.trim()) continue;
        if (opts.markForRaster && (PUA.test(txt) || ICON_FONT.test(ps.fontFamily)) && !el.textContent.trim() && el.childElementCount === 0) {
          markShot(el, n); n.glyph = true; continue;   // e.g. Judge.me star spans
        }
        const pbg = color(ps.backgroundColor);
        (pseudo === '::after' ? afterKids : kids).push({ t: '#text', txt, lines: 1, r: box, pseudo,
          f: { ff: ps.fontFamily, fs: parseFloat(ps.fontSize), fw: ps.fontWeight, fst: ps.fontStyle, lh: ps.lineHeight, ls: ps.letterSpacing,
               col: ps.color, ta: pseudo === '::after' ? 'right' : 'start', tt: ps.textTransform, td: ps.textDecorationLine },
          ...(pbg ? { s: { bg: pbg } } : {}) });
      }
    }
    const closedDetails = el.tagName === 'DETAILS' && !el.open;
    for (const ch of el.childNodes) {
      if (ch.nodeType === 3) {
        const run = textRun(ch, cs);
        if (run) {
          run.r[1] = rnd(run.r[1] + dy);
          if (opts.markForRaster && (PUA.test(run.txt) || ICON_FONT.test(cs.fontFamily)) && el.childElementCount === 0) {
            markShot(el, n); n.glyph = true; continue;   // host element becomes an image; drop the run
          }
          kids.push(run);
        }
      } else if (ch.nodeType === 1) {
        if (closedDetails && ch.tagName !== 'SUMMARY') continue;
        const k = walk(ch, dy); if (k) kids.push(k);
      }
    }
    // shadow DOM (web components)
    if (el.shadowRoot) {
      for (const ch of el.shadowRoot.childNodes) {
        if (ch.nodeType === 1) { const k = walk(ch, dy); if (k) kids.push(k); }
      }
    }
    // form controls render their value/placeholder without text nodes
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') && !kids.length) {
      const val = el.tagName === 'SELECT' ? (el.selectedOptions[0] && el.selectedOptions[0].text) : (el.value || el.placeholder);
      if (val && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'hidden') {
        const pl = parseFloat(cs.paddingLeft) || 8, pt = parseFloat(cs.paddingTop) || 0;
        kids.push({ t: '#text', txt: val, lines: 1, r: [r[0] + pl, r[1] + pt, r[2] - pl * 2, r[3] - pt * 2],
          f: { ff: cs.fontFamily, fs: parseFloat(cs.fontSize), fw: cs.fontWeight, fst: cs.fontStyle, lh: cs.lineHeight, ls: cs.letterSpacing,
               col: el.value ? cs.color : 'rgb(140, 140, 140)', ta: cs.textAlign, tt: cs.textTransform, td: 'none' } });
      }
    }
    // an ::after without an explicit width flows right after the last inline run (e.g. "See all ›")
    for (const ak of afterKids) {
      const last = [...kids].reverse().find(k => k.t === '#text');
      if (ak.t === '#text' && last && !(parseFloat(getComputedStyle(el, '::after').width) > 0)) {
        const approx = (ak.f.fs || 14) * 0.6 * ak.txt.length + (parseFloat(getComputedStyle(el, '::after').marginLeft) || 0);
        ak.r = [rnd(last.r[0] + last.r[2]), last.r[1], rnd(approx), last.r[3]]; ak.f.ta = 'start';
      }
      kids.push(ak);
    }
    if (kids.length) n.c = kids;
    if (el.id) n.id = el.id;
    const cl = (typeof el.className === 'string') ? el.className.trim().split(/\s+/).slice(0, 3).join(' ') : '';
    if (cl) n.cl = cl;
    return n;
  }

  const tree = walk(opts.root);
  if (tree && opts.root === document.body) tree.r[3] = Math.max(tree.r[3], pageH, vpH);
  return {
    v: 1,
    url: location.href,
    title: document.title,
    viewport: [window.innerWidth, window.innerHeight],
    dpr: window.devicePixelRatio,
    capturedAt: new Date().toISOString(),
    fonts: fontFaces(),
    tree,
  };
}

/**
 * The webfonts the page actually loaded: which file backs each family/weight/style. The builder uses
 * this to pick the right installed face (a site's "500" is often the foundry's Bold) and the plugin
 * offers the files for installation when the family is missing in Figma.
 */
function fontFaces() {
  const out = [];
  const loaded = new Set();
  try { for (const f of document.fonts) if (f.status === 'loaded') loaded.add((f.family + '|' + f.weight + '|' + f.style).replace(/"/g, '').toLowerCase()); } catch (_) { /* no FontFaceSet */ }
  const seen = new Set();
  for (const ss of document.styleSheets) {
    let rules; try { rules = ss.cssRules; } catch (_) { continue; }   // cross-origin sheet
    if (!rules) continue;
    for (const rule of rules) {
      if (!(rule.type === 5 /* FONT_FACE_RULE */)) continue;
      const st = rule.style;
      const family = (st.getPropertyValue('font-family') || '').replace(/^["']|["']$/g, '').trim();
      const weight = (st.getPropertyValue('font-weight') || '400').trim() || '400';
      const style = (st.getPropertyValue('font-style') || 'normal').trim() || 'normal';
      const m = (st.getPropertyValue('src') || '').match(/url\(["']?([^"')]+)["']?\)/);
      if (!family || !m) continue;
      let url = m[1]; try { url = new URL(url, ss.href || location.href).href; } catch (_) { /* keep */ }
      const key = family.toLowerCase() + '|' + weight + '|' + style;
      const isLoaded = loaded.has(key) || [...loaded].some(k => k.startsWith(family.toLowerCase() + '|') && k.endsWith('|' + style) && weightMatches(k.split('|')[1], weight));
      if (seen.has(key + url)) continue; seen.add(key + url);
      out.push({ family, weight, style, url, file: url.split('/').pop().split('?')[0], loaded: isLoaded });
    }
  }
  return out.filter(f => f.loaded);
}
function weightMatches(a, b) {
  const range = s => { const p = String(s).split(/\s+/).map(v => v === 'bold' ? 700 : v === 'normal' ? 400 : parseFloat(v)); return [p[0], p[1] ?? p[0]]; };
  const [a0, a1] = range(a), [b0, b1] = range(b);
  return a0 <= b1 && b0 <= a1;
}

/** Scroll through the page so lazy-loaded images/sections render, then return to top. */
export async function warmUp(step = 600, delay = 120) {
  const h = () => document.documentElement.scrollHeight;
  for (let y = 0; y < h(); y += step) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, delay)); }
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 800));
}

/**
 * Replace every image URL in the tree with a data: URL so the JSON is
 * self-contained. Runs in the page, so same-origin and CORS-enabled images
 * work; others are left as URLs for the plugin to try.
 */
export async function inlineImages(capture, { maxDim = 1600, quality = 0.85, onProgress } = {}) {
  const nodes = [];
  (function collect(n) {
    if (n.img && !n.img.startsWith('data:')) nodes.push([n, 'img', n.filt]);
    if (n.s && n.s.bgi && !n.s.bgi.startsWith('data:')) nodes.push([n.s, 'bgi']);
    (n.c || []).forEach(collect);
  })(capture.tree);

  const cache = new Map();
  let done = 0;
  // `filt` is a CSS filter (grayscale(1), blur(2px)…) baked into the pixels via canvas — always a raster then.
  async function toData(url, filt) {
    const key = url + '|' + (filt || '');
    if (cache.has(key)) return cache.get(key);
    const p = (async () => {
      try {
        const res = await fetch(url, { credentials: 'include' });
        const blob = await res.blob();
        if (blob.type === 'image/svg+xml' && !filt) return { data: await blob.text(), type: 'svg' };
        const bmp = blob.type === 'image/svg+xml'
          ? await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = URL.createObjectURL(blob); })
          : await createImageBitmap(blob);
        const bw = bmp.naturalWidth || bmp.width, bh = bmp.naturalHeight || bmp.height;
        const scale = Math.min(1, maxDim / Math.max(bw, bh)) * (blob.type === 'image/svg+xml' ? 2 : 1);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(bw * scale)); c.height = Math.max(1, Math.round(bh * scale));
        const ctx = c.getContext('2d');
        if (filt) ctx.filter = filt;
        ctx.drawImage(bmp, 0, 0, c.width, c.height);
        const isPng = blob.type !== 'image/jpeg' || !!filt;
        return { data: isPng ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', quality), type: 'raster' };
      } catch (_) {
        return null; // CORS-blocked; plugin will try by URL
      }
    })();
    cache.set(key, p);
    return p;
  }
  await Promise.all(nodes.map(async ([holder, key, filt]) => {
    const r = await toData(holder[key], filt);
    if (r && r.type === 'svg') { holder.svgFile = r.data; }
    else if (r) { holder[key] = r.data; }
    done++; onProgress && onProgress(done, nodes.length);
  }));
  return capture;
}
