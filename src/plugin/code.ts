/// <reference types="@figma/plugin-typings" />
import { build, Capture } from './builder';

figma.showUI(__html__, { width: 380, height: 520, themeColors: true });

async function fetchImage(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch (_) { return null; }
}

function findFreeSpot(): { x: number; y: number } {
  let x = 0;
  for (const n of figma.currentPage.children) x = Math.max(x, n.x + n.width);
  return { x: x ? x + 200 : 0, y: 0 };
}

async function buildCaptures(captures: Capture[], msg: any) {
  const t0 = Date.now();
  const spot = findFreeSpot();
  const roots: FrameNode[] = [];
  let x = spot.x;
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i];
    const root = await build(cap, {
      x, y: spot.y,
      fallbackFont: msg.fallbackFont || 'Inter',
      fontMap: msg.fontMap || {},
      fetchImage,
      onProgress: (done, total) => figma.ui.postMessage({ type: 'progress', done, total, index: i, count: captures.length }),
    });
    roots.push(root);
    x += root.width + 200;
  }
  if (roots.length > 1) {
    const sec = figma.createSection();
    sec.name = `${captures[0].title || captures[0].url} — ${captures.map(c => c.viewport[0] + 'w').join(' + ')}`;
    const minX = Math.min(...roots.map(r => r.x)), minY = Math.min(...roots.map(r => r.y));
    const maxX = Math.max(...roots.map(r => r.x + r.width)), maxY = Math.max(...roots.map(r => r.y + r.height));
    sec.x = minX - 100; sec.y = minY - 100;
    sec.resizeWithoutConstraints(maxX - minX + 200, maxY - minY + 200);
    for (const r of roots) { const ax = r.x, ay = r.y; sec.appendChild(r); r.x = ax - sec.x; r.y = ay - sec.y; }
    figma.currentPage.selection = [sec];
    figma.viewport.scrollAndZoomIntoView([sec]);
  } else {
    figma.currentPage.selection = roots;
    figma.viewport.scrollAndZoomIntoView(roots);
  }
  figma.ui.postMessage({ type: 'done', name: roots.map(r => r.name).join(', '), seconds: Math.round((Date.now() - t0) / 100) / 10 });
}

figma.ui.onmessage = async (msg: any) => {
  try {
    if (msg.type === 'init') {
      const settings = (await figma.clientStorage.getAsync('h2f.settings')) || {};
      figma.ui.postMessage({ type: 'settings', settings });
    } else if (msg.type === 'saveSettings') {
      await figma.clientStorage.setAsync('h2f.settings', msg.settings || {});
    } else if (msg.type === 'build') {
      const cap: Capture = typeof msg.capture === 'string' ? JSON.parse(msg.capture) : msg.capture;
      if (!cap || cap.v !== 1 || !cap.tree) throw new Error('Not an html2figma capture (expected {v:1, tree}).');
      await buildCaptures([cap], msg);
    } else if (msg.type === 'captureUrl') {
      const { server, apiKey, url, widths, region } = msg;
      if (!/^https?:\/\//.test(server || '')) throw new Error('Set the capture server URL first (https://…).');
      figma.ui.postMessage({ type: 'status', text: `Capturing ${url} at ${widths.join(', ')}… this takes 10–60 s` });
      const res = await fetch(server.replace(/\/$/, '') + '/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
        body: JSON.stringify({ url, widths, region: region || undefined }),
      });
      const text = await res.text();
      let data: any; try { data = JSON.parse(text); } catch { throw new Error(`Server returned ${res.status}: ${text.slice(0, 200)}`); }
      if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
      figma.ui.postMessage({ type: 'status', text: `Captured in ${(data.ms / 1000).toFixed(1)} s (region ${data.region}). Building…` });
      await buildCaptures(data.captures.map((c: any) => c.capture), msg);
    } else if (msg.type === 'close') {
      figma.closePlugin();
    }
  } catch (e: any) {
    figma.ui.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
};
