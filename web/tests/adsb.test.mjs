// Lane B offline tests for web/engine/adsb.js (no network): coverage, retries, missing/partial days.
// Run: node --test web/tests/adsb.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverage, coverageVerdict, fetchRetry, fetchTracks, fetchTracksFromTiles, fetchDayStatus, cellsForBbox } from '../engine/adsb.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const noSleep = { sleep: async () => {} };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

test('coverage on the LELL fixture matches Python (47 tracks / 21 aircraft within 5 km)', () => {
  const tracks = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/real/lell_20261101/tracks.json'), 'utf8'));
  const t0 = Date.UTC(2026, 10, 1, 7) / 1000;
  const cov = coverage(tracks, { t0, t1: t0 + 8 * 3600, center: [41.5209, 2.105], radiusKm: 5 });
  assert.equal(cov.n_tracks, 47);
  assert.equal(cov.n_aircraft, 21);
  assert.equal(cov.per_bin.length, 8);
  assert.equal(coverageVerdict(cov).level, 'ok');
});

test('coverageVerdict: zero light aircraft, low vs baseline, partial day', () => {
  const empty = coverage([], { t0: 0, t1: 3600, center: [41.5, 2.1], radiusKm: 5 });
  const v = coverageVerdict(empty);
  assert.equal(v.level, 'poor');
  assert.match(v.messages[0], /0 aircraft received within 5 km/);
  assert.match(v.messages[0], /without ADS-B/);
  const one = { ...empty, n_tracks: 10, n_aircraft: 3, tracks_per_h: 10 };
  assert.equal(coverageVerdict(one, { baseline: [{ n_aircraft: 20 }, { n_aircraft: 15 }, { n_aircraft: 30 }] }).level, 'poor');
  assert.equal(coverageVerdict(one, { days: [{ day: 'd', feed: 'prod', status: 'partial' }] }).level, 'poor');
  const m = coverageVerdict(one, { days: [{ day: 'd', feed: 'mlatonly', status: 'missing' }] });
  assert.equal(m.level, 'ok');
  assert.equal(m.messages.length, 1);
});

test('coverageVerdict uses per-hour rates (Egelsbach 2023-09-12: 4 aircraft in 4.5 h is poor)', () => {
  const mk = (n, hours) => coverage(Array.from({ length: n }, (_, i) => ({ id: `a${i}`, icao24: `a${i}`, category: 'prop',
    points: [[60 + i * 60, 41.52, 2.105, 300]] })), { t0: 0, t1: hours * 3600, center: [41.52, 2.105], radiusKm: 5 });
  assert.equal(coverageVerdict(mk(4, 4.5)).level, 'poor');
  assert.equal(coverageVerdict(mk(4, 2)).level, 'weak');
  assert.equal(coverageVerdict(mk(6, 2)).level, 'weak');
  assert.equal(coverageVerdict(mk(7, 2)).level, 'ok');
});

test('fetchRetry retries network errors and 5xx, not 404', async () => {
  let n = 0;
  const flaky = async () => { n++; if (n < 3) throw new TypeError('fetch failed'); return new Response('ok'); };
  assert.equal(await (await fetchRetry(flaky, 'u', noSleep)).text(), 'ok');
  assert.equal(n, 3);
  n = 0;
  const r404 = async () => { n++; return new Response('', { status: 404 }); };
  assert.equal((await fetchRetry(r404, 'u', noSleep)).status, 404);
  assert.equal(n, 1);
  await assert.rejects(fetchRetry(async () => new Response('', { status: 503 }), 'u', { ...noSleep, retries: 2 }), /after 3 attempts/);
});

test('fetchTracksFromTiles: retried tile, partial day reported, missing tiles listed', async () => {
  const bbox = [41.2, 1.7, 41.9, 2.5];
  const t0 = Date.UTC(2026, 5, 11, 14) / 1000, t1 = t0 + 3600;
  const cells = cellsForBbox(bbox);
  let fails = 2;
  const f = async (u) => {
    if (u.includes('/day.json')) {
      return u.includes('prod') ? json({ day: '2026-06-11', feed: 'prod', status: 'partial', ratio: 0.59 })
        : json({ day: '2026-06-11', feed: 'mlatonly', status: 'empty' });
    }
    const cell = Number(u.match(/(\d+)\.json$/)[1]);
    if (cell === cells[0]) {
      if (fails-- > 0) throw new TypeError('fetch failed');
      return json({ tracks: [{ id: 'x', icao24: 'abc', callsign: null, type: 'C172', category: 'prop',
        points: [[t0 + 10, 41.3, 1.8, 300], [t0 + 20, 41.31, 1.8, 310]] }] });
    }
    return new Response('', { status: 404 });
  };
  const out = await fetchTracksFromTiles({ worker: 'w', bbox, t0, t1, fetch: f, retry: noSleep });
  assert.equal(out.length, 1);
  assert.equal(out.missing.length, cells.length - 1);
  assert.deepEqual(out.days.map((d) => d.status), ['partial', 'empty']);
  assert.ok(out.warnings.includes('2026-06-11 prod: partial'));
  assert.equal(coverageVerdict(coverage(out, { t0, t1 }), { days: out.days }).level, 'poor');
});

