// Offline tests for the Worker (no Cloudflare runtime needed): node --test worker/test/worker.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, allowOrigin, TokenBuckets, checkLimit, LIMITS, DEFAULT_ALLOWED_ORIGINS } from '../src/lib.js';
import { handle } from '../src/index.js';

const U = (s) => new URL(s, 'https://w.example');
const TAG = 'v2026.11.01-planes-readsb-prod-0';

test('cache key: junk / reordered / duplicated params do not change the range key', () => {
  const base = parseRoute(U(`/adsb/range?tag=${TAG}&part=aa&start=2048&end=126155`)).key;
  for (const q of [`end=126155&start=2048&part=aa&tag=${TAG}`, `tag=${TAG}&part=aa&start=2048&end=126155&x=${Math.random()}`,
    `tag=${TAG}&start=2048&end=126155` /* part defaults to aa */, `tag=${TAG}&part=aa&start=2048&end=126155&cb=1&cb=2`]) {
    assert.equal(parseRoute(U(`/adsb/range?${q}`)).key, base, q);
  }
  assert.equal(base, `https://cache.internal/adsb/range/${TAG}/aa/2048-126155`);
  assert.notEqual(parseRoute(U(`/adsb/range?tag=${TAG}&part=ab&start=2048&end=126155`)).key, base);
  // tiles / index / live ignore the query string entirely; live positions are snapped to 0.05 deg
  assert.equal(parseRoute(U('/adsb/tile/2026-11-01/263364.json?z=9')).key, 'https://cache.internal/adsb/tile/2026-11-01/263364.json');
  assert.equal(parseRoute(U(`/adsb/index/${TAG}/day.json?a=b`)).r2key, `${TAG}/day.json`);
  assert.equal(parseRoute(U('/v2/point/41.5212/2.1049/25?r=1')).key, parseRoute(U('/v2/point/41.52/2.10/25')).key);
  assert.equal(parseRoute(U('/v2/point/41.52/2.10/999')).upstream, 'https://api.adsb.lol/v2/point/41.50/2.10/40');
});

test('route validation', () => {
  assert.equal(parseRoute(U('/adsb/range?tag=evil&start=0&end=1')).status, 400);
  assert.equal(parseRoute(U(`/adsb/range?tag=${TAG}&start=0&end=99999999`)).status, 413);
  assert.equal(parseRoute(U(`/adsb/range?tag=${TAG}&start=1e3&end=2000`)).status, 400);
  assert.equal(parseRoute(U(`/adsb/range?tag=${TAG}&start=5&end=4`)).status, 400);
  assert.equal(parseRoute(U('/adsb/tile/2026-11-01/../x.json')), null);
  assert.equal(parseRoute(U('/data/traces/3c/trace_full_abcdef.json')).status, 400); // hex must end with dir
  assert.equal(parseRoute(U('/other')), null);
});

test('CORS allow-list: default is not "*", wildcard preview subdomains, unknown origin gets no header', () => {
  assert.equal(allowOrigin('https://evil.example', undefined), null);
  assert.equal(allowOrigin('https://overhead.pages.dev', undefined), 'https://overhead.pages.dev');
  assert.equal(allowOrigin('https://abc123.overhead.pages.dev', undefined), 'https://abc123.overhead.pages.dev');
  assert.equal(allowOrigin('https://evil.com/.overhead.pages.dev', undefined), null);
  assert.equal(allowOrigin('https://x.evil-overhead.pages.dev', undefined), null);
  assert.equal(allowOrigin('http://localhost:8000', undefined), 'http://localhost:8000');
  assert.equal(allowOrigin('', undefined), null);
  assert.equal(allowOrigin('https://a.b', 'https://a.b,https://c.d'), 'https://a.b');
  assert.equal(allowOrigin('https://z', '*'), '*');
  assert.ok(!DEFAULT_ALLOWED_ORIGINS.split(',').includes('*'));
});

