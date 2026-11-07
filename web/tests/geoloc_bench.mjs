// Lane D benchmark: per-stage times of the JS search, inline vs worker pool (Node worker_threads).
// node web/tests/geoloc_bench.mjs [sizes=1,4,8]
import { loadScenario, horizErr } from './geoloc_helpers.mjs';
import { runSearchCore } from '../engine/geoloc/search.js';
import { createGeolocPool, nodeWorkerFactory } from '../workers/geoloc-pool.js';
import { refSpectrogram, whiten } from '../engine/geoloc/spectro.js';

const sizes = (process.argv[2] || '0,4,8').split(',').map(Number);
const factory = await nodeWorkerFactory();
for (const name of ['scenario1', 'scenario2']) {
  const sc = loadScenario(name);
  let t = performance.now(); refSpectrogram(sc.samples, sc.fs); const tSpec = performance.now() - t;
  t = performance.now(); whiten(sc.spec); const tWh = performance.now() - t;
  console.log(`${name}: spectrogram ${tSpec.toFixed(0)} ms, whiten ${tWh.toFixed(0)} ms (${sc.spec.nT}x${sc.spec.nF})`);
  for (const mode of ['faithful', 'robust']) for (const W of sizes) {
    const exec = W ? createGeolocPool({ size: W, factory }) : undefined;
    const dem = async (a, b) => sc.dem(a, b);
    // warm-up once (JIT), then measure
    await runSearchCore(sc.tracks, dem, sc.events, sc.Z, sc.spec, sc.enu, sc.center, sc.duration, { mode }, { exec });
    t = performance.now();
    const r = await runSearchCore(sc.tracks, dem, sc.events, sc.Z, sc.spec, sc.enu, sc.center, sc.duration, { mode }, { exec });
    const el = performance.now() - t;
    exec?.close();
    const tm = Object.fromEntries(Object.entries(r.timings).map(([k, v]) => [k, Math.round(v)]));
    console.log(`  ${mode.padEnd(8)} ${W ? `pool x${W}` : 'inline '}: total ${el.toFixed(0)} ms  err ${horizErr(sc, r.best.lat, r.best.lon).toFixed(1)} m  score ${r.best.score.toFixed(4)}  surv ${r.n_surv}  ${JSON.stringify(tm)}`);
  }
}
