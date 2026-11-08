// Offline tests for the Worker (no Cloudflare runtime needed): node --test worker/test/worker.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, allowOrigin, TokenBuckets, checkLimit, LIMITS, DEFAULT_ALLOWED_ORIGINS, signSession, verifySession,
  sessionMode, SESSION_TTL_S } from '../src/lib.js';
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

// ---------------------------------------------------------------- human sessions (Turnstile -> X-Doppler-Session)
const KEY = 'test-session-key-0123456789abcdef';
const APP = 'https://doppler.azemar.eu';
const tileEnv = (extra = {}) => ({ SESSION_MODE: 'enforce', SESSION_KEY: KEY, TURNSTILE_SECRET: 'ts-secret', ALLOWED_ORIGINS: `${APP},http://localhost:8000`,
  INDEX: { get: async () => ({ arrayBuffer: async () => new Uint8Array([31, 139]).buffer }) }, ...extra });
const tileReq = (sess, ip = '9.9.9.9', path = '/adsb/tile/2026-11-06/263364.json') => new Request(`https://w.example${path}`,
  { headers: { Origin: APP, 'CF-Connecting-IP': ip, ...(sess ? { 'X-Doppler-Session': sess } : {}) } });
/** fetch stub: siteverify answers `verdict`, everything else as stubs() */
function turnstileStub(verdict) {
  const s = stubs(), calls = [];
  const up = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (String(u).startsWith('https://challenges.cloudflare.com/')) { calls.push(Object.fromEntries(init.body)); return Response.json(verdict); }
    return up(u, init);
  };
  return { ...s, calls };
}
const postSession = (body, { origin = APP, ip = '9.9.9.9' } = {}) => new Request('https://w.example/session',
  { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': ip } });

test('session token: round trip, bound to the client IP key, expires, rejects tampering', async () => {
  const now = 1_800_000_000_000;
  const s = await signSession(KEY, { ip: '9.9.9.9', now });
  assert.equal(s.exp, now / 1000 + SESSION_TTL_S);
  assert.deepEqual(await verifySession(KEY, s.token, { ip: '9.9.9.9', now }), { ok: true, id: s.id, exp: s.exp });
  assert.equal((await verifySession(KEY, s.token, { ip: '8.8.8.8', now })).why, 'ip');
  assert.equal((await verifySession(KEY, s.token, { ip: '9.9.9.9', now: now + SESSION_TTL_S * 1000 })).why, 'expired');
  assert.equal((await verifySession('other-key', s.token, { ip: '9.9.9.9', now })).why, 'signature');
  // forge a payload with a later expiry / another IP but keep the signature
  const [v, , sig] = s.token.split('.');
  const forged = Buffer.from(JSON.stringify({ id: s.id, ip: '8.8.8.8', exp: s.exp + 1e6 })).toString('base64url');
  assert.equal((await verifySession(KEY, `${v}.${forged}.${sig}`, { ip: '8.8.8.8', now })).why, 'signature');
  // flip one signature character
  const flip = s.token.slice(0, -1) + (s.token.endsWith('A') ? 'B' : 'A');
  assert.equal((await verifySession(KEY, flip, { ip: '9.9.9.9', now })).ok, false);
  for (const junk of ['', 'abc', 'v1..x', `v2.${s.token.slice(3)}`, s.token + 'x']) assert.equal((await verifySession(KEY, junk, { ip: '9.9.9.9', now })).ok, false, junk);
  assert.deepEqual(['off', 'grace', 'enforce', 'off'].map((m, i) => sessionMode(i === 3 ? {} : { SESSION_MODE: m })), ['off', 'grace', 'enforce', 'off']);
});

test('POST /session: Turnstile verified (secret, token, remoteip; hostname + action checked) -> usable session', async () => {
  const { calls } = turnstileStub({ success: true, hostname: 'doppler.azemar.eu', action: 'session' });
  const lim = new TokenBuckets();
  const r = await handle(postSession({ token: 'tok-1' }), tileEnv(), undefined, lim);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), APP);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(calls, [{ secret: 'ts-secret', response: 'tok-1', remoteip: '9.9.9.9' }]);
  const { session, exp } = await r.json();
  assert.ok(exp > Date.now() / 1000);
  assert.equal((await handle(tileReq(session), tileEnv(), undefined, lim)).status, 200);
  assert.equal((await handle(tileReq(session, '7.7.7.7'), tileEnv(), undefined, lim)).status, 401, 'other IP');
});