test('token bucket: burst up to limit, then 429 with Retry-After, refills over time, per key', () => {
  let now = 0;
  const b = new TokenBuckets({ now: () => now });
  for (let i = 0; i < 30; i++) assert.ok(b.take('ip1', 30, 60).ok);
  const r = b.take('ip1', 30, 60);
  assert.equal(r.ok, false);
  assert.equal(r.retryAfterS, 2); // 0.5 token/s -> 2 s for the next one
  assert.ok(b.take('ip2', 30, 60).ok, 'other IPs unaffected');
  now = 2000;
  assert.ok(b.take('ip1', 30, 60).ok);
  assert.equal(b.take('ip1', 30, 60).ok, false);
  const small = new TokenBuckets({ maxKeys: 2 });
  small.take('a', 1, 60); small.take('b', 1, 60); small.take('c', 1, 60);
  assert.equal(small.m.size, 2, 'bounded memory');
});

test('checkLimit uses the binding when present, falls back to the bucket otherwise', async () => {
  const calls = [];
  const env = { RL_LIVE: { limit: async ({ key }) => { calls.push(key); return { success: false }; } } };
  const r = await checkLimit(env, new TokenBuckets(), 'point', '1.2.3.4');
  assert.deepEqual([r.ok, calls], [false, ['point:1.2.3.4']]);
  assert.ok(r.retryAfterS > 0);
  const b = new TokenBuckets();
  for (let i = 0; i < LIMITS.point.limit; i++) assert.ok((await checkLimit({}, b, 'point', 'x')).ok);
  assert.equal((await checkLimit({}, b, 'point', 'x')).ok, false);
});

// ---------------------------------------------------------------- handler, with stubbed caches + fetch
function stubs() {
  const store = new Map(), upstream = [];
  globalThis.caches = { default: {
    match: async (k) => store.get(k.url)?.clone() ?? null,
    put: async (k, r) => { store.set(k.url, r); },
  } };
  globalThis.fetch = async (u, init) => {
    upstream.push([String(u), init?.headers?.Range]);
    return new Response(new Uint8Array(10), { status: 206 });
  };
  return { store, upstream };
}

test('handler: random params hit the same cache entry (one upstream fetch), CORS for allowed origin only', async () => {
  const { upstream, store } = stubs();
  const env = {};
  const lim = new TokenBuckets();
  const req = (q, origin = 'http://localhost:8000') => new Request(`https://w.example/adsb/range?${q}`, { headers: { Origin: origin, 'CF-Connecting-IP': '9.9.9.9' } });
  const r1 = await handle(req(`tag=${TAG}&part=aa&start=0&end=9`), env, undefined, lim);
  const r2 = await handle(req(`x=1&end=9&start=0&tag=${TAG}`), env, undefined, lim);
  const r3 = await handle(req(`tag=${TAG}&part=aa&start=0&end=9&cb=${Math.random()}`, 'https://evil.example'), env, undefined, lim);
  assert.deepEqual([r1.status, r2.status, r3.status], [200, 200, 200]);
  assert.equal(upstream.length, 1, 'only the first request goes upstream');
  assert.deepEqual([r1.headers.get('X-Cache'), r2.headers.get('X-Cache')], ['MISS', 'HIT']);
  assert.equal(r1.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8000');
  assert.equal(r3.headers.get('Access-Control-Allow-Origin'), null);
  assert.deepEqual([...store.keys()], [`https://cache.internal/adsb/range/${TAG}/aa/0-9`]);
});

test('handler: per-IP 429 with Retry-After on the live route', async () => {
  stubs();
  const lim = new TokenBuckets();
  const go = (ip) => handle(new Request('https://w.example/v2/point/41.52/2.10/25', { headers: { 'CF-Connecting-IP': ip } }), {}, undefined, lim);
  for (let i = 0; i < LIMITS.point.limit; i++) assert.equal((await go('1.1.1.1')).status, 200);
  const r = await go('1.1.1.1');
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('Retry-After')) >= 1);
  assert.equal((await go('2.2.2.2')).status, 200);
});

