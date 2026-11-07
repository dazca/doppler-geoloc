// Lane D (D14): ADS-B gap at the CPA (robustness.py modify_tracks(gap_at_cpa_s)), gap model off vs on.
// node web/tests/geoloc_gap_run.mjs
import { loadScenario, horizErr, ROOT } from './geoloc_helpers.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { apiInput } from './geoloc_verdict_run.mjs';
import { autoEvents } from './geoloc_alias_run.mjs';
import * as Engine from '../engine/geoloc.js';
import { createGeolocPool, nodeWorkerFactory } from '../workers/geoloc-pool.js';

export function gapTracks(sc, gapS, tracks = sc.tracksJson) {
  const T0 = sc.truth.t_start_unix, ev = new Map(sc.truth.events.map((e) => [e.flight, e]));
  return tracks.map((t) => {
    const e = ev.get(t.id); if (!e || !gapS) return t;
    const tc = T0 + e.t_cpa_audio - e.cpa_m / 343, keep = t.points.map((p) => Math.abs(p[0] - tc) > gapS / 2);
    return { ...t, points: t.points.filter((_, i) => keep[i]), ...(t.vel ? { vel: t.vel.filter((_, i) => keep[i]) } : {}) };
  });
}

if (process.argv[1]?.endsWith('geoloc_gap_run.mjs')) {
  const exec = createGeolocPool({ size: 16, factory: await nodeWorkerFactory() });
  for (const name of ['scenario1', 'scenario2']) {
    const sc = loadScenario(name);
    const velTracks = JSON.parse(readFileSync(path.join(ROOT, `fixtures/golden_js/${name}_tracks_vel.json`)));
    const modes = process.argv.includes('--vel') ? [['vel', 20, true]] : [['off', 0, false], ['D14', 20, false], ['D15 vel', 20, true]];
    for (const gap of [0, 30, 60, 90]) for (const auto of [false, true]) for (const [lab, gapS, vel] of modes) {
      const inp = apiInput(sc, auto ? autoEvents(sc) : sc.events);
      inp.tracks = gapTracks(sc, gap, vel ? velTracks : sc.tracksJson); inp.settings = { ...inp.settings, gapS };
      const r = await Engine.runSearch(inp, { exec });
      const b = r.candidates[0], a = r.confidence.absolute;
      console.log(`${name} gap ${String(gap).padStart(2)} s ${auto ? 'auto ' : 'enter'} ${lab.padEnd(7)}: ${b ? horizErr(sc, b.lat, b.lon).toFixed(0).padStart(5) + ' m' : 'none'} verdict ${a.verdict.padEnd(18)} flights ${b?.flights.join('+')} | ${a.events.map((e) => `gap ${e.gap_fraction ?? e.curve_gap_fraction} rr ${e.ridge_ratio ?? '-'}`).join(' ; ')}`);
    }
  }
  exec.close();
}
