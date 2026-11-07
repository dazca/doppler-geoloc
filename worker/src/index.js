// Cloudflare Worker: CORS + cache relay for adsb.lol (the only data source without CORS).
//
//   GET /adsb/range?tag=v2026.11.01-planes-readsb-prod-0&part=aa&start=123&end=456
//       -> bytes [start, end] (inclusive) of https://github.com/adsblol/globe_history_<YYYY>/releases/download/<tag>/<tag>.tar.<part>
//          (one gzip trace_full_<icao>.json member; the browser gunzips it with DecompressionStream)
//   GET /adsb/index/<tag>/<cell>.json   -> per-cell trace index shard (or day.json) from R2 (ref/data/build_index.py)
//   GET /adsb/tile/<YYYY-MM-DD>/<cell>.json      (FAST PATH)
//       -> pre-extracted non-jet contract tracks of one 0.5 deg cell for one UTC day (ref/data/build_tiles.py),
//          stored gzipped in R2 as tiles/<date>/<cell>.json.gz and served with Content-Encoding: gzip
//   GET /v2/point/<lat>/<lon>/<nm>                       (LIVE)
//       -> api.adsb.lol re-api snapshot; lat/lon rounded to 0.05 deg so nearby users share one 5 s edge cache entry
//   GET /data/traces/<xx>/trace_<full|recent>_<hex>.json  (LIVE) -> adsb.lol per-aircraft trace, cached 60 s / 10 s
//   Live responses carry X-Server-Time-Ms (edge time at serving, also as Date) for the browser's clock sync.
//
// Hardening (docs/SECURITY_REVIEW.md M1), helpers in ./lib.js:
//   * canonical cache keys built only from validated fields (query junk cannot bust the cache),
//   * per-IP rate limits per route (Workers Rate Limiting bindings, in-isolate token bucket fallback) -> 429 + Retry-After,
//   * CORS allow-list from env ALLOWED_ORIGINS (default: production Pages domain + localhost), never "*" by default.
//   * NOTE: the Cache API is a no-op on *.workers.dev. Production must use a custom domain (deploy/README.md).

import { parseRoute, allowOrigin, checkLimit, TokenBuckets } from './lib.js';

const buckets = new TokenBuckets(); // per isolate (fallback limiter)
const LIVE_UA = 'doppler-geoloc-worker/1.0 (live mode; contact: see deploy/README.md)';

function cors(req, env, h = new Headers()) {
  const ao = allowOrigin(req.headers.get('Origin') || '', env.ALLOWED_ORIGINS);
  if (ao) h.set('Access-Control-Allow-Origin', ao);
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  h.set('Access-Control-Max-Age', '86400');
  h.set('Access-Control-Expose-Headers', 'Date, X-Server-Time-Ms, Retry-After');
  h.set('Vary', 'Origin');
  return h;
}

const err = (req, env, status, msg, extra = {}) =>
  new Response(JSON.stringify({ error: msg }), {
    status, headers: cors(req, env, new Headers({ 'Content-Type': 'application/json', ...extra })) });

/** Cache-first: `produce()` -> Response to cache (or an error Response, which is returned uncached). */
async function cached(ctx, key, produce) {
  const cache = globalThis.caches?.default;
  const k = new Request(key, { method: 'GET' });
  let res = cache ? await cache.match(k) : null;
  if (res) return { res, hit: true };
  res = await produce();
  if (res.ok && cache) {
    const p = cache.put(k, res.clone());
    if (ctx?.waitUntil) ctx.waitUntil(p); else await p; // a cancelled client must not drop the cache write
  }
  return { res, hit: false };
}

async function range(r) {
  const src = `https://github.com/adsblol/globe_history_${r.year}/releases/download/${r.tag}/${r.tag}.tar${r.part ? '.' + r.part : ''}`;
  // fetch follows GitHub's 302 to the signed blob URL server-side (no CORS involved here).
  const up = await fetch(src, { headers: { Range: `bytes=${r.start}-${r.end}`, 'User-Agent': 'doppler-geoloc-worker' }, redirect: 'follow' });
  if (up.status !== 206) return new Response(JSON.stringify({ error: `upstream ${up.status}` }), { status: up.status === 404 ? 404 : 502 });
  return new Response(await up.arrayBuffer(), { headers: { 'Content-Type': 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable', 'X-Source': 'adsb.lol globe_history (ODbL 1.0)' } });
}

async function r2(env, r) {
  if (!env.INDEX) return new Response(JSON.stringify({ error: 'index bucket not configured' }), { status: 501 });
  const obj = await env.INDEX.get(r.r2key);
  if (!obj) return new Response(JSON.stringify({ error: `no ${r.route} for this day/cell (not built yet)` }), { status: 404 });
  // Tiles are stored gzipped. They are cached as opaque bytes (X-Body-Gzip) and only labelled Content-Encoding: gzip
  // when served, so the Cache API never re-encodes or decodes them.
  const h = { 'Content-Type': r.route === 'tile' ? 'application/octet-stream' : 'application/json',
    'Cache-Control': 'public, max-age=86400' };
  if (r.route === 'tile') h['X-Body-Gzip'] = '1';
  return new Response(await obj.arrayBuffer(), { headers: h });
}

async function live(r) {
  const up = await fetch(r.upstream, { headers: { 'User-Agent': LIVE_UA, Accept: 'application/json' } });
  if (!up.ok) return new Response(JSON.stringify({ error: `upstream ${up.status}` }), { status: up.status === 429 ? 429 : up.status === 404 ? 404 : 502 });
  return new Response(await up.arrayBuffer(), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${r.ttl}`,
    Date: up.headers.get('date') || new Date().toUTCString(), 'X-Source': 'adsb.lol (ODbL 1.0)' } });
}

export async function handle(req, env = {}, ctx = undefined, limiter = buckets) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, env) });
  if (req.method !== 'GET') return err(req, env, 405, 'GET only');
  const url = new URL(req.url);
  if (url.pathname === '/health') return new Response('ok', { headers: cors(req, env) });
  const r = parseRoute(url, Number(env.MAX_RANGE_BYTES || 8388608));
  if (!r) return err(req, env, 404, 'not found');
  if (r.error) return err(req, env, r.status, r.error);

  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const lim = await checkLimit(env, limiter, r.route, ip);
  if (!lim.ok) return err(req, env, 429, 'rate limited, slow down', { 'Retry-After': String(lim.retryAfterS) });

  const produce = r.route === 'range' ? () => range(r) : (r.route === 'tile' || r.route === 'index') ? () => r2(env, r) : () => live(r);
  const { res, hit } = await cached(ctx, r.key, produce);
  const h = cors(req, env, new Headers(res.headers));
  h.set('X-Cache', hit ? 'HIT' : 'MISS');
  const gz = h.get('X-Body-Gzip') === '1';
  if (gz) { h.delete('X-Body-Gzip'); h.set('Content-Type', 'application/json'); h.set('Content-Encoding', 'gzip'); }
  if (r.route === 'point' || r.route === 'trace') {
    // A cached snapshot's JSON `now` can be up to `ttl` s old, which would bias the client's clock sync (T_start).
    // So every response carries the edge's own time at serving; the client prefers it over `now` / Date.
    const nowMs = Date.now();
    h.set('X-Server-Time-Ms', String(nowMs));
    h.set('Date', new Date(nowMs).toUTCString());
  }
  return new Response(res.body, { status: res.status, headers: h, ...(gz ? { encodeBody: 'manual' } : {}) });
}

export default { fetch: (req, env, ctx) => handle(req, env, ctx) };