test('coverage manifest: own route, read from R2 meta/coverage.json, short cache TTL; other meta/* keys rejected', async () => {
  const r = parseRoute(U('/adsb/index/meta/coverage.json?x=1'));
  assert.equal(r.route, 'index');
  assert.equal(r.r2key, 'meta/coverage.json');
  assert.equal(parseRoute(U('/adsb/index/meta/other.json')).status, 400);
  stubs();
  const body = JSON.stringify({ days: ['2026-11-05'], from: '2026-11-05', to: '2026-11-05' });
  const env = { INDEX: { get: async (k) => (k === 'meta/coverage.json' ? { arrayBuffer: async () => new TextEncoder().encode(body).buffer } : null) } };
  const res = await handle(new Request('https://w.example/adsb/index/meta/coverage.json'), env, undefined, new TokenBuckets());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60');
  assert.deepEqual(await res.json(), JSON.parse(body));
});

test('IPv6 clients share one rate-limit key per /64', async () => {
  const { clientKey } = await import('../src/lib.js');
  assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:db8:1:2:ffff:1:2:3'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(clientKey('2001:0db8:0001:0002::9'), '2001:db8:1:2::/64');
});

test('IPv6 with an embedded IPv4 (mapped / NAT64) is keyed by the IPv4', async () => {
  const { clientKey } = await import('../src/lib.js');
  assert.equal(clientKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(clientKey('64:ff9b::198.51.100.9'), '198.51.100.9');
  assert.equal(clientKey('::FFFF:203.0.113.1'), '203.0.113.1');
});

test('handler: upstream / R2 throwing -> 502 with CORS + Retry-After (not an opaque 500)', async () => {
  stubs();
  globalThis.fetch = async () => { throw new TypeError('network down'); };
  const o = { Origin: 'http://localhost:8000', 'CF-Connecting-IP': '5.5.5.5' };
  const r1 = await handle(new Request(`https://w.example/adsb/range?tag=${TAG}&start=0&end=9`, { headers: o }), {}, undefined, new TokenBuckets());
  const env = { INDEX: { get: async () => { throw new Error('R2 down'); } } };
  const r2 = await handle(new Request('https://w.example/adsb/tile/2026-11-01/263364.json', { headers: o }), env, undefined, new TokenBuckets());
  for (const r of [r1, r2]) {
    assert.equal(r.status, 502);
    assert.equal(r.headers.get('Retry-After'), '5');
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8000');
    assert.deepEqual(await r.json(), { error: 'upstream error' });
  }
});

test('handler: R2 404 is cached 300 s (one R2 read); coverage 404 stays <= 60 s; 200 carries ODbL Link + X-Source', async () => {
  const { store } = stubs();
  let reads = 0;
  const tile = new TextEncoder().encode('{}').buffer;
  const env = { INDEX: { get: async (k) => { reads++; return k === 'tiles/2026-11-01/263364.json.gz' ? { arrayBuffer: async () => tile } : null; } } };
  const go = (p) => handle(new Request(`https://w.example${p}`, { headers: { Origin: 'https://doppler.azemar.eu' } }),
    { ...env, ALLOWED_ORIGINS: 'https://doppler.azemar.eu' }, undefined, new TokenBuckets());
  const a = await go('/adsb/tile/2026-11-02/263364.json'), b = await go('/adsb/tile/2026-11-02/263364.json');
  assert.deepEqual([a.status, b.status, reads], [404, 404, 1]);
  assert.deepEqual([a.headers.get('X-Cache'), b.headers.get('X-Cache')], ['MISS', 'HIT']);
  assert.equal(a.headers.get('Cache-Control'), 'public, max-age=300');
  assert.equal(b.headers.get('Access-Control-Allow-Origin'), 'https://doppler.azemar.eu');
  const c = await go('/adsb/index/meta/coverage.json');
  assert.deepEqual([c.status, c.headers.get('Cache-Control')], [404, 'public, max-age=60']);
  const ok = await go('/adsb/tile/2026-11-01/263364.json');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Cache-Control'), 'public, max-age=86400');
  assert.equal(ok.headers.get('Link'), '<https://opendatacommons.org/licenses/odbl/1-0/>; rel="license"');
  assert.equal(ok.headers.get('X-Source'), 'adsb.lol');
  assert.match(ok.headers.get('Access-Control-Expose-Headers'), /Link, X-Source/);
  assert.ok(store.has('https://cache.internal/adsb/tile/2026-11-02/263364.json'));
  // a stored copy whose Cache-Control was rewritten by the zone (Browser Cache TTL) and that predates the ODbL headers
  store.set('https://cache.internal/adsb/index/meta/coverage.json', new Response('{}', { headers: { 'Cache-Control': 'public, max-age=14400' } }));
  const cov = await go('/adsb/index/meta/coverage.json');
  assert.deepEqual([cov.headers.get('X-Cache'), cov.headers.get('Cache-Control'), cov.headers.get('X-Source')], ['HIT', 'public, max-age=60', 'adsb.lol']);
  store.set('https://cache.internal/adsb/tile/2026-11-03/263364.json', new Response('x', { status: 404, headers: { 'Cache-Control': 'public, max-age=14400' } }));
  assert.equal((await go('/adsb/tile/2026-11-03/263364.json')).headers.get('Cache-Control'), 'public, max-age=300');
});

test('handler: upstream errors on non-R2 routes are still not cached', async () => {
  const { store } = stubs();
  globalThis.fetch = async () => new Response('x', { status: 404 });
  const r = await handle(new Request(`https://w.example/adsb/range?tag=${TAG}&start=0&end=9`), {}, undefined, new TokenBuckets());
  assert.equal(r.status, 404);
  assert.equal(store.size, 0);
});

test('range: neighbouring-year repo and -0tmp/-1 tags (review F1)', async () => {
  const D31 = 'v2025.12.31-planes-readsb-prod-0tmp';
  const r = parseRoute(U(`/adsb/range?tag=${D31}&part=aa&start=0&end=9&repo=2026`));
  assert.equal(r.year, '2026');
  assert.equal(r.key, `https://cache.internal/adsb/range/r2026/${D31}/aa/0-9`);
  // repo equal to the tag year: same key as without repo (old cache entries stay valid)
  assert.equal(parseRoute(U(`/adsb/range?tag=${TAG}&start=0&end=9&repo=2026`)).key, parseRoute(U(`/adsb/range?tag=${TAG}&start=0&end=9`)).key);
  assert.equal(parseRoute(U(`/adsb/range?tag=v2026.11.01-planes-readsb-prod-1&start=0&end=9`)).year, '2026');
  assert.equal(parseRoute(U(`/adsb/range?tag=${TAG}&start=0&end=9&repo=2030`)).status, 400);
  assert.equal(parseRoute(U(`/adsb/range?tag=${TAG}&start=0&end=9&repo=26`)).status, 400);
  assert.equal(parseRoute(U(`/adsb/range?tag=${TAG}&start=0&end=9&repo=`)).status, 400);
  assert.equal(parseRoute(U('/adsb/range?tag=v2026.11.01-planes-readsb-prod-1tmp&start=0&end=9')).status, 400);
  assert.equal(parseRoute(U(`/adsb/index/${D31}/day.json`)).r2key, `${D31}/day.json`);
  const { upstream } = stubs();
  const res = await handle(new Request(`https://w.example/adsb/range?tag=${D31}&part=aa&start=0&end=9&repo=2026`), {}, undefined, new TokenBuckets());
  assert.equal(res.status, 200);
  assert.equal(upstream[0][0], `https://github.com/adsblol/globe_history_2026/releases/download/${D31}/${D31}.tar.aa`);
});
