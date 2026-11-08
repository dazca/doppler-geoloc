// Cloudflare Worker: CORS + cache relay for adsb.lol (the only data source without CORS).
//
//   GET /adsb/range?tag=v2026.11.01-planes-readsb-prod-0&part=aa&start=123&end=456[&repo=YYYY]
//       -> bytes [start, end] (inclusive) of https://github.com/adsblol/globe_history_<repo|tag year>/releases/download/<tag>/<tag>.tar.<part>
//          (one gzip trace_full_<icao>.json member; the browser gunzips it with DecompressionStream)
//   GET /adsb/index/<tag>/<cell>.json   -> per-cell trace index shard (or day.json) from R2 (ref/data/build_index.py)
//   GET /adsb/index/meta/coverage.json  -> data availability manifest {updated, bbox, days[], from, to} (daily_job.py), 60 s cache
//   GET /adsb/tile/<YYYY-MM-DD>/<cell>.json      (FAST PATH)
//       -> pre-extracted non-jet contract tracks of one 0.5 deg cell for one UTC day (ref/data/build_tiles.py),
//          stored gzipped in R2 as tiles/<date>/<cell>.json.gz and served with Content-Encoding: gzip
//   GET /v2/point/<lat>/<lon>/<nm>                       (LIVE)
//       -> api.adsb.lol re-api snapshot; lat/lon rounded to 0.05 deg so nearby users share one 5 s edge cache entry
//   GET /data/traces/<xx>/trace_<full|recent>_<hex>.json  (LIVE) -> adsb.lol per-aircraft trace, cached 60 s / 10 s
//   Live responses carry X-Server-Time-Ms (edge time at serving, also as Date) for the browser's clock sync.
//   POST /session  {token: <Turnstile token>} -> {session, exp}: a signed 2 h token for X-Doppler-Session (lib.js).
//   With SESSION_MODE=enforce every data route above needs that header (checked BEFORE the cache, so cached data is
//   never served without one); /health and the coverage manifest stay open (public metadata, read before any search).
//
// Hardening (docs/SECURITY_REVIEW.md M1), helpers in ./lib.js:
//   * canonical cache keys built only from validated fields (query junk cannot bust the cache),
//   * per-IP rate limits per route (Workers Rate Limiting bindings, in-isolate token bucket fallback) -> 429 + Retry-After,
//   * CORS allow-list from env ALLOWED_ORIGINS (default: production Pages domain + localhost), never "*" by default.
//   * NOTE: the Cache API is a no-op on *.workers.dev. Production must use a custom domain (deploy/README.md).

import { parseRoute, allowOrigin, checkLimit, TokenBuckets, clientKey, sessionMode, signSession, verifySession,
  verifyTurnstile, SESSION_HEADER } from './lib.js';

const buckets = new TokenBuckets(); // per isolate (fallback limiter)
const LIVE_UA = 'doppler-geoloc-worker/1.0 (live mode; contact: see deploy/README.md)';

function cors(req, env, h = new Headers()) {
  const ao = allowOrigin(req.headers.get('Origin') || '', env.ALLOWED_ORIGINS);
  if (ao) h.set('Access-Control-Allow-Origin', ao);
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', `${SESSION_HEADER}, Content-Type`);
  h.set('Access-Control-Max-Age', '86400'); // browsers cap it (Chrome 2 h); the preflight cache is per URL
  h.set('Access-Control-Expose-Headers', `Date, X-Server-Time-Ms, Retry-After, Link, X-Source, ${SESSION_HEADER}`);
  h.set('Vary', 'Origin');
  return h;
}

const err = (req, env, status, msg, extra = {}, code = undefined) =>
  new Response(JSON.stringify({ error: msg, ...(code ? { code } : {}) }), {
    status, headers: cors(req, env, new Headers({ 'Content-Type': 'application/json', ...extra })) });

/**
 * Cache-first: `produce()` -> Response to cache (or an error Response, which is returned uncached).
 * A 404 that carries its own Cache-Control (R2 "not built yet") is cached too: it saves an R2 read per repeat miss.
 */
