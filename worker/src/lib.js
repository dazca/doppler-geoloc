// Pure helpers for the Worker (no Cloudflare globals): route parsing + canonical cache keys, CORS origin policy,
// per-IP rate limits.  Unit-tested in Node: node --test worker/test/
//
// SECURITY_REVIEW M1: (a) the cache key is rebuilt from validated, whitelisted fields only, so extra or reordered
// query params (?x=<random>) can no longer force a miss and an 8 MiB upstream fetch; (b) every data route is
// rate-limited per client IP; (c) CORS is an explicit allow-list (default: production Pages domain + localhost).

export const TAG_RE = /^v(\d{4})\.\d{2}\.\d{2}-planes-readsb-(prod|mlatonly|staging)-\d$/;
export const PART_RE = /^(|a[a-z])$/;
export const CELL_RE = /^(\d{5,6}|day)\.json$/; // <cell>.json, or day.json = release completeness
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const CACHE_ORIGIN = 'https://cache.internal'; // synthetic host: keys never depend on the request URL

/**
 * Parse + validate a request URL into a canonical route description, or {error,status}, or null (no data route).
 *   {route, key, ...fields}: `key` = canonical Cache API key (only the fields that select the content).
 */
export function parseRoute(url, maxRangeBytes = 8388608) {
  const p = url.pathname;
  if (p === '/adsb/range') {
    const q = url.searchParams;
    const tag = q.get('tag') || '';
    const part = q.get('part') ?? 'aa';
    const s = q.get('start'), e = q.get('end');
    const m = TAG_RE.exec(tag);
    if (!m || !PART_RE.test(part)) return { error: 'bad tag/part', status: 400 };
    if (!/^\d{1,15}$/.test(s || '') || !/^\d{1,15}$/.test(e || '')) return { error: 'bad range', status: 400 };
    const start = Number(s), end = Number(e);
    if (end < start) return { error: 'bad range', status: 400 };
    if (end - start + 1 > maxRangeBytes) return { error: 'range too large', status: 413 };
    return { route: 'range', tag, year: m[1], part, start, end,
      key: `${CACHE_ORIGIN}/adsb/range/${tag}/${part || '-'}/${start}-${end}` };
  }
  // data availability manifest (ref/data/daily_job.py): rewritten after every uploaded day, so it is cached briefly only
  if (p === '/adsb/index/meta/coverage.json') {
    return { route: 'index', r2key: 'meta/coverage.json', ttl: 60, key: `${CACHE_ORIGIN}/adsb/index/meta/coverage.json` };
  }
  let m = /^\/adsb\/index\/([^/]+)\/([^/]+)$/.exec(p);
  if (m) {
    if (!TAG_RE.test(m[1]) || !CELL_RE.test(m[2])) return { error: 'bad tag/cell', status: 400 };
    return { route: 'index', tag: m[1], cell: m[2], r2key: `${m[1]}/${m[2]}`, key: `${CACHE_ORIGIN}/adsb/index/${m[1]}/${m[2]}` };
  }
  m = /^\/adsb\/tile\/([^/]+)\/([^/]+)$/.exec(p);
  if (m) {
    if (!DATE_RE.test(m[1]) || !CELL_RE.test(m[2])) return { error: 'bad date/cell', status: 400 };
    return { route: 'tile', date: m[1], cell: m[2], r2key: `tiles/${m[1]}/${m[2]}.gz`, key: `${CACHE_ORIGIN}/adsb/tile/${m[1]}/${m[2]}` };
  }
  m = /^\/v2\/point\/(-?\d{1,3}(?:\.\d+)?)\/(-?\d{1,3}(?:\.\d+)?)\/(\d{1,4})$/.exec(p);
  if (m) {
    const lat = Math.round(+m[1] * 20) / 20, lon = Math.round(+m[2] * 20) / 20, nm = Math.min(40, Math.max(1, +m[3]));
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { error: 'bad position', status: 400 };
    const a = lat.toFixed(2), b = lon.toFixed(2);
    return { route: 'point', ttl: 5, upstream: `https://api.adsb.lol/v2/point/${a}/${b}/${nm}`,
      key: `${CACHE_ORIGIN}/live/point/${a}/${b}/${nm}` };
  }
  m = /^\/data\/traces\/([0-9a-f]{2})\/trace_(full|recent)_(~?[0-9a-f]{6})\.json$/.exec(p);
  if (m) {
    if (!m[3].endsWith(m[1])) return { error: 'bad trace path', status: 400 };
    return { route: 'trace', ttl: m[2] === 'full' ? 60 : 10, upstream: `https://adsb.lol${p}`,
      key: `${CACHE_ORIGIN}/live/trace/${m[2]}/${m[3]}` };
  }
  return null;
}

