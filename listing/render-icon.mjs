import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const svg = readFileSync('listing/icon.svg', 'utf8');
const b = await chromium.launch({ executablePath: process.env.CHROME });
for (const s of [128, 256, 512]) {
  const p = await b.newPage({ viewport: { width: s, height: s }, deviceScaleFactor: 1 });
  await p.setContent(`<body style="margin:0;background:transparent">${svg.replace(/width="128" height="128"/, `width="${s}" height="${s}"`).replace('<svg', '<svg style="display:block"')}</body>`);
  await p.screenshot({ path: `listing/icon-${s}.png`, omitBackground: true });
}
await b.close();
