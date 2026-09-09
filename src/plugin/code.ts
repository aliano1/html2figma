/// <reference types="@figma/plugin-typings" />
import { build, Capture, FontReport } from './builder';

figma.showUI(__html__, { width: 400, height: 600, themeColors: true });
figma.on('close', () => { void cancelCurrentJob(); });

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

const GAP = 120;
let currentJob: { server: string; apiKey: string; id: string } | null = null;
async function cancelCurrentJob() {
  const j = currentJob; currentJob = null;
  if (!j) return;
  try { await fetch(j.server.replace(/\/$/, '') + '/jobs/' + j.id, { method: 'DELETE', headers: j.apiKey ? { authorization: 'Bearer ' + j.apiKey } : {} }); } catch (_) { /* best effort */ }
}

function imageFrame(dataUrl: string, w: number, h: number, name: string): RectangleNode | null {
  try {
    const bytes = figma.base64Decode(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const img = figma.createImage(bytes);
    const r = figma.createRectangle();
    r.resize(Math.max(w, 1), Math.max(h, 1));
    r.fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' }];
    r.name = name;
    return r;
  } catch (_) { return null; }
}

async function postJson(server: string, apiKey: string, path: string, body: any): Promise<any> {
  const res = await fetch(server.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { throw new Error(`Server returned ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  return data;
}

async function buildCaptures(captures: Capture[], msg: any) {
  const t0 = Date.now();
  const spot = findFreeSpot();
  const all: SceneNode[] = [];
  const roots: FrameNode[] = [];
  const reports: { viewport: number; fonts: FontReport[] }[] = [];
  const scores: string[] = [];
  let x = spot.x;
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i];
    const root = await build(cap, {
      x, y: spot.y,
      fallbackFont: msg.fallbackFont || 'Inter',
      fontMap: msg.fontMap || {},
      matchWidths: msg.matchWidths !== false,
      fetchImage,
      onProgress: (done, total) => figma.ui.postMessage({ type: 'progress', done, total, index: i, count: captures.length }),
      onFonts: r => reports.push({ viewport: cap.viewport[0], fonts: r }),
    });
    roots.push(root); all.push(root);
    x += root.width + GAP;

    // reference screenshot beside the build (+ a hidden 50 % overlay inside it for eyeballing)
    if (cap.screenshot && msg.reference !== false) {
      const ref = imageFrame(cap.screenshot, root.width, root.height, `reference · ${cap.viewport[0]}w (page screenshot)`);
      if (ref) {
        figma.currentPage.appendChild(ref); ref.x = x; ref.y = spot.y; ref.locked = true; all.push(ref);
        x += ref.width + GAP;
        const ov = imageFrame(cap.screenshot, root.width, root.height, 'reference overlay — toggle visibility to compare');
        if (ov) { root.appendChild(ov); ov.x = 0; ov.y = 0; ov.opacity = 0.5; ov.locked = true; ov.visible = false; }
      }
    }

    // fidelity score: export the build and let the server diff it against the screenshot
    if (cap.screenshot && msg.diff && msg.server) {
      try {
        figma.ui.postMessage({ type: 'status', text: `Comparing ${cap.viewport[0]}w build with the screenshot…` });
        const png = await root.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
        const d = await postJson(msg.server, msg.apiKey, '/diff', { reference: cap.screenshot, candidate: 'data:image/png;base64,' + figma.base64Encode(png), cell: 24 });
        const pct = Math.round(d.similarity * 1000) / 10;
        const diff = imageFrame(d.diff, root.width, root.height, `diff · ${cap.viewport[0]}w · ${pct}% match (red = differs)`);
        if (diff) { figma.currentPage.appendChild(diff); diff.x = x; diff.y = spot.y; diff.locked = true; all.push(diff); x += diff.width + GAP; }
        root.setSharedPluginData('html2figma', 'fidelity', JSON.stringify({ similarity: d.similarity, regions: d.regions.slice(0, 50) }));
        scores.push(`${cap.viewport[0]}w ${pct}%`);
      } catch (e: any) { scores.push(`${cap.viewport[0]}w diff failed: ${e && e.message ? e.message : e}`); }
    }
  }
  if (all.length > 1) {
    const sec = figma.createSection();
    sec.name = `${captures[0].title || captures[0].url} — ${captures.map(c => c.viewport[0] + 'w').join(' + ')}`;
    const minX = Math.min(...all.map(r => r.x)), minY = Math.min(...all.map(r => r.y));
    const maxX = Math.max(...all.map(r => r.x + r.width)), maxY = Math.max(...all.map(r => r.y + r.height));
    sec.x = minX - 100; sec.y = minY - 100;
    sec.resizeWithoutConstraints(maxX - minX + 200, maxY - minY + 200);
    for (const r of all) { const ax = r.x, ay = r.y; sec.appendChild(r); r.x = ax - sec.x; r.y = ay - sec.y; }
    figma.currentPage.selection = [sec];
    figma.viewport.scrollAndZoomIntoView([sec]);
  } else {
    figma.currentPage.selection = roots;
    figma.viewport.scrollAndZoomIntoView(roots);
  }
  figma.ui.postMessage({ type: 'fonts', reports });
  figma.ui.postMessage({ type: 'done', name: roots.map(r => r.name).join(', '), seconds: Math.round((Date.now() - t0) / 100) / 10, scores });
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
      if (!cap || cap.v !== 1 || !cap.tree) throw new Error('Not an htmlimport capture (expected {v:1, tree}).');
      await buildCaptures([cap], msg);
    } else if (msg.type === 'captureUrl') {
      const { server, apiKey, url, widths, region } = msg;
      if (!/^https?:\/\//.test(server || '')) throw new Error('Set the capture server URL first (https://…).');
      const t0 = Date.now();
      figma.ui.postMessage({ type: 'capture', stage: 'queued', message: 'Contacting the capture server', progress: 0, elapsed: 0, widths });
      const body = { url, widths, region: region || undefined, screenshot: msg.reference !== false || !!msg.diff };
      let data: any;
      try {
        // async job + polling: the panel shows what the server is doing instead of a frozen bar
        await cancelCurrentJob();   // a capture the user abandoned (closed the panel, clicked again) must not keep a browser busy
        const job = await postJson(server, apiKey, '/capture', { ...body, async: true });
        if (!job.jobId) throw new Error('no job id');
        currentJob = { server, apiKey, id: job.jobId };
        for (;;) {
          await new Promise(r => setTimeout(r, 700));
          const res = await fetch(server.replace(/\/$/, '') + '/jobs/' + job.jobId, { headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {} });
          const st = await res.json();
          if (!res.ok) throw new Error(st.error || `Server returned ${res.status}`);
          if (st.status === 'error') throw new Error(st.error || 'capture failed');
          figma.ui.postMessage({ type: 'capture', stage: st.stage, message: st.message, progress: st.progress, elapsed: (Date.now() - t0) / 1000, widthIndex: st.widthIndex, widths });
          if (st.status === 'done') { data = st.result; currentJob = null; break; }
        }
      } catch (e: any) {
        currentJob = null;
        // older server without /jobs → one long request
        if (!/no job id|not found|404/.test(String(e && e.message))) throw e;
        figma.ui.postMessage({ type: 'capture', stage: 'running', message: 'Capturing (server without progress reporting)', progress: -1, elapsed: (Date.now() - t0) / 1000, widths });
        data = await postJson(server, apiKey, '/capture', body);
      }
      figma.ui.postMessage({ type: 'status', text: `Captured in ${(data.ms / 1000).toFixed(1)} s (region ${data.region}). Building…` });
      await buildCaptures(data.captures.map((c: any) => c.capture), msg);
    } else if (msg.type === 'me') {
      try {
        const res = await fetch(msg.server.replace(/\/$/, '') + '/me', { headers: msg.apiKey ? { authorization: 'Bearer ' + msg.apiKey } : {} });
        const data = await res.json().catch(() => ({}));
        figma.ui.postMessage({ type: 'me', ...(res.ok ? data : { error: data.error || (res.status === 401 ? 'License key not recognised' : `Server returned ${res.status}`) }) });
      } catch (e: any) { figma.ui.postMessage({ type: 'me', error: 'Cannot reach the capture server' }); }
    } else if (msg.type === 'downloadFonts') {
      // the page's own webfont files, converted to installable TTF/OTF by the server
      const data = await postJson(msg.server, msg.apiKey, '/fonts', { faces: msg.faces });
      figma.ui.postMessage({ type: 'fontFiles', family: msg.family, files: data.files });
    } else if (msg.type === 'cancel') {
      await cancelCurrentJob();
      figma.ui.postMessage({ type: 'error', message: 'Capture cancelled.' });
    } else if (msg.type === 'close') {
      await cancelCurrentJob();
      figma.closePlugin();
    }
  } catch (e: any) {
    figma.ui.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
};
