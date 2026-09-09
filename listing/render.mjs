import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const b = await chromium.launch({ executablePath: process.env.CHROME });
const dir = 'file:///home/claude/html2figma/listing/';
// icon at 128 / 256 / 512
for (const s of [128, 256, 512]) {
  const p = await b.newPage({ viewport: { width: s, height: s }, deviceScaleFactor: 1 });
  await p.setContent(`<body style="margin:0;background:transparent"><img src="${dir}icon.svg" width="${s}" height="${s}" style="display:block"></body>`);
  await p.waitForTimeout(200);
  await p.screenshot({ path: `icon-${s}.png`, omitBackground: true });
}
const c = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await c.goto(dir + 'cover.html'); await c.waitForTimeout(400);
await c.screenshot({ path: 'cover-1920x1080.png' });
await b.close();
