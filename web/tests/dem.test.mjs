// Lane B DEM validation.  Run: node --test web/tests/dem.test.mjs
// Offline by default: Terrarium z12 tiles are served from fixtures/dem/terrarium (saved 2026-11-03).
// DEM_NETWORK=1 additionally runs the live tests against AWS (z12 + z13, a 50 km grid, cache timing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDem, decodePng, decodeTerrariumPixel, latLonToGlobalPixel } from '../engine/dem.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NET = process.env.DEM_NETWORK === '1';

// Offline fetch: maps tile URLs to fixtures/dem/terrarium/{z}/{x}/{y}.png
const localFetch = async (u) => {
  const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(u);
  const p = m && path.join(ROOT, 'fixtures/dem/terrarium', m[1], m[2], m[3] + '.png');
  return p && existsSync(p) ? new Response(readFileSync(p)) : new Response('', { status: 404 });
};

// Published summit heights (m MSL) + Copernicus GLO-30 sampled at the same points (rasterio /vsicurl, 2026-11-03).
// 30 m DEMs flatten sharp summits, so the tolerance vs. the published height is generous; vs. Copernicus it is tight.
const PTS = [
  { name: 'Tibidabo', lat: 41.42194, lon: 2.11861, h: 512, tol: 25, cop: 509.5 },
  { name: 'Montserrat Sant Jeroni', lat: 41.60500, lon: 1.81190, h: 1236, tol: 50, cop: 1200.2 },
  { name: 'Sabadell LELL (AIP 148 m)', lat: 41.5209, lon: 2.1050, h: 148, tol: 10, cop: 142.0 },
  { name: 'Sea off Barcelona', lat: 41.30, lon: 2.40, h: 0, tol: 5, cop: 0.0 },
];

test('terrarium decoding formula', () => {
  assert.equal(decodeTerrariumPixel(128, 0, 0), 0);
  assert.equal(decodeTerrariumPixel(129, 244, 128), 500.5);
});

test('pixel mapping: tile 0/0/0 centre', () => {
  const [x, y] = latLonToGlobalPixel(0, 0, 0);
  assert.ok(Math.abs(x - 127.5) < 1e-9 && Math.abs(y - 127.5) < 1e-9);
});

test('png decoder on a fixture tile', async () => {
  const img = await decodePng(readFileSync(path.join(ROOT, 'fixtures/dem/terrarium/12/2072/1529.png')));
  assert.equal(img.width, 256);
  assert.equal(img.height, 256);
  assert.equal(img.channels, 3);
});

test('offline: known elevations (z12 fixture tiles) vs published and Copernicus', async () => {
  const dem = createDem({ zoom: 12, fetch: localFetch });
  const h = await dem.elevations(PTS.map((p) => [p.lat, p.lon]));
  PTS.forEach((p, i) => {
    console.log(`    ${p.name}: ${h[i].toFixed(1)} m (published ${p.h}, Copernicus ${p.cop})`);
    assert.ok(Math.abs(h[i] - p.h) <= p.tol, `${p.name}: ${h[i]} vs ${p.h}`);
    assert.ok(Math.abs(h[i] - p.cop) < 5, `${p.name}: ${h[i]} vs Copernicus ${p.cop}`);
  });
  assert.equal(dem.stats.requests, 4);
});

test('live: z12/z13 + Aneto', { skip: !NET && 'set DEM_NETWORK=1' }, async () => {
  const pts = [...PTS, { name: 'Aneto', lat: 42.63111, lon: 0.65667, h: 3404, tol: 60 }];
  for (const zoom of [12, 13]) {
    const dem = createDem({ zoom });
    const h = await dem.elevations(pts.map((p) => [p.lat, p.lon]));
    pts.forEach((p, i) => assert.ok(Math.abs(h[i] - p.h) <= p.tol, `z${zoom} ${p.name}: ${h[i]}`));
  }
});

test('live: 50x50 km grid, 101x101 points, cache reuse', { skip: !NET && 'set DEM_NETWORK=1' }, async () => {
  const dem = createDem({ zoom: 12 });
  let t = performance.now();
  const g = await dem.grid(41.30, 1.80, 41.75, 2.40, 101, 101);
  const first = performance.now() - t;
  const n1 = dem.stats.requests;
  t = performance.now();
  await dem.grid(41.30, 1.80, 41.75, 2.40, 101, 101);
  assert.equal(dem.stats.requests, n1, 'second call must hit cache');
  let mx = -Infinity;
  for (const v of g.elev) mx = Math.max(mx, v);
  console.log(`    grid: ${n1} tiles, cold ${first.toFixed(0)} ms, cached ${(performance.now() - t).toFixed(0)} ms`);
  assert.ok(mx > 1000 && mx < 1400);
});

test('offline: transient tile failures are retried; persistent failure -> fallbackElevation or throw', async () => {
  let n = 0;
  const flaky = async (u) => { if (n++ < 2) throw new TypeError('fetch failed'); return localFetch(u); };
  const dem = createDem({ zoom: 12, fetch: flaky, sleep: async () => {} });
  const [h] = await dem.elevations([[PTS[0].lat, PTS[0].lon]]);
  assert.ok(Math.abs(h - PTS[0].cop) < 5);
  assert.equal(n, 3);
  const down = async () => { throw new TypeError('fetch failed'); };
  const flat = createDem({ zoom: 12, fetch: down, sleep: async () => {}, fallbackElevation: 0 });
  assert.equal((await flat.elevations([[41.4, 2.1]]))[0], 0);
  assert.equal(flat.stats.failedTiles.length, 1);
  const strict = createDem({ zoom: 12, fetch: down, sleep: async () => {}, retries: 1 });
  await assert.rejects(strict.elevations([[41.4, 2.1]]), /fetch failed/);
  const r503 = createDem({ zoom: 12, fetch: async () => new Response('', { status: 503 }), sleep: async () => {}, retries: 2 });
  await assert.rejects(r503.elevations([[41.4, 2.1]]), /HTTP 503/);
});
