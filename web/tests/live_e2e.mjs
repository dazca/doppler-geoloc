// Lane L end-to-end check: REAL live tracks (from live_poll.mjs) + a synthetic clip of one pass -> runSearch with
// T_start known (one event), vs T_start biased by +2 s (ADS-B latency) and vs T_start unknown.
//   TRACKS=<dir>/live_tracks_trace.json node web/tests/live_e2e.mjs      (env WORKERS=2, NOISE=0.5)
import { readFileSync } from 'node:fs';
import { simulateCurves, referenceSpectrogram, fitEvent, runSearch } from '../engine/geoloc.js';
import { trackRidge } from '../engine/ridge.js';
import { liveSearchInput } from '../live/session.js';

const tracks = JSON.parse(readFileSync(process.env.TRACKS));
const WORKERS = +(process.env.WORKERS ?? 2), NOISE = +(process.env.NOISE ?? 0.5);
const ELEV = 100, FS = 8000, DUR = 240;

// pick the lowest-flying non-jet track with >= 4 min of points below 1500 m MSL (fallback: any category)
const lowSpan = (t) => { const p = t.points.filter((q) => q[3] < 1500 && q[3] > ELEV + 150); return p.length > 10 ? [p, p.at(-1)[0] - p[0][0]] : [p, 0]; };
const pick = (cats) => tracks.filter((t) => cats.includes(t.category)).map((t) => [t, ...lowSpan(t)]).filter((x) => x[2] >= 240)
  .sort((a, b) => Math.min(...a[1].map((q) => q[3])) - Math.min(...b[1].map((q) => q[3])))[0];
const sel = pick(['prop', 'heli', 'unknown']) || pick(['jet']);
if (!sel) { console.log('no suitable low track in', tracks.length); process.exit(1); }
const [trk, lowPts] = sel;
const mid = lowPts[Math.floor(lowPts.length / 2)], nxt = lowPts[Math.min(lowPts.length - 1, Math.floor(lowPts.length / 2) + 3)];
// observer 700 m to the right of the track at its mid low point
const k = Math.cos(mid[1] * Math.PI / 180);
const e = (nxt[2] - mid[2]) * 111320 * k, n = (nxt[1] - mid[1]) * 111320, L = Math.hypot(e, n) || 1;
const obs = { lat: mid[1] + (-e / L) * 700 / 111320, lon: mid[2] + (n / L) * 700 / (111320 * k) };
const cls = trk.category === 'unknown' ? 'prop' : trk.category;
const F0 = cls === 'heli' ? 22 : cls === 'jet' ? 180 : 95;
const T = mid[0] - 110 + 0.37; // true T_start
console.log('pass:', { id: trk.id, type: trk.type, category: trk.category, alt_mid_m: mid[3], obs, T_start: T, n_tracks: tracks.length });

// synthesize: harmonics 1..3 along the exact simulated Doppler curve + white noise
const cand = { lat: obs.lat, lon: obs.lon, elev_m: ELEV, t_start_unix: T, flights: [trk.id] };
const curves = await simulateCurves(cand, { events: [{ t_cpa_audio: 0, F0 }], tracks, harmonics: [1, 2, 3] });
const x = new Float32Array(FS * DUR);
let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
for (let i = 0; i < x.length; i++) x[i] = NOISE * Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
for (const c of curves) {
  const P = c.points; if (P.length < 2) continue;
  let ph = 0, j = 0;
  for (let i = Math.max(0, Math.ceil(P[0][0] * FS)); i < Math.min(x.length, P.at(-1)[0] * FS); i++) {
    const t = i / FS; while (j < P.length - 2 && P[j + 1][0] < t) j++;
    const f = P[j][1] + (P[j + 1][1] - P[j][1]) * (t - P[j][0]) / (P[j + 1][0] - P[j][0]);
    ph += 2 * Math.PI * f / FS; x[i] += (0.3 / c.harmonic) * Math.sin(ph);
  }
}
const h1 = curves.find((c) => c.harmonic === 1).points;
const tTrue = h1.reduce((b, p, i) => (i && Math.abs(p[1] - F0) < Math.abs(b[1] - F0) ? p : b), h1[0])[0];
console.log('synth: curve span', h1[0][0].toFixed(1), '-', h1.at(-1)[0].toFixed(1), 's, f=F0 at', tTrue.toFixed(1), 's');

const spec = await referenceSpectrogram(x, FS);
const rg = trackRidge(spec, { t: tTrue, f: F0 });
const pts = rg.points.map((p) => [p.t, p.f]);
const fit = await fitEvent(pts, { cls });
const ev = { t_cpa_audio: fit.t_cpa_audio, F0: fit.F0, v_mps: fit.v_mps, cpa_m: fit.cpa_m, cls, ridge: pts, t_sigma_s: fit.t_sigma_s };
console.log('event:', { n: pts.length, t_cpa: +fit.t_cpa_audio.toFixed(2), F0: +fit.F0.toFixed(2), v: +fit.point.v.toFixed(1), d: +fit.point.d.toFixed(0), poorly: fit.poorly_constrained });

const center = [obs.lat + 2000 / 111320, obs.lon - 1500 / (111320 * k)]; // search centre 2.5 km off the truth
const dem = (la) => la.map(() => ELEV);
const err = (b) => Math.hypot((b.lat - obs.lat) * 111320, (b.lon - obs.lon) * 111320 * k);
for (const [label, Tguess, tol] of [['T_start known (exact), +-3 s', T, 3], ['T_start biased +2 s, +-3 s', T + 2, 3],
  ['T_start unknown (+-600 s)', T, 600]]) {
  const input = liveSearchInput({ events: [ev], tracks, center, regionRadiusM: 6000, tStartUnix: Tguess, durationS: DUR, spec, tolS: tol,
    settings: { workers: WORKERS } });
  input.dem = dem;
  const t0 = performance.now();
  try {
    const r = await runSearch(input);
    const b = r.candidates[0];
    console.log(label.padEnd(30), b ? { err_m: Math.round(err(b)), flight_ok: b.flights[0] === trk.id, dT_start: +(b.t_start_unix - T).toFixed(2),
      margin: +(r.confidence?.margin ?? NaN).toFixed(3), ambiguous: r.confidence?.ambiguous, s: +((performance.now() - t0) / 1000).toFixed(1) } : 'no candidate');
  } catch (e2) { console.log(label, 'FAILED', e2.message); }
}
process.exit(0);
