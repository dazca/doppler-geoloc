// Retarded-time solver + exact Doppler + straight-line closed form. Port of ref/doppler_ref/doppler.py.
// u = unit vector source->observer at emission, v_r = v_s.u (>0 approaching), f = F0 c/(c - v_r).
import { evalTrack } from './track.js';

export const C_DEFAULT = 343.0;
export const AUDIBLE_R = { prop: 3000.0, heli: 3000.0, unknown: 3000.0, jet: 6000.0 };
export const speedOfSound = (T) => 331.3 * Math.sqrt(1.0 + T / 273.15);
export const audibleRadius = (cat, table = AUDIBLE_R) => table[cat] ?? table.unknown;

/** Robust-mode reach by engine type (ICAO Doc 8643 descriptor of the aircraft type, e.g. L1P piston, L2T turboprop).
 * Turboprops at altitude are heard much farther than pistons (colsto: PC-12 at 6.1 km, King Air 350 at 3.7 km). */
export const ENGINE_R = { piston: 4000, turboprop: 9000, heli: 4000, heli_turbine: 6000, jet: 6000, prop: 8000, unknown: 8000 };

/** Engine class from a Doc 8643 descriptor ('L1P', 'L2T', 'H1P', 'H2T', 'L2J', ...). */
export function engineOf(desc, category) {
  if (typeof desc === 'string' && desc.length >= 3) {
    const k = desc[0], e = desc[2];
    if (k === 'H') return e === 'T' ? 'heli_turbine' : 'heli';
    if (e === 'P') return 'piston';
    if (e === 'T') return 'turboprop';
    if (e === 'J') return 'jet';
  }
  return category === 'jet' ? 'jet' : category === 'heli' ? 'heli' : category === 'prop' ? 'prop' : 'unknown';
}

/** Reach (audible radius, m) of a built track under cfg: faithful = per category (3/6 km), robust = per engine type. */
export function trackRadius(t, cfg) {
  if (cfg.audible_engine) return cfg.audible_engine[t.engine || engineOf(null, t.category)] ?? audibleRadius(t.category, cfg.audible);
  return audibleRadius(t.category, cfg.audible);
}

/**
 * Emission time for one observer and one reception time. Newton, 4 iterations from t_e = t_rx - R(t_rx)/c.
 * Writes out[0]=t_e, out[1]=R, out[2]=v_r; returns valid (t_e inside the track span). buf: Float64Array(6) scratch.
 */
export function emissionTime(tr, ox, oy, oz, trx, c, out, buf = new Float64Array(6), nIter = 4) {
  evalTrack(tr, trx, buf);
  let te = trx - Math.hypot(ox - buf[0], oy - buf[1], oz - buf[2]) / c;
  for (let it = 0; it < nIter; it++) {
    evalTrack(tr, te, buf);
    const dx = ox - buf[0], dy = oy - buf[1], dz = oz - buf[2];
    const R = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const vr = (buf[3] * dx + buf[4] * dy + buf[5] * dz) / (R > 1e-9 ? R : 1e-9);
    te -= (te + R / c - trx) / (1.0 - vr / c);
  }
  const valid = evalTrack(tr, te, buf);
  const dx = ox - buf[0], dy = oy - buf[1], dz = oz - buf[2];
  const R = Math.sqrt(dx * dx + dy * dy + dz * dz);
  out[0] = te; out[1] = R; out[2] = (buf[3] * dx + buf[4] * dy + buf[5] * dz) / (R > 1e-9 ? R : 1e-9);
  return valid;
}

/** tau = t_e - t_c as a function of T = t_rx - t_c for a straight constant-speed pass. */
export function straightLineTe(T, v, d, c = C_DEFAULT) {
  const b2 = (v / c) ** 2;
  const S = Math.sqrt(b2 * T * T + (1 - b2) * (d / c) ** 2);
  return (T - S) / (1 - b2);
}

