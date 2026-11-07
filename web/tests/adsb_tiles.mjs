// Fast-path latency: fetchTracksFromTiles through a running Worker (wrangler dev or deployed).
//   node web/tests/adsb_tiles.mjs http://127.0.0.1:8787
// Compares with the Python fixture (non-jet tracks, same bbox/window).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTracksFromTiles } from '../engine/adsb.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const W = process.argv[2] || 'http://127.0.0.1:8787';
const CASES = [['lell_20261101', 'tracks'], ['colsto_longisland', 'tracks_2026']];
for (const [c, tr] of CASES) {
  const info = JSON.parse(readFileSync(path.join(ROOT, `fixtures/real/${c}/${tr}.info.json`), 'utf8'));
  const ref = JSON.parse(readFileSync(path.join(ROOT, `fixtures/real/${c}/${tr}.json`), 'utf8')).filter((t) => t.category !== 'jet');
  for (const run of ['cold', 'warm']) {
    const t = performance.now();
    const out = await fetchTracksFromTiles({ worker: W, bbox: info.bbox, t0: info.t0, t1: info.t1 });
    const ms = performance.now() - t;
    const np = (a) => a.reduce((s, x) => s + x.points.length, 0);
    console.log(`${c} ${run}: ${out.length} tracks / ${np(out)} pts in ${ms.toFixed(0)} ms (missing tiles: ${out.missing.length});` +
      ` Python non-jet: ${ref.length} tracks / ${np(ref)} pts, aircraft ${new Set(out.map((x) => x.icao24)).size} vs ${new Set(ref.map((x) => x.icao24)).size}`);
  }
}
