/**
 * Guard rails for a browser that strangers can point at URLs.
 *   - assertPublicUrl(url): http(s) only, standard ports, hostname resolves to a public address
 *     (no loopback, private ranges, link-local / cloud metadata, multicast, or IPv6 equivalents)
 *   - guardContext(ctx): re-checks every navigation the page makes (redirects, iframes), so a public
 *     URL that 302s to http://169.254.169.254/ is blocked at the browser too
 */
import dns from 'node:dns/promises';
import net from 'node:net';

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
// local development / tests capture http://localhost:…; never set this in production
export const ALLOW_PRIVATE = process.env.H2F_ALLOW_PRIVATE === '1';

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function isPrivateV6(ip) {
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true;
  if (s.startsWith('::ffff:')) { const v4 = s.slice(7); return net.isIPv4(v4) ? isPrivateV4(v4) : true; }
  return /^(fc|fd|fe[89ab]|ff)/.test(s) || s.startsWith('2001:db8') || s.startsWith('64:ff9b');
}
export function isPrivateIp(ip) { return net.isIPv4(ip) ? isPrivateV4(ip) : net.isIPv6(ip) ? isPrivateV6(ip) : true; }

const cache = new Map();   // host → { ok, until }
export async function hostIsPublic(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const c = cache.get(h); if (c && c.until > Date.now()) return c.ok;
  let ok = false;
  try {
    if (net.isIP(h)) ok = !isPrivateIp(h);
    else if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) ok = false;
    else { const addrs = await dns.lookup(h, { all: true }); ok = addrs.length > 0 && addrs.every(a => !isPrivateIp(a.address)); }
  } catch { ok = false; }
  cache.set(h, { ok, until: Date.now() + 60_000 });
  return ok;
}

export async function assertPublicUrl(url) {
  let u; try { u = new URL(url); } catch { throw new Error('invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs can be captured');
  if (ALLOW_PRIVATE) return u;
  if (!ALLOWED_PORTS.has(u.port)) throw new Error('unusual port refused');
  if (u.username || u.password) throw new Error('credentials in URL refused');
  if (!(await hostIsPublic(u.hostname))) throw new Error('that host is not a public website');
  return u;
}

/** Block navigations (top-level and frames) to non-public hosts; subresources to private hosts are blocked too. */
export async function guardContext(ctx) {
  if (ALLOW_PRIVATE) return;
  await ctx.route('**/*', async route => {
    const req = route.request();
    let host = '';
    try { host = new URL(req.url()).hostname; } catch { return route.abort('blockedbyclient'); }
    if (!/^https?:/.test(req.url())) return route.continue();   // data:, blob:
    if (await hostIsPublic(host)) return route.continue();
    return route.abort('blockedbyclient');
  });
}
