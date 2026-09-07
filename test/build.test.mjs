// Runs the real builder against test/capture.json on a mock Figma API and checks a few invariants.
import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { makeFigma } from './mock-figma.mjs';

const r = await esbuild.build({ entryPoints: ['src/plugin/builder.ts'], bundle: true, format: 'esm', target: 'es2020', write: false });
const mod = await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
globalThis.figma = makeFigma();

const cap = JSON.parse(readFileSync('test/capture.json', 'utf8'));
const root = await mod.build(cap, { x: 0, y: 0, name: 'test' });
const abs = n => { let x = 0, y = 0; for (let k = n; k && k.type !== 'PAGE'; k = k.parent) { x += k.x; y += k.y; } return [x, y]; };
const texts = root.findAll(n => n.type === 'TEXT');
const stars = root.findAll(n => n.type === 'STAR');
const byChars = s => texts.filter(t => t.characters.includes(s));

let fails = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) fails++; };

const glyphImgs = root.findAll(n => n.type === 'RECTANGLE' && n.fills[0] && n.fills[0].type === 'IMAGE' && n.name === 'glyph (raster)');
const serverCapture = !!cap.tree && JSON.stringify(cap).includes('"glyph":true');
check(serverCapture ? glyphImgs.length >= 6 : stars.length === 8, serverCapture ? `icon-font glyphs rasterised as image fills (got ${glyphImgs.length})` : `8 star shapes (5 review ::before + 3 glyph run), got ${stars.length}`);
if (serverCapture) check(root.findAll(n => n.name === 'video frame' && n.fills[0] && n.fills[0].type === 'IMAGE').length === 1, 'cross-origin video became an image fill');
const rich = byChars('No toxic materials.')[0];
check(rich && rich._ranges.some(x => x[0] === 'deco' && x[3] === 'UNDERLINE'), 'mixed paragraph merged into one node with an underlined range');
const chev = byChars('›');
check(chev.length === 1, `chevron ::after present as text, got ${chev.length}`);
const spec = byChars('See all specs')[0];
if (chev[0] && spec) { const [cx, cy] = abs(chev[0]), [sx, sy] = abs(spec); check(cx >= sx + spec.width - 1 && Math.abs(cy - sy) < 6, `chevron sits right after "See all specs" (chev x=${cx.toFixed(1)}, text right=${(sx + spec.width).toFixed(1)})`); }
const inst = byChars('interest-free');
check(inst.length === 1 && inst[0].characters === '4 interest-free installments, or from $85.29/mo with shop', `same-line bold/plain runs merged into one node with spacing kept: "${inst[0] && inst[0].characters}"`);
check(inst[0] && inst[0].textAutoResize === 'WIDTH_AND_HEIGHT' && inst[0]._ranges.some(x => x[0] === 'font' && inst[0].characters.slice(x[1], x[2]) === '$85.29'), 'merged single-line node stays single-line and keeps the bold range on the price');
check(!texts.some(t => t.characters === '$85.29' || t.characters === '/mo with'), 'no stray separate nodes for the price / "/mo with"');
if (inst[0]) { const icon = inst[0].parent.children.find(c => c !== inst[0] && c.name === 'icon'); check(!!icon && icon.x >= inst[0].x + inst[0].width - 1, `trailing inline svg survives next to the merged line (icon x=${icon && icon.x.toFixed(1)}, text right=${(inst[0].x + inst[0].width).toFixed(1)})`); }
// width compensation for a substituted font: the mock's Inter is a different width from the browser's
// fallback for "Komet"; letter-spacing must be adjusted so the unwrapped width equals the captured line widths
const kom = byChars('Editable text in a font')[0];
const komCap = (function find(n) { if (n.txt && n.txt.includes('Editable text in a font')) return n; for (const k of n.c || []) { const r = find(k); if (r) return r; } return null; })(cap.tree);
if (kom && komCap) {
  const lsRange = kom._ranges.find(x => x[0] === 'ls' && x[1] === 0);
  check(!!lsRange, `substituted font got letter-spacing compensation (${lsRange ? lsRange[3].value.toFixed(2) + 'px' : 'none'})`);
  const t = globalThis.figma.createText(); t.fontSize = kom.fontSize; t.letterSpacing = kom.letterSpacing; t.characters = kom.characters;
  const tolerance = Math.max(2, 0.08 * kom.fontSize * kom.characters.length);   // clamp may limit the correction
  check(Math.abs(t.width - komCap.lw) <= tolerance, `unwrapped width ${t.width.toFixed(1)} ≈ captured ${komCap.lw} (multi-line, lines=${komCap.lines})`);
  const clamped = lsRange && Math.abs(Math.abs(lsRange[3].value) - 0.08 * kom.fontSize) < 0.01;
  check(kom.textAutoResize === 'HEIGHT' && kom.width <= komCap.r[2] + (clamped ? komCap.r[2] * 0.04 + 4.5 : 2), `multi-line box stays tight to the captured width (${kom.width.toFixed(1)} vs ${komCap.r[2]}${clamped ? ', correction clamped so slack allowed' : ''})`);
}
let fontReport = null;
await mod.build(cap, { x: 0, y: 3000, name: 'test2', onFonts: r => { fontReport = r; } });
check(fontReport && fontReport.some(f => f.family === 'Komet' && !f.installed && f.usedAs === 'Inter') && fontReport.some(f => f.family === 'Helvetica' && f.installed), `font report lists substitutions: ${fontReport && fontReport.map(f => `${f.family}→${f.usedAs}${f.installed ? '' : ' (missing)'}`).join(', ')}`);
// face-aware weights: the page says Helvetica 500 loads "HelveticaBold.woff2" → use the installed Bold face, not Medium/Regular
{
  const cap2 = JSON.parse(JSON.stringify(cap)); cap2.fonts = [{ family: 'Helvetica', weight: '500', style: 'normal', url: 'x', file: 'HelveticaBold.woff2' }];
  const root2 = await mod.build(cap2, { x: 0, y: 6000, name: 'test3' });
  const nav = root2.findAll(n => n.type === 'TEXT' && n.characters === 'Cookware')[0];
  check(nav && nav.fontName.style === 'Bold', `weight 500 mapped onto the face the site loaded (got ${nav && nav.fontName.family + ' ' + nav.fontName.style})`);
  const body = root2.findAll(n => n.type === 'TEXT' && n.characters.startsWith('Our 15-piece'))[0];
  check(body && body.fontName.style === 'Regular', `weight 400 untouched (got ${body && body.fontName.style})`);
}
// content:"" pseudo boxes: the active thumbnail's 2px bar (in-flow ::after, opacity 1) and a tint overlay (absolute ::before, inset:0)
{
  const thumbs = root.findAll(n => n.type === 'FRAME' && /thumb/.test(n.name));
  const bars = root.findAll(n => n.type === 'FRAME' && n.name.includes('::after') && Math.abs(n.height - 2) < 0.6 && Math.abs(n.width - 64) < 0.6);
  check(thumbs.length === 2 && bars.length === 1, `only the active thumbnail gets its indicator bar (thumbs=${thumbs.length}, bars=${bars.length})`);
  if (bars[0]) { const [, by] = abs(bars[0]); const host = bars[0].parent; const [, hy] = abs(host); check(Math.abs(by - (hy + host.height - 2)) < 1 && bars[0].fills[0] && bars[0].fills[0].type === 'SOLID', `bar sits at the bottom of its host (bar y=${by.toFixed(1)}, host bottom=${(hy + host.height).toFixed(1)})`); }
  const tint = root.findAll(n => n.type === 'FRAME' && n.name.includes('::before') && Math.abs(n.width - 120) < 0.6 && Math.abs(n.height - 60) < 0.6)[0];
  check(!!tint && tint.fills[0] && tint.fills[0].opacity > 0.35 && tint.fills[0].opacity < 0.45 && tint.topLeftRadius === 8, `absolute inset:0 overlay pseudo captured with its alpha and radius (${tint ? `opacity ${tint.fills[0].opacity}, radius ${tint.topLeftRadius}` : 'missing'})`);
}
const lbl = byChars('Add to cart')[0];
if (lbl) { const btn = (function up(n) { return n.name.includes('flexbtn') ? n : n.parent && n.parent.type !== 'PAGE' ? up(n.parent) : null; })(lbl); const [lx] = abs(lbl), [bx] = abs(btn); const gapL = lx - bx, gapR = bx + btn.width - (lx + lbl.width); check(Math.abs(gapL - gapR) < 2, `flex-centred label stays centred (gaps ${gapL.toFixed(1)} / ${gapR.toFixed(1)})`); }
check(root.findAll(n => n.type === 'RECTANGLE' && n.name === 'image' && n.fills[0] && n.fills[0].type === 'IMAGE').length === 3, 'inlined images became IMAGE fills (card photo + 2 thumbnails)');
const logoCap = (function find(n) { if (n.filt) return n; for (const k of n.c || []) { const r = find(k); if (r) return r; } return null; })(cap.tree);
check(!!logoCap && /^data:image\/png/.test(logoCap.img || ''), `filtered <img> captured as a baked PNG (filter=${logoCap && logoCap.filt})`);
if (logoCap) {
  // decode the PNG's first pixel: grayscale(1) of pure red must give r≈g≈b
  const { inflateSync } = await import('node:zlib');
  const buf = Buffer.from(logoCap.img.split(',')[1], 'base64');
  let pos = 8, idat = [], w = 0, ct = 0;
  while (pos < buf.length) { const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8); const d = buf.subarray(pos + 8, pos + 8 + len); if (type === 'IHDR') { w = d.readUInt32BE(0); ct = d[9]; } if (type === 'IDAT') idat.push(d); pos += 12 + len; }
  const raw = inflateSync(Buffer.concat(idat)); const bpp = ct === 6 ? 4 : 3; const stride = 1 + w * bpp; const rows = Math.floor(raw.length / stride);
  const row = Math.floor(rows / 2), off = row * stride; const ftype = raw[off]; const px = raw.subarray(off + 1 + Math.floor(w / 2) * bpp, off + 1 + Math.floor(w / 2) * bpp + 3);
  if (ftype === 0) check(Math.abs(px[0] - px[1]) < 8 && Math.abs(px[1] - px[2]) < 8 && px[0] > 30, `grayscale baked into pixels (mid pixel rgb=${[...px].join(',')})`);
  else console.log(`skip grayscale pixel check (PNG row filter ${ftype}; server test verifies this path)`);
  const logoNode = root.findAll(n => n.type === 'RECTANGLE' && /^image \(grayscale/.test(n.name))[0];
  check(!!logoNode && logoNode.fills[0].type === 'IMAGE', 'filtered image layer named after its filter');
}
check(!texts.some(t => t.characters === 'Hidden content that should NOT be captured.'), 'closed <details> content excluded');
check(byChars('E-mail').length === 1, 'input placeholder captured');
const sticky = byChars('Add to cart — sticky')[0];
if (sticky) { const [, sy] = abs(sticky); check(sy > root.height - 80, `bottom-fixed bar moved to page bottom (y=${sy.toFixed(0)} of ${root.height.toFixed(0)})`); } else check(false, 'sticky bar captured');
const topbar = root.findAll(n => n.type === 'FRAME' && n.name.includes('(fixed)') && !n.name.includes('bottom'));
check(topbar.length === 1 && topbar[0].y < 5, 'top-fixed bar stays at the top');
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
