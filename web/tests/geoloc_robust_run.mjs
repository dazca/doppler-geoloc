// Lane D (D7): robustness variants of scenario1 (those of ref/scripts/robustness.py), faithful vs robust mode.
// node web/tests/geoloc_robust_run.mjs [faithful|robust|both] [filter-substring]
import { loadScenario, horizErr, readJson } from './geoloc_helpers.mjs';
import { runSearchCore } from '../engine/geoloc/search.js';
import { trackRidgeRef, fitStraight, eventFromFit } from '../engine/geoloc/fit.js';

export function autoEvents(sc) {
  return sc.events.map((ev) => {
    const r = trackRidgeRef(sc.Z, sc.spec, ev.t_cpa_audio, ev.F0);
    return eventFromFit(fitStraight(r.t, r.f, { weights: r.s }));
  });
}

export function variants(sc) {
  const tru = sc.truth, V = readJson('fixtures/golden_js/robust_variants_scenario1.json');
  const dur1 = tru.events[0].t_cpa_audio + 150.0;
  const strip = (evs) => evs.map(({ _point_estimates, ...e }) => e);
  return [
    { label: 'baseline (human-measured events)', events: sc.events },
    { label: 'auto events (ridge + LSQ fit)', events: autoEvents(sc) },
    { label: 'one event only (clip cut)', events: sc.events.slice(0, 1), duration: dur1 },
    { label: 'one event + T_start known +-2 s', events: sc.events.slice(0, 1), duration: dur1, cfg: { t_start_prior: [tru.t_start_unix + 1.3, 2.0] } },
    { label: 'no v/d filter (offset+silence only)', events: sc.events, cfg: { use_vd_filter: false } },
    { label: 'measured t err +-6 s', events: strip(V['measured t err +-6 s']) },
    { label: 'measured t err +-10 s', events: strip(V['measured t err +-10 s']) },
    { label: 'measured v err +-30%, d err +-60%', events: strip(V['measured v err +-30%, d err +-60%']) },
    { label: 'event-0 CPA range wrong (excludes truth)', events: strip(V['event-0 CPA range wrong (excludes truth)']) },
    { label: 'measured t err +-10 s, t from ridge fit', events: strip(V['measured t err +-10 s']).map((e, i) => ({ ...e, t_cpa_audio: autoEvents(sc)[i].t_cpa_audio })) },
  ];
}

export async function runVariant(sc, v, mode, exec) {
  const dem = async (lat, lon) => sc.dem(lat, lon);
  const t0 = performance.now();
  const r = await runSearchCore(sc.tracks, dem, v.events, sc.Z, sc.spec, sc.enu, sc.center, v.duration ?? sc.duration, { mode, ...(v.cfg || {}) }, { exec });
  const el = performance.now() - t0;
  const b = r.best, tf = sc.truth.events.slice(0, v.events.length).map((e) => e.flight);
  if (!b) return { variant: v.label, mode, err_m: 'FAIL', n_surv: r.n_surv, time_ms: Math.round(el) };
  return { variant: v.label, mode, err_m: Math.round(horizErr(sc, b.lat, b.lon)), ok_flights: b.flights.join() === tf.join(),
    n_surv: r.n_surv, score: +b.score.toFixed(3), margin: r.margin == null ? null : +r.margin.toFixed(3),
    dT_start_s: +(b.t_start_unix - sc.truth.t_start_unix).toFixed(2), time_ms: Math.round(el) };
}

if (process.argv[1]?.endsWith("geoloc_robust_run.mjs")) {
  const arg = process.argv[2] || 'both', filt = process.argv[3] || '';
  const sc = loadScenario('scenario1');
  const rows = [];
  for (const v of variants(sc)) {
    if (filt && !v.label.includes(filt)) continue;
    for (const mode of arg === 'both' ? ['faithful', 'robust'] : [arg]) {
      const row = await runVariant(sc, v, mode);
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
}
