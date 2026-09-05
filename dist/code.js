"use strict";
(() => {
  // src/plugin/builder.ts
  var WEIGHTS = { "100": "Thin", "200": "Extra Light", "300": "Light", "400": "Regular", "500": "Medium", "600": "Semi Bold", "700": "Bold", "800": "Extra Bold", "900": "Black", normal: "Regular", bold: "Bold" };
  var INLINE = /* @__PURE__ */ new Set(["strong", "b", "em", "i", "a", "span", "u", "small", "sup", "sub", "mark", "abbr", "time", "label"]);
  var DROP_CLASS = ["sr-only", "visually-hidden", "skip-to-content"];
  var PUA_RE = new RegExp("^[\\uE000-\\uF8FF\\s]+$");
  function parseColor(c) {
    if (!c) return null;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].replace("/", ",").split(",").map(parseFloat);
    return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p.length > 3 ? p[3] : 1 };
  }
  var solid = (c) => ({ type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a });
  function parseShadow(s) {
    const out = [];
    for (const part of s.split(/(?<=\))\s*,\s*(?=rgb)/)) {
      const m = part.trim().match(/(rgba?\([^)]+\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?(?:\s+(-?[\d.]+)px)?(\s+inset)?/);
      if (!m) continue;
      const col = parseColor(m[1]);
      if (!col || col.a === 0) continue;
      out.push({ type: m[6] ? "INNER_SHADOW" : "DROP_SHADOW", color: col, offset: { x: +m[2], y: +m[3] }, radius: +(m[4] || 0), spread: +(m[5] || 0), visible: true, blendMode: "NORMAL" });
    }
    return out;
  }
  function parseGradient(g) {
    const stops = (g.match(/rgba?\([^)]+\)/g) || []).map(parseColor).filter(Boolean);
    if (stops.length < 2) return null;
    const m = g.match(/linear-gradient\(\s*(?:(\d+(?:\.\d+)?)deg|to (top|bottom|left|right))/);
    let deg = 180;
    if (m) deg = m[1] ? parseFloat(m[1]) : { top: 0, bottom: 180, left: 270, right: 90 }[m[2]];
    const rad = (deg - 90) * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const cx = 0.5, cy = 0.5, half = 0.5 * (Math.abs(cos) + Math.abs(sin));
    const x0 = cx - cos * half, y0 = cy - sin * half, x1 = cx + cos * half, y1 = cy + sin * half;
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1;
    return {
      type: "GRADIENT_LINEAR",
      gradientTransform: [[dx / len2, dy / len2, -(x0 * dx + y0 * dy) / len2], [-dy / len2, dx / len2, (x0 * dy - y0 * dx) / len2]],
      gradientStops: stops.map((c, i) => ({ position: i / (stops.length - 1), color: c }))
    };
  }
  var px = (v) => v && v.endsWith("px") ? parseFloat(v) : null;
  function hasStyle(n) {
    const s = n.s || {};
    return ["bg", "bgi", "grad", "bw", "br", "sh", "op"].some((k) => k in s) || s.ov === "hidden";
  }
  function prune(n, drop) {
    if (n.t === "#text") return n.txt && n.txt.trim() ? n : null;
    const key = (n.cl || "") + " " + (n.id || "");
    if (drop.some((d) => key.includes(d))) return null;
    const kids = (n.c || []).map((k) => prune(k, drop)).filter(Boolean);
    n.c = kids;
    const [, , w, h] = n.r;
    if (n.t === "img" || n.t === "svg" || n.img) return w > 0 && h > 0 ? n : null;
    if ((w <= 0 || h <= 0) && !kids.length) return null;
    if (!kids.length && !hasStyle(n)) return null;
    return n;
  }
  function collapse(n) {
    if (n.t === "#text" || n.t === "img" || n.t === "svg" || n.img) return n;
    n.c = (n.c || []).map(collapse);
    while (n.c && n.c.length === 1 && !hasStyle(n) && n.t !== "body") {
      const child = n.c[0];
      if (child.t === "#text" || child.t === "img" || child.t === "svg" || child.img) break;
      child.nm = n.nm || n.id || (n.cl || "").split(" ")[0] || n.t;
      n = child;
    }
    return n;
  }
  function nameOf(n) {
    if (n.t === "#text") return (n.txt || "").trim().slice(0, 40);
    if (n.img) return n.t === "video" ? "video frame" : n.glyph ? "glyph (raster)" : n.pseudo ? "pseudo image" : "image";
    if (n.t === "svg") return "icon";
    const nm = n.nm || n.id || (n.cl || "").split(" ")[0];
    const base = nm && nm !== n.t ? `${n.t} \xB7 ${nm}`.slice(0, 60) : n.t;
    return n.s && n.s.pos === "fixed" ? `${base} (fixed${n.s.fixedBottom ? ", bottom" : ""})` : base;
  }
  function inlineRuns(n) {
    const out = [];
    for (const k of n.c || []) {
      if (k.t === "#text") out.push(k);
      else if (INLINE.has(k.t) && !["bg", "bw", "bgi", "grad", "sh"].some((x) => k.s && x in k.s)) {
        const r = inlineRuns(k);
        if (!r) return null;
        out.push(...r);
      } else return null;
    }
    return out;
  }
  var overlaps = (a, b) => {
    const [ax, ay, aw, ah] = a.r, [bx, by, bw, bh] = b.r;
    return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
  };
  var FontResolver = class {
    constructor(fallback, map) {
      this.fallback = fallback;
      this.map = map;
      this.cache = /* @__PURE__ */ new Map();
      this.available = null;
    }
    async resolve(cssFamily, weight, italic) {
      let style = WEIGHTS[String(weight)] || "Regular";
      if (italic) style = style === "Regular" ? "Italic" : style + " Italic";
      const key = cssFamily + "|" + style;
      if (this.cache.has(key)) return this.cache.get(key);
      if (!this.available) {
        const fonts = await figma.listAvailableFontsAsync();
        this.available = new Set(fonts.map((f) => f.fontName.family + "|" + f.fontName.style));
      }
      const families = cssFamily.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "")).filter((f) => f && !/^(sans-serif|serif|monospace|system-ui|-apple-system|BlinkMacSystemFont|cursive)$/i.test(f));
      const candidates = [...families.map((f) => this.map[f] || f), this.fallback, "Inter"];
      const styleAlts = [style, style.replace(" Italic", ""), "Regular"];
      for (const fam of candidates) for (const st of styleAlts) {
        if (this.available.has(fam + "|" + st)) {
          const fn2 = { family: fam, style: st };
          try {
            await figma.loadFontAsync(fn2);
            this.cache.set(key, fn2);
            return fn2;
          } catch (_) {
          }
        }
      }
      const fn = { family: "Inter", style: "Regular" };
      await figma.loadFontAsync(fn);
      this.cache.set(key, fn);
      return fn;
    }
  };
  var ImageStore = class {
    constructor(fetchImage2) {
      this.fetchImage = fetchImage2;
      this.cache = /* @__PURE__ */ new Map();
    }
    async hash(src) {
      if (this.cache.has(src)) return this.cache.get(src);
      let bytes = null;
      try {
        if (src.startsWith("data:")) {
          const b64 = src.slice(src.indexOf(",") + 1);
          bytes = figma.base64Decode(b64);
        } else if (this.fetchImage) {
          bytes = await this.fetchImage(src);
        }
      } catch (_) {
        bytes = null;
      }
      let h = null;
      if (bytes) {
        try {
          h = figma.createImage(bytes).hash;
        } catch (_) {
          h = null;
        }
      }
      this.cache.set(src, h);
      return h;
    }
  };
  async function build(cap, opts = {}) {
    const fonts = new FontResolver(opts.fallbackFont || "Inter", opts.fontMap || {});
    const images = new ImageStore(opts.fetchImage);
    const drop = [...DROP_CLASS, ...opts.hideSelectors || []];
    let tree = prune(JSON.parse(JSON.stringify(cap.tree)), drop);
    if (!tree) throw new Error("Nothing to build after pruning");
    tree = collapse(tree);
    let total = 0;
    (function count(n) {
      total++;
      (n.c || []).forEach(count);
    })(tree);
    let done = 0;
    const tick = () => {
      done++;
      if (opts.onProgress && (done % 10 === 0 || done === total)) opts.onProgress(done, total);
    };
    const padOf = /* @__PURE__ */ new WeakMap();
    let prevRight;
    const decorate = (n, s) => {
      if (!s) return;
      if (s.op !== void 0 && "opacity" in n) n.opacity = s.op;
      if (s.br && "topLeftRadius" in n) {
        const g = n;
        g.topLeftRadius = s.br[0];
        g.topRightRadius = s.br[1];
        g.bottomRightRadius = s.br[2];
        g.bottomLeftRadius = s.br[3];
      }
      if (s.bw && s.bc && "strokes" in n) {
        const g = n;
        const col = parseColor(s.bc);
        if (col) {
          g.strokes = [solid(col)];
          g.strokeAlign = "INSIDE";
          if (g.type === "FRAME") {
            g.strokeTopWeight = s.bw[0];
            g.strokeRightWeight = s.bw[1];
            g.strokeBottomWeight = s.bw[2];
            g.strokeLeftWeight = s.bw[3];
          } else g.strokeWeight = Math.max(...s.bw);
        }
      }
      if (s.sh && "effects" in n) {
        const fx = parseShadow(s.sh);
        if (fx.length) n.effects = fx;
      }
    };
    async function makeText(runs, box, name) {
      const t = figma.createText();
      const f0 = runs[0].f;
      const primary = await fonts.resolve(f0.ff, f0.fw, f0.fst === "italic");
      t.fontName = primary;
      let txt = "";
      const segs = [];
      for (const k of runs) {
        let piece = k.txt || "";
        if (!txt && runs.length > 1) piece = piece.replace(/^\s+/, "");
        else if (!txt.endsWith(" ") && !piece.startsWith(" ")) piece = " " + piece;
        const s = txt.length;
        txt += piece;
        segs.push({ s, e: txt.length, f: k.f });
      }
      txt = txt.replace(/\s+$/, "");
      segs[segs.length - 1].e = txt.length;
      if (f0.tt === "uppercase") txt = txt.toUpperCase();
      else if (f0.tt === "lowercase") txt = txt.toLowerCase();
      t.characters = txt || " ";
      t.fontSize = f0.fs;
      const lh = px(f0.lh);
      t.lineHeight = lh ? { unit: "PIXELS", value: lh } : { unit: "AUTO" };
      const ls = px(f0.ls);
      if (ls) t.letterSpacing = { unit: "PIXELS", value: ls };
      const col = parseColor(f0.col);
      if (col) t.fills = [solid(col)];
      t.textAlignHorizontal = { center: "CENTER", right: "RIGHT", end: "RIGHT", justify: "JUSTIFIED" }[f0.ta] || "LEFT";
      if ((f0.td || "").includes("underline")) t.textDecoration = "UNDERLINE";
      else if ((f0.td || "").includes("line-through")) t.textDecoration = "STRIKETHROUGH";
      if (segs.length > 1) {
        for (const g of segs) {
          if (g.e <= g.s) continue;
          const fn = await fonts.resolve(g.f.ff, g.f.fw, g.f.fst === "italic");
          t.setRangeFontName(g.s, g.e, fn);
          t.setRangeFontSize(g.s, g.e, g.f.fs);
          const c = parseColor(g.f.col);
          if (c) t.setRangeFills(g.s, g.e, [solid(c)]);
          if ((g.f.td || "").includes("underline")) t.setRangeTextDecoration(g.s, g.e, "UNDERLINE");
        }
      }
      const multiline = runs.length > 1 || (runs[0].lines || 1) > 1;
      if (multiline) {
        t.textAutoResize = "HEIGHT";
        t.resize(Math.max(box[2] * 1.04 + 4, 4), Math.max(box[3], 1));
      } else t.textAutoResize = "WIDTH_AND_HEIGHT";
      padOf.set(t, multiline ? (Math.max(box[2] * 1.04 + 4, 4) - box[2]) / 2 : 0);
      t.name = name;
      return t;
    }
    async function rec(n, parent, px0, py0, isRoot = false, parentRect = [px0, py0, 0, 0]) {
      const [x, y, w, h] = n.r;
      const s = n.s || {};
      let node = null;
      let recurse = true;
      const runs = n.t !== "#text" && !n.img && n.t !== "svg" ? inlineRuns(n) : null;
      const merged = runs && runs.length >= 2 && (runs.some((k) => (k.lines || 1) > 1) || runs.some((a, i) => runs.slice(i + 1).some((b) => overlaps(a, b))));
      if (merged) {
        const r0 = runs[0];
        const lh = px(r0.f.lh);
        const top = r0.r[1] - (lh ? (lh - r0.r[3]) / 2 : 0);
        node = await makeText(runs, [x, top, w, y + h - top], nameOf(runs[0]));
        parent.appendChild(node);
        node.x = x - px0 - (padOf.get(node) || 0);
        node.y = top - py0;
        recurse = false;
      } else if (n.t === "#text" && PUA_RE.test(n.txt || "")) {
        const glyphs = (n.txt || "").replace(/\s/g, "").length || 1;
        const cell = w / glyphs, size = Math.max(Math.min(cell, h) * 0.85, 1);
        const c = parseColor(n.f.col);
        const grp = [];
        for (let i = 0; i < glyphs; i++) {
          const st = figma.createStar();
          st.resize(size, size);
          st.fills = c ? [solid(c)] : [];
          st.name = "icon glyph";
          parent.appendChild(st);
          st.x = x - px0 + i * cell + (cell - size) / 2;
          st.y = y - py0 + (h - size) / 2;
          grp.push(st);
        }
        node = grp[0];
        recurse = false;
      } else if (n.t === "#text") {
        const lh = px(n.f.lh);
        const top = lh ? y - (lh - h) / 2 : y;
        const t = await makeText([n], [x, top, w, Math.max(lh || 0, h)], nameOf(n));
        parent.appendChild(t);
        t.x = x - px0;
        t.y = top - py0;
        if (t.textAutoResize === "WIDTH_AND_HEIGHT") {
          const pr = parentRect;
          const gapL = x - pr[0], gapR = pr[0] + pr[2] - (x + w);
          let anchor = t.textAlignHorizontal === "CENTER" ? "CENTER" : t.textAlignHorizontal === "RIGHT" ? "RIGHT" : "LEFT";
          if (anchor === "LEFT" && gapL > 1 && Math.abs(gapL - gapR) <= Math.max(2, 0.02 * pr[2])) anchor = "CENTER";
          else if (anchor === "LEFT" && gapR < 1 && gapL > 4) anchor = "RIGHT";
          if (anchor === "CENTER") t.x = x - px0 + (w - t.width) / 2;
          else if (anchor === "RIGHT") t.x = x - px0 + w - t.width;
          t.y = top - py0 + (Math.max(lh || 0, h) - t.height) / 2;
          if (n.pseudo === "::after") {
            const sib = parent.children;
            const prev = sib[sib.length - 2];
            if (prev && prev.type === "TEXT") {
              t.x = prev.x + prev.width + Math.max(0, x - (prevRight ?? x));
              t.y = prev.y + (prev.height - t.height) / 2;
            }
          }
        }
        node = t;
        recurse = false;
      } else if (n.t === "svg" || n.svgFile) {
        const markup = (n.svgFile || n.svg || "").replace(/currentColor/g, n.svgColor || "rgb(0,0,0)");
        try {
          const v = figma.createNodeFromSvg(markup || '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
          if (v.width > 0) v.rescale(Math.max(w, 1) / v.width);
          v.clipsContent = false;
          node = v;
        } catch (_) {
          const f = figma.createFrame();
          f.fills = [];
          f.resize(Math.max(w, 1), Math.max(h, 1));
          node = f;
        }
        parent.appendChild(node);
        node.x = x - px0;
        node.y = y - py0;
        node.name = nameOf(n);
        decorate(node, s);
        recurse = false;
      } else if (n.img) {
        const r = figma.createRectangle();
        r.resize(Math.max(w, 1), Math.max(h, 1));
        const hash = await images.hash(n.img);
        r.fills = hash ? [{ type: "IMAGE", imageHash: hash, scaleMode: s.fit === "contain" ? "FIT" : "FILL" }] : [{ type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.9 } }];
        parent.appendChild(r);
        r.x = x - px0;
        r.y = y - py0;
        r.name = nameOf(n);
        decorate(r, s);
        node = r;
        recurse = false;
      } else {
        const f = figma.createFrame();
        const fills = [];
        const bg = parseColor(s.bg);
        if (bg && bg.a > 0) fills.push(solid(bg));
        if (s.grad && !s.gradDeco) {
          const g = parseGradient(s.grad);
          if (g) fills.push(g);
        }
        if (s.bgi) {
          const hash = await images.hash(s.bgi);
          if (hash) fills.push({ type: "IMAGE", imageHash: hash, scaleMode: "FILL" });
        }
        f.fills = fills;
        f.clipsContent = s.ov === "hidden";
        f.resize(Math.max(w, 0.01), Math.max(h, 0.01));
        f.name = isRoot ? opts.name || `${cap.viewport[0]}w \xB7 ${cap.title}` : nameOf(n);
        decorate(f, s);
        parent.appendChild(f);
        if (isRoot) {
          f.x = opts.x ?? 0;
          f.y = opts.y ?? 0;
          f.clipsContent = true;
        } else {
          f.x = x - px0;
          f.y = y - py0;
        }
        node = f;
      }
      tick();
      if (recurse && node && "appendChild" in node) {
        prevRight = void 0;
        for (const k of n.c || []) {
          await rec(k, node, x, y, false, n.r);
          prevRight = k.t === "#text" ? k.r[0] + k.r[2] : void 0;
        }
      }
      if (isRoot && node) node.setSharedPluginData("html2figma", "meta", JSON.stringify({ url: cap.url, viewport: cap.viewport, capturedAt: cap.capturedAt }));
      return node;
    }
    const root = await rec(tree, figma.currentPage, tree.r[0], tree.r[1], true);
    return root;
  }

  // src/plugin/code.ts
  figma.showUI(__html__, { width: 380, height: 520, themeColors: true });
  async function fetchImage(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch (_) {
      return null;
    }
  }
  function findFreeSpot() {
    let x = 0;
    for (const n of figma.currentPage.children) x = Math.max(x, n.x + n.width);
    return { x: x ? x + 200 : 0, y: 0 };
  }
  async function buildCaptures(captures, msg) {
    const t0 = Date.now();
    const spot = findFreeSpot();
    const roots = [];
    let x = spot.x;
    for (let i = 0; i < captures.length; i++) {
      const cap = captures[i];
      const root = await build(cap, {
        x,
        y: spot.y,
        fallbackFont: msg.fallbackFont || "Inter",
        fontMap: msg.fontMap || {},
        fetchImage,
        onProgress: (done, total) => figma.ui.postMessage({ type: "progress", done, total, index: i, count: captures.length })
      });
      roots.push(root);
      x += root.width + 200;
    }
    if (roots.length > 1) {
      const sec = figma.createSection();
      sec.name = `${captures[0].title || captures[0].url} \u2014 ${captures.map((c) => c.viewport[0] + "w").join(" + ")}`;
      const minX = Math.min(...roots.map((r) => r.x)), minY = Math.min(...roots.map((r) => r.y));
      const maxX = Math.max(...roots.map((r) => r.x + r.width)), maxY = Math.max(...roots.map((r) => r.y + r.height));
      sec.x = minX - 100;
      sec.y = minY - 100;
      sec.resizeWithoutConstraints(maxX - minX + 200, maxY - minY + 200);
      for (const r of roots) {
        const ax = r.x, ay = r.y;
        sec.appendChild(r);
        r.x = ax - sec.x;
        r.y = ay - sec.y;
      }
      figma.currentPage.selection = [sec];
      figma.viewport.scrollAndZoomIntoView([sec]);
    } else {
      figma.currentPage.selection = roots;
      figma.viewport.scrollAndZoomIntoView(roots);
    }
    figma.ui.postMessage({ type: "done", name: roots.map((r) => r.name).join(", "), seconds: Math.round((Date.now() - t0) / 100) / 10 });
  }
  figma.ui.onmessage = async (msg) => {
    try {
      if (msg.type === "init") {
        const settings = await figma.clientStorage.getAsync("h2f.settings") || {};
        figma.ui.postMessage({ type: "settings", settings });
      } else if (msg.type === "saveSettings") {
        await figma.clientStorage.setAsync("h2f.settings", msg.settings || {});
      } else if (msg.type === "build") {
        const cap = typeof msg.capture === "string" ? JSON.parse(msg.capture) : msg.capture;
        if (!cap || cap.v !== 1 || !cap.tree) throw new Error("Not an html2figma capture (expected {v:1, tree}).");
        await buildCaptures([cap], msg);
      } else if (msg.type === "captureUrl") {
        const { server, apiKey, url, widths, region } = msg;
        if (!/^https?:\/\//.test(server || "")) throw new Error("Set the capture server URL first (https://\u2026).");
        figma.ui.postMessage({ type: "status", text: `Capturing ${url} at ${widths.join(", ")}\u2026 this takes 10\u201360 s` });
        const res = await fetch(server.replace(/\/$/, "") + "/capture", {
          method: "POST",
          headers: { "content-type": "application/json", ...apiKey ? { authorization: "Bearer " + apiKey } : {} },
          body: JSON.stringify({ url, widths, region: region || void 0 })
        });
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(`Server returned ${res.status}: ${text.slice(0, 200)}`);
        }
        if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
        figma.ui.postMessage({ type: "status", text: `Captured in ${(data.ms / 1e3).toFixed(1)} s (region ${data.region}). Building\u2026` });
        await buildCaptures(data.captures.map((c) => c.capture), msg);
      } else if (msg.type === "close") {
        figma.closePlugin();
      }
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: e && e.message ? e.message : String(e) });
    }
  };
})();
