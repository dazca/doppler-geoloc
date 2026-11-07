// Lane D (D11): absolute-verdict calibration over the synthetic scenarios through the public API.
// node web/tests/geoloc_verdict_run.mjs [--auto]
import { loadScenario, horizErr } from './geoloc_helpers.mjs';
import { SCENARIOS, autoEvents } from './geoloc_alias_run.mjs';
import * as Engine from '../engine/geoloc.js';
import { createGeolocPool, nodeWorkerFactory } from '../workers/geoloc-pool.js';

export function apiInput(sc, events) {
  const [la, lo] = sc.center, dLa = 12000 / 111000, dLo = 12000 / (111000 * Math.cos(la * Math.PI / 180));
  return { events: events.map(({ _point_estimates, ...e }) => ({ cls: 'prop', ...e })), silences: [],
    region: { shape: 'rect', center: sc.center, bbox: [la - dLa, lo - dLo, la + dLa, lo + dLo] },
    time: { t0: sc.truth.t_start_unix - 1800, t1: sc.truth.t_start_unix + 1800 }, duration_s: sc.duration,
    tracks: sc.tracksJson, spec: sc.spec, dem: sc.dem, types: sc.types, settings: { grid_m: 200, mode: 'robust' } };
}

if (process.argv[1]?.endsWith('geoloc_verdict_run.mjs')) {
  const auto = process.argv.includes('--auto');
  const exec = createGeolocPool({ size: 16, factory: await nodeWorkerFactory() });
  for (const name of SCENARIOS) {
    const sc = loadScenario(name);
    const res = await Engine.runSearch(apiInput(sc, auto ? autoEvents(sc) : sc.events), { exec });
    const b = res.candidates[0], a = res.confidence.absolute;
    console.log(`${name.padEnd(17)} err ${b ? Math.round(horizErr(sc, b.lat, b.lon)) : '-'} m  verdict ${a.verdict.padEnd(18)} z ${a.z} zmin ${a.z_min}  ridge ratio ${a.worst_ridge_ratio ?? '-'}  margin ${res.confidence.margin?.toFixed(3)} | ${a.events.map((e) => `z ${e.z} s ${e.score} null ${e.null_median}±${e.null_sigma}` + (e.ridge_ratio != null ? ` rr ${e.ridge_ratio} q ${e.ridge_q}` : '')).join(' ; ')}`);
  }
  exec.close();
}