async function cached(ctx, key, produce) {
  const cache = globalThis.caches?.default;
  const k = new Request(key, { method: 'GET' });
  let res = cache ? await cache.match(k) : null;
  if (res) return { res, hit: true };
  res = await produce();
  if (cache && (res.ok || (res.status === 404 && res.headers.has('Cache-Control')))) {
    const p = cache.put(k, res.clone());
    if (ctx?.waitUntil) ctx.waitUntil(p); else await p; // a cancelled client must not drop the cache write
  }
  return { res, hit: false };
}

/** Upstream retry of /adsb/range: GitHub's release CDN intermittently answers 5xx/504 or drops the connection. Waits
 * between attempts (I/O wait, not CPU time); exported so tests can zero them. */
export const RANGE_RETRY = { backoffMs: [200, 600] };

async function range(r) {
  const src = `https://github.com/adsblol/globe_history_${r.year}/releases/download/${r.tag}/${r.tag}.tar${r.part ? '.' + r.part : ''}`;
  // fetch follows GitHub's 302 to the signed blob URL server-side (no CORS involved here).
  let up = null, why = '';
  for (let i = 0; ; i++) {
    try {
      up = await fetch(src, { headers: { Range: `bytes=${r.start}-${r.end}`, 'User-Agent': 'doppler-geoloc-worker' }, redirect: 'follow' });
      if (up.status === 206 || up.status === 404 || up.status === 416) break;
      why = `upstream ${up.status}`;
      await up.body?.cancel();
    } catch { why = 'upstream error'; }
    up = null;
    if (i >= RANGE_RETRY.backoffMs.length) break;
    await new Promise((res) => setTimeout(res, RANGE_RETRY.backoffMs[i]));
  }
  if (!up || up.status !== 206) {
    return new Response(JSON.stringify({ error: up ? `upstream ${up.status}` : why }), { status: up?.status === 404 ? 404 : 502,
      headers: { 'Content-Type': 'application/json', ...(up ? {} : { 'Retry-After': '5' }) } });
  }
  return new Response(await up.arrayBuffer(), { headers: { 'Content-Type': 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable', 'X-Source': 'adsb.lol globe_history (ODbL 1.0)' } });
}

const ODBL = { Link: '<https://opendatacommons.org/licenses/odbl/1-0/>; rel="license"', 'X-Source': 'adsb.lol' };
const R2_MISS_TTL = 300; // s; a day is built once a day, so a short negative cache is safe (coverage stays <= its 60 s)
const isR2 = (r) => r.route === 'tile' || r.route === 'index';

/** The route's own Cache-Control. Re-applied on cache hits: the zone's Browser Cache TTL (4 h) rewrites the stored copy. */
function cacheControl(r, status) {
  if (r.route === 'range') return 'public, max-age=31536000, immutable';
  if (isR2(r)) return `public, max-age=${status === 404 ? Math.min(R2_MISS_TTL, r.ttl || R2_MISS_TTL) : r.ttl || 86400}`;
  return `public, max-age=${r.ttl}`;
}

async function r2(env, r) {
  if (!env.INDEX) return new Response(JSON.stringify({ error: 'index bucket not configured' }), { status: 501 });
  const obj = await env.INDEX.get(r.r2key);
  if (!obj) return new Response(JSON.stringify({ error: `no ${r.route} for this day/cell (not built yet)` }), { status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl(r, 404) } });
  // Tiles are stored gzipped. They are cached as opaque bytes (X-Body-Gzip) and only labelled Content-Encoding: gzip
  // when served, so the Cache API never re-encodes or decodes them.
  const h = { 'Content-Type': r.route === 'tile' ? 'application/octet-stream' : 'application/json',
    'Cache-Control': cacheControl(r, 200), ...ODBL };
  if (r.route === 'tile') h['X-Body-Gzip'] = '1';
  return new Response(await obj.arrayBuffer(), { headers: h });
}

async function live(r) {
  const up = await fetch(r.upstream, { headers: { 'User-Agent': LIVE_UA, Accept: 'application/json' } });
  if (!up.ok) return new Response(JSON.stringify({ error: `upstream ${up.status}` }), { status: up.status === 429 ? 429 : up.status === 404 ? 404 : 502 });
  return new Response(await up.arrayBuffer(), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${r.ttl}`,
    Date: up.headers.get('date') || new Date().toUTCString(), 'X-Source': 'adsb.lol (ODbL 1.0)' } });
}

/** POST /session: Turnstile token -> signed session token. Only for allowed page origins. */
async function issueSession(req, env, limiter, ip) {
  if (!env.SESSION_KEY || !env.TURNSTILE_SECRET) return err(req, env, 501, 'sessions not configured');
  const origin = req.headers.get('Origin') || '';
  if (!allowOrigin(origin, env.ALLOWED_ORIGINS) || !origin) return err(req, env, 403, 'origin not allowed');
  const lim = await checkLimit(env, limiter, 'session', ip);
  if (!lim.ok) return err(req, env, 429, 'rate limited, slow down', { 'Retry-After': String(lim.retryAfterS) });
  let token = '';
  try { token = String((await req.json())?.token || ''); } catch { /* bad body */ }
  if (!token || token.length > 4096) return err(req, env, 400, 'missing turnstile token');
  let v;
  try { v = await verifyTurnstile(env.TURNSTILE_SECRET, token, { ip: req.headers.get('CF-Connecting-IP') || '', origin }); }
  catch { return err(req, env, 502, 'verification unavailable', { 'Retry-After': '5' }); }
  if (!v.ok) return err(req, env, 403, `verification failed (${v.why})`);
  const s = await signSession(env.SESSION_KEY, { ip });
  return new Response(JSON.stringify({ session: s.token, exp: s.exp }), {
    headers: cors(req, env, new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })) });
}

/** Session gate of a data route: {ok, id|null} or an error Response. Runs before the cache. */
async function checkSession(req, env, r, ip) {
  const mode = sessionMode(env);
  if (mode === 'off' || r.open) return { ok: true, id: null };
  if (!env.SESSION_KEY) return mode === 'enforce' ? { res: err(req, env, 503, 'sessions not configured', { 'Retry-After': '60' }) } : { ok: true, id: null };
  const tok = req.headers.get(SESSION_HEADER);
  if (!tok) return mode === 'enforce' ? { res: err(req, env, 401, 'session required', {}, 'session') } : { ok: true, id: null };
  const v = await verifySession(env.SESSION_KEY, tok, { ip });
  return v.ok ? { ok: true, id: v.id } : { res: err(req, env, 401, `invalid session (${v.why})`, {}, 'session') };
}

export async function handle(req, env = {}, ctx = undefined, limiter = buckets) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, env) });
  const url = new URL(req.url);
  const ip = clientKey(req.headers.get('CF-Connecting-IP') || 'local');
  if (url.pathname === '/session') return req.method === 'POST' ? issueSession(req, env, limiter, ip) : err(req, env, 405, 'POST only');
  if (req.method !== 'GET') return err(req, env, 405, 'GET only');
  if (url.pathname === '/health') return new Response('ok', { headers: cors(req, env) });
  const r = parseRoute(url, Number(env.MAX_RANGE_BYTES || 8388608));
  if (!r) return err(req, env, 404, 'not found');
  if (r.error) return err(req, env, r.status, r.error);

  const lim = await checkLimit(env, limiter, r.route, ip);
  if (!lim.ok) return err(req, env, 429, 'rate limited, slow down', { 'Retry-After': String(lim.retryAfterS) });
  const sess = await checkSession(req, env, r, ip);
  if (sess.res) return sess.res;
  if (sess.id) { // per-session budget on top of the per-IP one (same limits, own key)
    const sl = await checkLimit(env, limiter, r.route, `s:${sess.id}`);
    if (!sl.ok) return err(req, env, 429, 'rate limited, slow down', { 'Retry-After': String(sl.retryAfterS) });
  }

  const produce = r.route === 'range' ? () => range(r) : isR2(r) ? () => r2(env, r) : () => live(r);
  let res, hit;
  try {
    ({ res, hit } = await cached(ctx, r.key, produce));
  } catch {
    // upstream fetch / R2 / Cache API threw: answer with CORS so the browser sees a retryable error, not an opaque 1101
    return err(req, env, 502, 'upstream error', { 'Retry-After': '5' });
  }
  const h = cors(req, env, new Headers(res.headers));
  h.set('X-Cache', hit ? 'HIT' : 'MISS');
  if (hit && (res.ok || res.status === 404)) h.set('Cache-Control', cacheControl(r, res.status));
  if (isR2(r) && res.ok) for (const [k, v] of Object.entries(ODBL)) h.set(k, v); // also on entries cached before this header
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