test('POST /session: rejects failed / foreign-host / wrong-action tokens, bad origins, missing token, unconfigured', async () => {
  const lim = new TokenBuckets();
  turnstileStub({ success: false, 'error-codes': ['invalid-input-response'] });
  assert.equal((await handle(postSession({ token: 't' }), tileEnv(), undefined, lim)).status, 403);
  turnstileStub({ success: true, hostname: 'evil.example', action: 'session' });
  assert.equal((await handle(postSession({ token: 't' }), tileEnv(), undefined, lim)).status, 403);
  turnstileStub({ success: true, hostname: 'doppler.azemar.eu', action: 'login' });
  assert.equal((await handle(postSession({ token: 't' }), tileEnv(), undefined, lim)).status, 403);
  const { calls } = turnstileStub({ success: true, hostname: 'evil.example' });
  assert.equal((await handle(postSession({ token: 't' }, { origin: 'https://evil.example' }), tileEnv(), undefined, lim)).status, 403);
  assert.equal((await handle(postSession({}), tileEnv(), undefined, lim)).status, 400);
  assert.equal(calls.length, 0, 'no siteverify for a foreign origin or a missing token');
  assert.equal((await handle(postSession({ token: 't' }), tileEnv({ TURNSTILE_SECRET: '' }), undefined, lim)).status, 501);
  assert.equal((await handle(new Request('https://w.example/session'), tileEnv(), undefined, lim)).status, 405);
  // siteverify down -> 502 retryable
  stubs();
  globalThis.fetch = async () => { throw new TypeError('network'); };
  assert.equal((await handle(postSession({ token: 't' }), tileEnv(), undefined, lim)).status, 502);
});

test('POST /session is rate-limited per IP (10/min), before any siteverify', async () => {
  const { calls } = turnstileStub({ success: true, hostname: 'doppler.azemar.eu' });
  const lim = new TokenBuckets();
  for (let i = 0; i < LIMITS.session.limit; i++) assert.equal((await handle(postSession({ token: 't' }), tileEnv(), undefined, lim)).status, 200);
  assert.equal((await handle(postSession({ token: 't' }), tileEnv(), undefined, lim)).status, 429);
  assert.equal(calls.length, LIMITS.session.limit);
});

test('enforce: missing / tampered / expired session -> 401 code "session", even when the tile is already cached', async () => {
  const { store } = stubs();
  const lim = new TokenBuckets();
  const ok = (await signSession(KEY, { ip: '9.9.9.9' })).token;
  const warm = await handle(tileReq(ok), tileEnv(), undefined, lim);
  assert.equal(warm.status, 200);
  assert.equal(store.size, 1, 'tile now in the edge cache');
  const hit = await handle(tileReq(ok), tileEnv(), undefined, lim);
  assert.equal(hit.headers.get('X-Cache'), 'HIT');
  const expired = (await signSession(KEY, { ip: '9.9.9.9', now: Date.now() - (SESSION_TTL_S + 1) * 1000 })).token;
  for (const s of [null, ok.slice(0, -2) + 'xx', expired, (await signSession('k2', { ip: '9.9.9.9' })).token]) {
    const r = await handle(tileReq(s), tileEnv(), undefined, lim);
    assert.equal(r.status, 401, String(s));
    assert.equal((await r.json()).code, 'session');
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), APP, '401 readable by the app');
    assert.equal(r.headers.get('X-Cache'), null, 'never reached the cache');
  }
  // every gated route; the coverage manifest and /health stay open
  for (const p of [`/adsb/index/${TAG}/day.json`, `/adsb/range?tag=${TAG}&start=0&end=9`, '/v2/point/41.52/2.10/25', '/data/traces/ef/trace_full_abcdef.json'])
    assert.equal((await handle(tileReq(null, '9.9.9.9', p), tileEnv(), undefined, lim)).status, 401, p);
  assert.equal((await handle(tileReq(null, '9.9.9.9', '/adsb/index/meta/coverage.json'), tileEnv(), undefined, lim)).status, 200);
  assert.equal((await handle(tileReq(null, '9.9.9.9', '/health'), tileEnv(), undefined, lim)).status, 200);
  // enforce without a key fails closed
  assert.equal((await handle(tileReq(ok), tileEnv({ SESSION_KEY: '' }), undefined, lim)).status, 503);
});

