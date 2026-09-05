/**
 * Bookmarklet entry — bundled by scripts/build.mjs into dist/bookmarklet.txt
 * Shows a small panel on the page: capture → copy JSON / download .json
 */
import { extract, warmUp, inlineImages } from '../core/extract.js';

const HIDE = [
  '#shopify-pc__banner', '.shopify-pc__banner', '#onetrust-consent-sdk', '#CybotCookiebotDialog',
  '.cc-window', '#cookie-banner', '[id*="cookie-consent"]', '[class*="cookie-consent"]',
  '.sca-modal-fg', '.freegifts-main-container', '#html2figma-panel',
];

(function main() {
  if (document.getElementById('html2figma-panel')) return;
  const panel = document.createElement('div');
  panel.id = 'html2figma-panel';
  panel.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;background:#111;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:14px 16px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);width:280px';
  panel.innerHTML = `
    <div style="font-weight:600;margin-bottom:6px">html2figma</div>
    <div id="h2f-status" style="opacity:.8;margin-bottom:10px">Viewport ${innerWidth}×${innerHeight}. Ready.</div>
    <label style="display:flex;gap:6px;align-items:center;margin-bottom:10px"><input id="h2f-inline" type="checkbox" checked> Inline images (bigger file, self-contained)</label>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button id="h2f-capture" style="flex:1;background:#c8da2b;color:#111;border:0;border-radius:8px;padding:8px 10px;font-weight:600;cursor:pointer">Capture page</button>
      <button id="h2f-close" style="background:#333;color:#fff;border:0;border-radius:8px;padding:8px 10px;cursor:pointer">✕</button>
    </div>
    <div id="h2f-actions" style="display:none;gap:8px;margin-top:10px">
      <button id="h2f-copy" style="flex:1;background:#fff;color:#111;border:0;border-radius:8px;padding:8px 10px;font-weight:600;cursor:pointer">Copy JSON</button>
      <button id="h2f-download" style="flex:1;background:#fff;color:#111;border:0;border-radius:8px;padding:8px 10px;font-weight:600;cursor:pointer">Download .json</button>
    </div>`;
  document.body.appendChild(panel);
  const $ = id => panel.querySelector('#' + id);
  const status = msg => { $('h2f-status').textContent = msg; };
  let json = null;

  $('h2f-close').onclick = () => panel.remove();
  $('h2f-capture').onclick = async () => {
    $('h2f-capture').disabled = true;
    try {
      status('Scrolling to trigger lazy content…');
      await warmUp();
      status('Reading DOM…');
      panel.style.display = 'none';           // never capture ourselves
      const cap = extract({ hideSelectors: HIDE });
      panel.style.display = '';
      if ($('h2f-inline').checked) {
        await inlineImages(cap, { onProgress: (d, t) => status(`Inlining images ${d}/${t}…`) });
      }
      // escape non-ASCII so the JSON survives any clipboard / editor round-trip
      json = JSON.stringify(cap).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      const kb = Math.round(json.length / 1024);
      status(`Captured ${countNodes(cap.tree)} nodes, ${kb} KB. ${kb > 8000 ? 'Large — use Download.' : ''}`);
      $('h2f-actions').style.display = 'flex';
    } catch (e) {
      status('Failed: ' + e.message);
    } finally {
      $('h2f-capture').disabled = false;
    }
  };
  $('h2f-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(json); status('Copied. Paste into the Figma plugin.'); }
    catch (e) { status('Clipboard blocked — use Download instead.'); }
  };
  $('h2f-download').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = (location.hostname + location.pathname).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') + `-${innerWidth}w.json`;
    a.click();
    status('Downloaded. Open it in the Figma plugin.');
  };
  function countNodes(n) { return 1 + (n.c || []).reduce((a, k) => a + countNodes(k), 0); }
})();
