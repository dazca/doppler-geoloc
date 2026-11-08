// Human session client (web/ui/data-session.js): one Turnstile check per page session, header only to the Worker.
// Run: node --test web/tests/data-session.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataSession, installDataSession, SESSION_HEADER, SessionError } from '../ui/data-session.js';

const W = 'https://doppler-data.azemar.eu';
const TILE = `${W}/adsb/tile/2026-11-06/263364.json`;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

/** Fake Worker: issues sessions s1, s2, ... and accepts only `valid` ones on data routes. */
function fakeWorker({ exp = () => Math.floor(Date.now() / 1000) + 7200, sessionStatus = 200 } = {}) {
  const log = [], valid = new Set();
  let n = 0;
  const f = async (u, init = {}) => {
    const url = new URL(u);
    const sess = new Headers(init.headers).get(SESSION_HEADER);
    log.push({ path: url.pathname, host: url.host, method: init.method || 'GET', sess, body: init.body });
    if (url.pathname === '/session') {
      if (sessionStatus !== 200) return json({ error: 'no' }, sessionStatus);
      const s = `s${++n}`; valid.add(s);
      return json({ session: s, exp: exp() });
    }
    if (url.origin !== W || ['/health', '/adsb/index/meta/coverage.json'].includes(url.pathname)) return json({ ok: true });
    return valid.has(sess) ? json({ tile: true }) : json({ error: 'session required', code: 'session' }, 401);
  };
  return { f, log, valid };
}

test('one Turnstile check + one /session for many concurrent data requests; header sent on each', async () => {
  const w = fakeWorker();
  let tokens = 0;
  const s = createDataSession({ origin: W, fetch: w.f, getToken: async () => `ts${++tokens}` });
  const rs = await Promise.all(Array.from({ length: 8 }, () => s.fetch(TILE)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(tokens, 1);
  const posts = w.log.filter((x) => x.path === '/session');
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body), { token: 'ts1' });
  assert.ok(w.log.filter((x) => x.path.startsWith('/adsb/tile')).every((x) => x.sess === 's1'));
  assert.equal(s.state, 'ok');
});

test('no session (and no Turnstile) for other origins, /health and the coverage manifest', async () => {
  const w = fakeWorker();
  let tokens = 0;
  const s = createDataSession({ origin: W, fetch: w.f, getToken: async () => `ts${++tokens}` });
  for (const u of ['https://my-proxy.example/adsb/tile/2026-11-06/1.json', `${W}/health`, `${W}/adsb/index/meta/coverage.json`, 'https://s3.amazonaws.com/x']) {
    assert.equal((await s.fetch(u)).status, 200, u);
  }
  assert.equal(tokens, 0);
  assert.ok(w.log.every((x) => x.sess === null), 'never leaks the session to another origin');
});

test('renews before expiry, and once on a 401 "session" answer (e.g. IP changed)', async () => {
  let t = 1_800_000_000_000;
  const w = fakeWorker({ exp: () => Math.floor(t / 1000) + 7200 });
  let tokens = 0;
  const s = createDataSession({ origin: W, fetch: w.f, getToken: async () => `ts${++tokens}`, now: () => t });
  await s.fetch(TILE);
  t += 7200_000 - 60_000; // 1 min before expiry: renew first
  assert.equal((await s.fetch(TILE)).status, 200);
  assert.equal(tokens, 2);
  w.valid.clear(); // server no longer accepts s2
  assert.equal((await s.fetch(TILE)).status, 200);
  assert.equal(tokens, 3);
  assert.equal(w.log.at(-1).sess, 's3');
});

test('a 401 that is not about the session, or a second 401, is returned as is (no loop)', async () => {
  let tokens = 0;
  const f = async (u) => (new URL(u).pathname === '/session' ? json({ session: `s${tokens}`, exp: 4e9 }) : json({ error: 'x', code: 'session' }, 401));
  const s = createDataSession({ origin: W, fetch: f, getToken: async () => `ts${++tokens}` });
  assert.equal((await s.fetch(TILE)).status, 401);
  assert.equal(tokens, 2, 'one renewal only');
});

test('verification failure: SessionError, UI notified once, later calls fail fast until retry()', async () => {
  const w = fakeWorker({ sessionStatus: 403 });
  const states = [];
  let tokens = 0;
  const s = createDataSession({ origin: W, fetch: w.f, getToken: async () => `ts${++tokens}`, onState: (st) => states.push(st) });
  await assert.rejects(s.fetch(TILE), (e) => e instanceof SessionError && e.code === 'session');
  await assert.rejects(s.fetch(TILE), SessionError);
  assert.equal(tokens, 1, 'no Turnstile storm while failed');
  assert.deepEqual(states, ['failed']);
  assert.equal(s.state, 'failed');
  // Turnstile itself failing (blocked script) is a SessionError too
  const s2 = createDataSession({ origin: W, fetch: w.f, getToken: async () => { throw new Error('turnstile blocked'); } });
  await assert.rejects(s2.fetch(TILE), /verification failed: turnstile blocked/);
  // retry() after the server recovers
  const ok = fakeWorker();
  let failNext = true;
  const s3 = createDataSession({ origin: W, fetch: (u, i) => (failNext ? w.f(u, i) : ok.f(u, i)), getToken: async () => 't', onState: (st) => states.push(st) });
  await assert.rejects(s3.fetch(TILE));
  failNext = false;
  await s3.retry();
  assert.equal((await s3.fetch(TILE)).status, 200);
  assert.deepEqual(states.slice(-2), ['failed', 'ok']);
});

test('installDataSession: off without a site key; with one it wraps the global fetch for the Worker origin only', async () => {
  const w = fakeWorker();
  const win = { fetch: w.f };
  assert.equal(installDataSession({ adsbWorker: W, turnstileSiteKey: '' }, { win }), null);
  assert.equal(win.fetch, w.f);
  assert.equal(installDataSession({ adsbWorker: '', turnstileSiteKey: 'k' }, { win }), null);
  const s = installDataSession({ adsbWorker: `${W}/`, turnstileSiteKey: '0x4AAAAAAAtest' }, { win });
  assert.ok(s);
  assert.notEqual(win.fetch, w.f);
  assert.equal((await win.fetch('https://elsewhere.example/x')).status, 200);
  assert.equal(w.log.at(-1).sess, null);
});