// ---------------------------------------------------------------- CORS
export const DEFAULT_ALLOWED_ORIGINS = [
  'https://overhead.pages.dev', 'https://*.overhead.pages.dev', // production Pages project + its preview deployments
  'http://localhost:8000', 'http://127.0.0.1:8000', 'http://localhost:8080', 'http://127.0.0.1:8080',
  'http://localhost:8788', 'http://127.0.0.1:8788', // wrangler pages dev
  'http://localhost:8765', 'http://127.0.0.1:8765', 'http://localhost:8766', 'http://127.0.0.1:8766', // lane dev servers
].join(',');

/** Value for Access-Control-Allow-Origin, or null (header omitted -> browser blocks). Supports "https://*.x.dev". */
export function allowOrigin(origin, allowedCsv) {
  const list = (allowedCsv || DEFAULT_ALLOWED_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*')) return '*';
  if (!origin) return null;
  for (const a of list) {
    if (a === origin) return origin;
    const w = /^(https?:\/\/)\*\.(.+)$/.exec(a);
    if (w && origin.startsWith(w[1]) && origin.endsWith('.' + w[2]) && /^[a-z0-9.-]+$/i.test(origin.slice(w[1].length, -w[2].length - 1))) return origin;
  }
  return null;
}

// ---------------------------------------------------------------- rate limits
// Per client IP.  Budgets are per period (s).  A historical search uses ~10-20 tile/index requests; the generic
// path (range) can use hundreds, so it gets the most, and clients must honour 429 + Retry-After (adsb.js does).
// Live: the app polls /v2/point every 5 s (12/min) plus a few trace fetches.
export const LIMITS = {
  tile: { limit: 240, period: 60, binding: 'RL_TILE' },
  index: { limit: 240, period: 60, binding: 'RL_TILE' },
  range: { limit: 600, period: 60, binding: 'RL_RANGE' },
  point: { limit: 30, period: 60, binding: 'RL_LIVE' },
  trace: { limit: 60, period: 60, binding: 'RL_TRACE' },
};

/**
 * In-isolate token bucket (fallback when the Workers Rate Limiting binding is absent, e.g. older wrangler or tests).
 * Per-isolate only, so it is a soft limit: Cloudflare runs many isolates.  The binding is the real limiter.
 */
export class TokenBuckets {
  constructor({ maxKeys = 10000, now = () => Date.now() } = {}) { this.m = new Map(); this.maxKeys = maxKeys; this.now = now; }

  /** @returns {{ok: boolean, retryAfterS: number}} */
  take(key, limit, periodS) {
    const t = this.now() / 1000, rate = limit / periodS;
    let b = this.m.get(key);
    if (!b) {
      if (this.m.size >= this.maxKeys) this.m.delete(this.m.keys().next().value); // bounded memory
      b = { tokens: limit, t };
    } else this.m.delete(key);
    b.tokens = Math.min(limit, b.tokens + (t - b.t) * rate);
    b.t = t;
    this.m.set(key, b);
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true, retryAfterS: 0 }; }
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((1 - b.tokens) / rate)) };
  }
}

/**
 * Both limiters must agree: the in-isolate bucket always runs (cheap; exact Retry-After; works when the binding is
 * missing, misconfigured or permissive as in local dev), and the Rate Limiting binding, if configured, adds the
 * cross-isolate per-colo limit.  Returns {ok, retryAfterS}.
 */
export async function checkLimit(env, buckets, route, ip) {
  const L = LIMITS[route];
  if (!L) return { ok: true, retryAfterS: 0 };
  const local = buckets.take(`${route}:${ip}`, L.limit, L.period);
  if (!local.ok) return local;
  const rl = env?.[L.binding];
  if (rl && typeof rl.limit === 'function') {
    try {
      const { success } = await rl.limit({ key: `${route}:${ip}` });
      if (!success) return { ok: false, retryAfterS: L.period === 10 ? 10 : 30 };
    } catch { /* binding error: the local bucket already allowed it */ }
  }
  return local;
}

/** Rate-limit key: IPv4 as is, IPv6 reduced to its /64 (one subscriber usually owns a whole /64). */
export function clientKey(ip) {
  if (!ip.includes(':')) return ip;
  let [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
