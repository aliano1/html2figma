/**
 * Minimal in-memory stand-in for the Figma Plugin API — enough to run the builder
 * outside Figma and assert on the resulting node tree. Not a faithful renderer:
 * text width is approximated (0.55em per character).
 */
let nextId = 1;
function base(type) {
  const n = {
    id: `m:${nextId++}`, type, name: type, x: 0, y: 0, width: 100, height: 100, children: [], parent: null,
    fills: [], strokes: [], effects: [], opacity: 1, visible: true, clipsContent: false,
    resize(w, h) { this.width = w; this.height = h; },
    rescale(f) { this.width *= f; this.height *= f; },
    appendChild(c) { if (c.parent) c.parent.children = c.parent.children.filter(k => k !== c); c.parent = this; this.children.push(c); },
    findAll(fn) { const out = []; (function w(n) { for (const c of n.children || []) { if (fn(c)) out.push(c); w(c); } })(this); return out; },
    findOne(fn) { return this.findAll(fn)[0] || null; },
    setSharedPluginData(ns, k, v) { (this._spd ||= {})[ns + '/' + k] = v; },
    setPluginData(k, v) { (this._pd ||= {})[k] = v; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(k => k !== this); },
  };
  return n;
}
function text() {
  const t = base('TEXT');
  let chars = '';
  Object.defineProperty(t, 'characters', { get: () => chars, set: v => { chars = v; t._fit(); } });
  t.fontName = { family: 'Inter', style: 'Regular' }; t.fontSize = 12; t.lineHeight = { unit: 'AUTO' }; t.letterSpacing = { unit: 'PIXELS', value: 0 };
  t.textAlignHorizontal = 'LEFT'; t.textAutoResize = 'WIDTH_AND_HEIGHT'; t.textDecoration = 'NONE'; t.textCase = 'ORIGINAL';
  t._ranges = [];
  t.setRangeFontName = (s, e, f) => t._ranges.push(['font', s, e, f]);
  t.setRangeFontSize = (s, e, v) => t._ranges.push(['size', s, e, v]);
  t.setRangeFills = (s, e, v) => t._ranges.push(['fills', s, e, v]);
  t.setRangeTextDecoration = (s, e, v) => t._ranges.push(['deco', s, e, v]);
  t._fit = () => { if (t.textAutoResize === 'WIDTH_AND_HEIGHT') { t.width = chars.length * t.fontSize * 0.55; t.height = t.lineHeight.unit === 'PIXELS' ? t.lineHeight.value : t.fontSize * 1.2; } };
  const origResize = t.resize; t.resize = (w, h) => { origResize.call(t, w, h); };
  return t;
}
export function makeFigma() {
  const page = base('PAGE'); page.name = 'Page 1';
  const fonts = ['Regular', 'Bold', 'Medium', 'Semi Bold', 'Italic', 'Bold Italic'].map(style => ({ fontName: { family: 'Inter', style } }));
  fonts.push({ fontName: { family: 'Helvetica', style: 'Regular' } }, { fontName: { family: 'Helvetica', style: 'Bold' } });
  return {
    currentPage: page,
    createFrame: () => { const f = base('FRAME'); f.topLeftRadius = f.topRightRadius = f.bottomRightRadius = f.bottomLeftRadius = 0; f.strokeTopWeight = f.strokeRightWeight = f.strokeBottomWeight = f.strokeLeftWeight = 0; f.strokeAlign = 'INSIDE'; return f; },
    createRectangle: () => { const r = base('RECTANGLE'); r.topLeftRadius = 0; r.strokeWeight = 1; return r; },
    createStar: () => base('STAR'),
    createText: text,
    createNodeFromSvg: (svg) => { const f = base('FRAME'); f.name = 'svg'; const m = svg.match(/width="([\d.]+)"/); f.width = m ? +m[1] : 10; f.height = f.width; return f; },
    createImage: (bytes) => ({ hash: 'img_' + bytes.length }),
    base64Decode: (b64) => Uint8Array.from(Buffer.from(b64, 'base64')),
    listAvailableFontsAsync: async () => fonts,
    loadFontAsync: async (fn) => { if (!fonts.some(f => f.fontName.family === fn.family && f.fontName.style === fn.style)) throw new Error('font ' + fn.family + ' ' + fn.style + ' not available'); },
  };
}
