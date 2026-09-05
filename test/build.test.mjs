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
const lbl = byChars('Add to cart')[0];
if (lbl) { const btn = (function up(n) { return n.name.includes('flexbtn') ? n : n.parent && n.parent.type !== 'PAGE' ? up(n.parent) : null; })(lbl); const [lx] = abs(lbl), [bx] = abs(btn); const gapL = lx - bx, gapR = bx + btn.width - (lx + lbl.width); check(Math.abs(gapL - gapR) < 2, `flex-centred label stays centred (gaps ${gapL.toFixed(1)} / ${gapR.toFixed(1)})`); }
check(root.findAll(n => n.type === 'RECTANGLE' && n.name === 'image' && n.fills[0] && n.fills[0].type === 'IMAGE').length === 1, 'inlined image became an IMAGE fill');
check(!texts.some(t => t.characters === 'Hidden content that should NOT be captured.'), 'closed <details> content excluded');
check(byChars('E-mail').length === 1, 'input placeholder captured');
const sticky = byChars('Add to cart — sticky')[0];
if (sticky) { const [, sy] = abs(sticky); check(sy > root.height - 80, `bottom-fixed bar moved to page bottom (y=${sy.toFixed(0)} of ${root.height.toFixed(0)})`); } else check(false, 'sticky bar captured');
const topbar = root.findAll(n => n.type === 'FRAME' && n.name.includes('(fixed)') && !n.name.includes('bottom'));
check(topbar.length === 1 && topbar[0].y < 5, 'top-fixed bar stays at the top');
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