/** Exact received frequency for a straight constant-speed pass (MATH.md eq. 3.2). */
export function straightLineF(T, F0, v, d, c = C_DEFAULT) {
  const b = v / c, tau0 = d * Math.sqrt(1 - b * b) / v;
  return F0 / (1 - b * b) * (1 - b * T / Math.sqrt(T * T + tau0 * tau0));
}

/** Resample a track at dt from t0 (positions only) -> {ts, X, Y, Z} Float64Arrays (shared by all observers). */
export function sampleTrack(tr, dt = 0.5) {
  // numpy arange(t0, t1+1e-9, dt) length = ceil((t1+1e-9-t0)/dt)
  const m = Math.max(0, Math.ceil((tr.t1 + 1e-9 - tr.t0) / dt));
  let ts;
  if (m < 3) { ts = new Float64Array(3); for (let i = 0; i < 3; i++) ts[i] = tr.t0 + (tr.t1 - tr.t0) * i / 2; }
  else { ts = new Float64Array(m); for (let i = 0; i < m; i++) ts[i] = tr.t0 + i * dt; }
  const n = ts.length, X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n), b = new Float64Array(6);
  for (let i = 0; i < n; i++) { evalTrack(tr, ts[i], b); X[i] = b[0]; Y[i] = b[1]; Z[i] = b[2]; }
  return { ts, X, Y, Z, n, step: ts[1] - ts[0] };
}

/**
 * CPA of a track to observers obs (Float64Array 3N, [e,n,u] interleaved), indices [a, b).
 * Writes into tables (Float64Array N each): t_cpa, d_cpa, speed, t_dcpa. Dense sampling + parabolic refine of R^2.
 * Optional prune: maxH (horizontal metres) — points farther than maxH from every sample get d_cpa=+Inf quickly? (not used: exact).
 */
export function cpaInto(tr, S, obs, a, b, c, out, oOff = 0) {
  const { ts, X, Y, Z, n, step } = S;
  const buf = new Float64Array(6);
  for (let p = a; p < b; p++) {
    const ox = obs[3 * p], oy = obs[3 * p + 1], oz = obs[3 * p + 2];
    let best = Infinity, jb = 0;
    for (let j = 0; j < n; j++) {
      const dx = X[j] - ox, dy = Y[j] - oy, dz = Z[j] - oz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) { best = d2; jb = j; }
    }
    let j = jb < 1 ? 1 : jb > n - 2 ? n - 2 : jb;
    const r2 = (k) => { const dx = X[k] - ox, dy = Y[k] - oy, dz = Z[k] - oz; return dx * dx + dy * dy + dz * dz; };
    const y0 = r2(j - 1), y1 = r2(j), y2 = r2(j + 1);
    const den = y0 - 2 * y1 + y2;
    let off = den > 0 ? 0.5 * (y0 - y2) / den : 0.0;
    if (off < -1) off = -1; else if (off > 1) off = 1;
    const tc = ts[j] + off * step;
    evalTrack(tr, tc, buf);
    const d = Math.hypot(ox - buf[0], oy - buf[1], oz - buf[2]);
    const q = oOff + p;
    out.t_cpa[q] = tc; out.d_cpa[q] = d; out.speed[q] = Math.hypot(buf[3], buf[4], buf[5]); out.t_dcpa[q] = tc + d / c;
  }
}

/** Convenience: CPA dict for observers (array of [e,n,u]). */
export function cpa(tr, obsList, c = C_DEFAULT, dt = 0.5) {
  const N = obsList.length, obs = new Float64Array(3 * N);
  obsList.forEach((o, i) => obs.set(o, 3 * i));
  const out = { t_cpa: new Float64Array(N), d_cpa: new Float64Array(N), speed: new Float64Array(N), t_dcpa: new Float64Array(N) };
  cpaInto(tr, sampleTrack(tr, dt), obs, 0, N, c, out);
  return out;
}