test('fetchTracks: no index for a feed (missing mlatonly release) is not fatal', async () => {
  const f = async (u) => (u.includes('day.json') && u.includes('mlatonly')
    ? json({ day: '2023-12-17', feed: 'mlatonly', status: 'missing' }) : new Response('', { status: 404 }));
  const t0 = Date.UTC(2023, 11, 17, 9) / 1000;
  const out = await fetchTracks({ worker: 'w', bbox: [41.2, 1.7, 41.9, 2.5], t0, t1: t0 + 3600, fetch: f, retry: noSleep });
  assert.equal(out.length, 0);
  assert.deepEqual(out.warnings, ['2023-12-17 mlatonly: missing']);
  const st = await fetchDayStatus({ worker: 'w', t0, t1: t0 + 3600, fetch: f });
  assert.deepEqual(st.map((d) => d.status), ['unknown', 'missing']);
});

test('fetchRetry honours Retry-After on 429 (Worker rate limit)', async () => {
  const waits = [];
  let n = 0;
  const f = async () => (n++ === 0 ? new Response('', { status: 429, headers: { 'Retry-After': '7' } }) : new Response('ok'));
  const r = await fetchRetry(f, 'u', { sleep: async (ms) => { waits.push(ms); } });
  assert.equal(await r.text(), 'ok');
  assert.deepEqual(waits, [7000]);
});

test('fetchTracks: unreachable server rejects with code "unreachable"; HTTP errors do not', async () => {
  const t0 = Date.UTC(2026, 10, 6, 14) / 1000;
  const q = { worker: 'w', bbox: [41.43, 1.98, 41.61, 2.22], t0, t1: t0 + 3600, retry: noSleep };
  const down = async () => { throw new TypeError('NetworkError when attempting to fetch resource.'); };
  await assert.rejects(fetchTracks({ ...q, fetch: down }), (e) => e.code === 'unreachable');
  const err500 = async () => new Response('', { status: 500 });
  const out = await fetchTracks({ ...q, fetch: err500 });
  assert.equal(out.length, 0);
  assert.ok(out.failed.length > 0);
});

test('fetchTracks: progress gets (done, total) and a throwing progress callback cannot fail the download', async () => {
  // regression 2026-11-07: frac NaN -> <progress>.value setter TypeError inside onProgress -> "server unreachable"
  const t0 = Date.UTC(2026, 10, 6, 14) / 1000;
  const f = async (u) => {
    if (u.includes('/adsb/index/') && u.includes('prod') && !u.includes('day.json')) {
      return json({ geoid_N: 50, traces: [['3464cd', 'P208', '', 0, 100, t0, t0 + 600, 1000]] });
    }
    return new Response('', { status: 404 });
  };
  const seen = [];
  const out = await fetchTracks({ worker: 'w', bbox: [41.5, 2.0, 41.51, 2.01], t0, t1: t0 + 3600, fetch: f, retry: noSleep,
    onProgress: (k, total) => { seen.push([k, total]); throw new TypeError('progress setter'); } });
  assert.deepEqual(seen, [[1, 1]]);
  assert.equal(out.failed.length, 1);
});

test('fetchRetry lets AbortError through without retrying', async () => {
  let n = 0;
  const f = async () => { n++; throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  await assert.rejects(fetchRetry(f, 'u', noSleep), (e) => e.name === 'AbortError');
  assert.equal(n, 1);
});

test('fetchTracks: range URL uses the shard release tag and repo (review F1)', async () => {
  const t0 = Date.UTC(2025, 11, 31, 14) / 1000;
  const urls = [];
  const f = async (u) => {
    urls.push(u);
    if (u.includes('/adsb/index/') && u.includes('prod') && !u.includes('day.json')) {
      return json({ geoid_N: 50, release: 'v2025.12.31-planes-readsb-prod-0tmp', repo: 'globe_history_2026',
        traces: [['3464cd', 'P208', 'aa', 0, 100, t0, t0 + 600, 1000]] });
    }
    return new Response('', { status: 404 });
  };
  await fetchTracks({ worker: 'w', bbox: [41.5, 2.0, 41.51, 2.01], t0, t1: t0 + 3600, fetch: f, retry: noSleep });
  const range = urls.filter((u) => u.includes('/adsb/range'));
  assert.deepEqual(range, ['w/adsb/range?tag=v2025.12.31-planes-readsb-prod-0tmp&part=aa&start=0&end=99&repo=2026']);
  assert.ok(urls.some((u) => u.includes('/adsb/index/v2025.12.31-planes-readsb-prod-0/')), 'index still uses the canonical tag');
});

test('rangeSource: repo only when it differs from the release year; bad values ignored', async () => {
  const { rangeSource } = await import('../engine/adsb.js');
  const T = 'v2026.11.01-planes-readsb-prod-0';
  assert.deepEqual(rangeSource(T, {}), { release: T, repo: undefined });
  assert.deepEqual(rangeSource(T, { release: 'v2026.11.01-planes-readsb-prod-1', repo: 'globe_history_2026' }),
    { release: 'v2026.11.01-planes-readsb-prod-1', repo: undefined });
  assert.deepEqual(rangeSource(T, { release: 'evil&x=1', repo: 'globe_history_x' }), { release: T, repo: undefined });
});
