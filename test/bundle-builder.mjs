import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
const r = await esbuild.build({ entryPoints: ['src/plugin/builder.ts'], bundle: true, format: 'iife', globalName: 'H2F', target: 'es2020', write: false, minify: true });
const lib = r.outputFiles[0].text;
const cap = readFileSync('test/capture.json', 'utf8');
const script = `${lib}
const P = await figma.getNodeByIdAsync('10858:17'); await figma.setCurrentPageAsync(P);
const cap = ${cap};
const root = await H2F.build(cap, { x: 4460, y: 7200, name: 'html2figma plugin test' });
const shot = await root.screenshot({ scale: 0.5 });
return { id: root.id, w: root.width, h: root.height, children: root.children.length };`;
writeFileSync('test/figma-test.js', script);
console.log(script.length, 'chars');