test('grace allows a missing session but rejects a bad one; off ignores the header', async () => {
  stubs();
  const lim = new TokenBuckets();
  assert.equal((await handle(tileReq(null), tileEnv({ SESSION_MODE: 'grace' }), undefined, lim)).status, 200);
  assert.equal((await handle(tileReq('v1.x.y'), tileEnv({ SESSION_MODE: 'grace' }), undefined, lim)).status, 401);
  assert.equal((await handle(tileReq('v1.x.y'), tileEnv({ SESSION_MODE: 'off' }), undefined, lim)).status, 200);
  assert.equal((await handle(tileReq(null, '9.9.9.9', '/adsb/tile/2026-11-05/263364.json'), {}, undefined, lim)).status, 501, 'default env: off (no INDEX -> 501, not 401)');
});

test('per-session budget on top of per-IP (same limits, own key)', async () => {
  stubs();
  const calls = [];
  const env = tileEnv({ RL_TILE: { limit: async ({ key }) => { calls.push(key); return { success: true }; } } });
  const s = await signSession(KEY, { ip: '9.9.9.9' });
  await handle(tileReq(s.token), env, undefined, new TokenBuckets());
  assert.deepEqual(calls, ['tile:9.9.9.9', `tile:s:${s.id}`]);
  const lim = new TokenBuckets();
  for (let i = 0; i < LIMITS.tile.limit; i++) lim.take(`tile:s:${s.id}`, LIMITS.tile.limit, LIMITS.tile.period);
  const r = await handle(tileReq(s.token), tileEnv(), undefined, lim);
  assert.equal(r.status, 429);
});

test('CORS: preflight allows + exposes X-Doppler-Session and POST, cached a day', async () => {
  const r = await handle(new Request('https://w.example/adsb/tile/2026-11-06/263364.json', { method: 'OPTIONS', headers: { Origin: APP } }), tileEnv());
  assert.equal(r.status, 204);
  assert.match(r.headers.get('Access-Control-Allow-Headers'), /X-Doppler-Session/);
  assert.match(r.headers.get('Access-Control-Expose-Headers'), /X-Doppler-Session/);
  assert.match(r.headers.get('Access-Control-Allow-Methods'), /POST/);
  assert.equal(r.headers.get('Access-Control-Max-Age'), '86400');
});

test('range: GitHub 504 / network error retried in the Worker (3 attempts) before a 502 with Retry-After', async () => {
  const { RANGE_RETRY } = await import('../src/index.js');
  const saved = RANGE_RETRY.backoffMs;
  RANGE_RETRY.backoffMs = [0, 0];
  try {
    stubs();
    let n = 0;
    globalThis.fetch = async () => { n++; if (n === 1) throw new TypeError('reset'); if (n === 2) return new Response('gw', { status: 504 }); return new Response(new Uint8Array(10), { status: 206 }); };
    const go = (s) => handle(new Request(`https://w.example/adsb/range?tag=${TAG}&part=aa&start=${s}&end=${s + 9}`), {}, undefined, new TokenBuckets());
    const ok = await go(0);
    assert.deepEqual([ok.status, n], [200, 3]);
    n = 0;
    globalThis.fetch = async () => { n++; return new Response('gw', { status: 504 }); };
    const bad = await go(100);
    assert.deepEqual([bad.status, n, bad.headers.get('Retry-After')], [502, 3, '5']);
    n = 0;
    globalThis.fetch = async () => { n++; return new Response('', { status: 404 }); };
    assert.deepEqual([(await go(200)).status, n], [404, 1], '404 is final');
  } finally { RANGE_RETRY.backoffMs = saved; }
});
