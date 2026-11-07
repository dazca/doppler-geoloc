import { engineOf } from './doppler.js';
// Contract flight track -> C1 cubic Hermite in ENU. Port of ref/doppler_ref/track.py (must match exactly).
// Tangents: non-uniform 3-point derivative at interior knots, one-sided at the ends.
// Optional smoothing W>0: each knot replaced by a tricube-weighted local quadratic fit over |dt|<W
// (p <- a, m <- b); knots with < 4 neighbours keep raw values.

export function hermiteTangents(t, P) {
  const n = t.length, M = new Float64Array(3 * n);
  if (n < 2) return M;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      let m;
      if (i === 0) m = (P[3 + k] - P[k]) / (t[1] - t[0]);
      else if (i === n - 1) m = (P[3 * i + k] - P[3 * (i - 1) + k]) / (t[i] - t[i - 1]);
      else {
        const hl = t[i] - t[i - 1], hr = t[i + 1] - t[i];
        const sl = (P[3 * i + k] - P[3 * (i - 1) + k]) / hl, sr = (P[3 * (i + 1) + k] - P[3 * i + k]) / hr;
        m = (sr * hl + sl * hr) / (hl + hr);
      }
      M[3 * i + k] = m;
    }
  }
  return M;
}

function solve3(a, b) { // a: 9 (row-major) , b: 3 -> x (Gaussian elimination, partial pivoting)
  const m = [a[0], a[1], a[2], b[0], a[3], a[4], a[5], b[1], a[6], a[7], a[8], b[2]];
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r * 4 + c]) > Math.abs(m[p * 4 + c])) p = r;
    if (p !== c) for (let k = 0; k < 4; k++) { const tt = m[c * 4 + k]; m[c * 4 + k] = m[p * 4 + k]; m[p * 4 + k] = tt; }
    for (let r = c + 1; r < 3; r++) {
      const f = m[r * 4 + c] / m[c * 4 + c];
      for (let k = c; k < 4; k++) m[r * 4 + k] -= f * m[c * 4 + k];
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let s = m[r * 4 + 3];
    for (let k = r + 1; k < 3; k++) s -= m[r * 4 + k] * x[k];
    x[r] = s / m[r * 4 + r];
  }
  return x;
}

export function localQuadratic(t, P, W) {
  const n = t.length;
  const Ps = Float64Array.from(P), Ms = hermiteTangents(t, P);
  let lo = 0;
  for (let i = 0; i < n; i++) {
    while (t[lo] - t[i] <= -W) lo++;
    let hi = lo, cnt = 0;
    const N = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const B = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; // B[coefRow][axis]
    for (let j = lo; j < n; j++) {
      const dt = t[j] - t[i];
      if (dt >= W) break;
      if (Math.abs(dt) >= W) continue;
      cnt++; hi = j;
      const q = Math.abs(dt) / W, w0 = 1 - q * q * q, w = w0 * w0 * w0;
      const r = [1, dt, dt * dt];
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) N[a * 3 + b] += r[a] * r[b] * w;
        for (let k = 0; k < 3; k++) B[a][k] += r[a] * w * P[3 * j + k];
      }
    }
    if (cnt < 4) continue;
    for (let k = 0; k < 3; k++) {
      const x = solve3(N, [B[0][k], B[1][k], B[2][k]]);
      Ps[3 * i + k] = x[0]; Ms[3 * i + k] = x[1];
    }
  }
  return { P: Ps, M: Ms };
}

/** Build a track from contract JSON. enu: makeENU frame. Returns a plain object (structured-clone friendly). */
/**
 * D14 gap model. For knot gaps longer than gapS the cubic Hermite between distant points is not trusted: the horizontal
 * path is a kinematic interpolation with constant turn rate and linearly varying speed from the end velocities
 * (one-sided, from the legs on each side). Of the turn rates that reach the far end (dh, dh -+ 2 pi; circuits often
 * turn the long way), the one needing the smallest end correction is kept; the residual end mismatch is blended in
 * linearly. Vertical: Hermite. Stored as a 1 s table per gap segment; tr.gaps lists [t_a, t_b] for weighting/verdict.
 */
function buildGaps(t, P, M, n, gapS, uncertainM, RV = null, a0 = 4) {
  const segs = {}, gaps = [];
  for (let i = 0; i < n - 1; i++) {
    const dt = t[i + 1] - t[i];
    if (!(dt > gapS)) continue;
    // D15: reported ADS-B velocity at both ends -> Hermite with those tangents; the uncertainty is physical: the peak
    // acceleration the cubic needs (a real GA manoeuvre stays below ~3-6 m/s^2; a suspicious gap needs much more)
    if (RV && RV[3 * i] === RV[3 * i] && RV[3 * (i + 1)] === RV[3 * (i + 1)]) {
      const m0 = [RV[3 * i], RV[3 * i + 1], RV[3 * i + 2] === RV[3 * i + 2] ? RV[3 * i + 2] : M[3 * i + 2]];
      const m1 = [RV[3 * (i + 1)], RV[3 * (i + 1) + 1], RV[3 * (i + 1) + 2] === RV[3 * (i + 1) + 2] ? RV[3 * (i + 1) + 2] : M[3 * (i + 1) + 2]];
      let amax = 0;
      for (const sv of [0, 1]) {   // P''(s) = (12s-6)p0 + (6s-4)h m0 + (-12s+6)p1 + (6s-2)h m1, linear in s
        const ax = (12 * sv - 6) * P[3 * i] + (6 * sv - 4) * dt * m0[0] + (-12 * sv + 6) * P[3 * (i + 1)] + (6 * sv - 2) * dt * m1[0];
        const ay = (12 * sv - 6) * P[3 * i + 1] + (6 * sv - 4) * dt * m0[1] + (-12 * sv + 6) * P[3 * (i + 1) + 1] + (6 * sv - 2) * dt * m1[1];
        amax = Math.max(amax, Math.hypot(ax, ay) / (dt * dt));
      }
      segs[i] = { hermite: true, m0, m1, amax, dt };
      const u = amax / a0;
      if (u > 0.5) gaps.push([t[i], t[i + 1], u, 'v']);   // uncertain only if the end velocities need a hard manoeuvre
      continue;
    }
    // one-sided end velocities from the legs (avoid tangents that mix in the far point)
    const v0 = [M[3 * i], M[3 * i + 1]], v1 = [M[3 * (i + 1)], M[3 * (i + 1) + 1]];
    if (i > 0 && t[i] - t[i - 1] <= gapS) { const h = t[i] - t[i - 1]; v0[0] = (P[3 * i] - P[3 * (i - 1)]) / h; v0[1] = (P[3 * i + 1] - P[3 * (i - 1) + 1]) / h; }
    if (i + 2 < n && t[i + 2] - t[i + 1] <= gapS) { const h = t[i + 2] - t[i + 1]; v1[0] = (P[3 * (i + 2)] - P[3 * (i + 1)]) / h; v1[1] = (P[3 * (i + 2) + 1] - P[3 * (i + 1) + 1]) / h; }
    const s0 = Math.hypot(v0[0], v0[1]), s1 = Math.hypot(v1[0], v1[1]);
    const dx = P[3 * (i + 1)] - P[3 * i], dy = P[3 * (i + 1) + 1] - P[3 * i + 1];
    if (s0 < 1 || s1 < 1) { gaps.push([t[i], t[i + 1], 1e4 / 500]); continue; }   // hovering / ground: keep Hermite, uncertain
    const h0 = Math.atan2(v0[1], v0[0]), h1 = Math.atan2(v1[1], v1[0]);
    let dh = h1 - h0; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh <= -Math.PI) dh += 2 * Math.PI;
    const m = Math.max(2, Math.ceil(dt)), st = dt / m;
    let best = null;
    for (const turn of [dh, dh - 2 * Math.PI, dh + 2 * Math.PI]) {
      const om = turn / dt, X = new Float64Array(m + 1), Y = new Float64Array(m + 1);
      for (let k = 1; k <= m; k++) {   // midpoint integration of the heading/speed law
        const tm = (k - 0.5) * st, h = h0 + om * tm, sp = s0 + (s1 - s0) * tm / dt;
        X[k] = X[k - 1] + sp * Math.cos(h) * st; Y[k] = Y[k - 1] + sp * Math.sin(h) * st;
      }
      const ex = dx - X[m], ey = dy - Y[m], err = Math.hypot(ex, ey);
      if (!best || err < best.err) best = { err, X, Y, ex, ey, om };
    }
    const X = new Float64Array(m + 1), Y = new Float64Array(m + 1);
    for (let k = 0; k <= m; k++) { const f = k / m; X[k] = P[3 * i] + best.X[k] + best.ex * f; Y[k] = P[3 * i + 1] + best.Y[k] + best.ey * f; }
    const chord = Math.hypot(dx, dy);
    if (best.err > 0.3 * Math.max(chord, 1)) { gaps.push([t[i], t[i + 1], Math.max(best.err, 1e3) / 500]); continue; }   // model inconsistent: keep Hermite, uncertain
    segs[i] = { m, st, X, Y, cx: best.ex / dt, cy: best.ey / dt, h0, om: best.om, s0, s1, dt, end_err_m: best.err };
    // only gaps the kinematic model cannot bridge consistently (the aircraft manoeuvred) count as uncertain
    if (best.err > uncertainM) gaps.push([t[i], t[i + 1], best.err / 500]);
  }
  return { segs, gaps };
}

/** Is time te inside a long ADS-B gap of the track (D14)? */
export function inGap(tr, te) {
  const g = tr.gaps; if (!g || !g.length) return false;
  let lo = 0, hi = g.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (te < g[mid][0]) hi = mid - 1; else if (te > g[mid][1]) lo = mid + 1; else return true; }
  return false;
}

/** D14 trust weight of the track at time te: 1 outside uncertain gaps, 1 / (1 + (err / scale)^2) inside, where err is
 * the kinematic end mismatch of the gap (how much the aircraft manoeuvred where we have no data). */
export function gapWeight(tr, te, scale = 500, minGapS = 60) {   // entries [a, b, u, 'v'?]: weight 1/(1+u^2)
  const g = tr.gaps; if (!g || !g.length) return 1;
  let lo = 0, hi = g.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (te < g[mid][0]) hi = mid - 1; else if (te > g[mid][1]) lo = mid + 1;
    else {
      if (g[mid][3] !== 'v' && g[mid][1] - g[mid][0] < minGapS) return 1;   // no reported velocity: only large gaps
      const u = (g[mid][2] ?? 2) * (g[mid][3] === 'v' ? 1 : 500 / scale); return 1 / (1 + u * u);
    }
  }
  return 1;
}

/** Length of the gap containing te (0 if none). */
export function gapLength(tr, te) {
  const g = tr.gaps; if (!g) return 0;
  for (const [a, b] of g) if (te >= a && te <= b) return b - a;
  return 0;
}

export function buildTrack(d, enu, smoothS = 0, types = null, { gapS = 0, gapUncertainM = 60, useReportedVel = true, velLagS = 2.75 } = {}) {
  const order = d.points.map((p, i) => [p, i]).sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]);
  const pts = order.map((x) => x[0]), vsrc = d.vel ? order.map((x) => d.vel[x[1]]) : null;
  const keep = [], kvel = [];
  for (let i = 0; i < pts.length; i++) if (i === 0 || pts[i][0] - pts[i - 1][0] > 1e-6) { keep.push(pts[i]); if (vsrc) kvel.push(vsrc[i]); }
  const n = keep.length;
  const t = new Float64Array(n), P = new Float64Array(3 * n), tmp = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    t[i] = keep[i][0];
    enu.fwd(keep[i][1], keep[i][2], keep[i][3], tmp);
    P[3 * i] = tmp[0]; P[3 * i + 1] = tmp[1]; P[3 * i + 2] = tmp[2];
  }
  let M;
  if (smoothS > 0 && n > 0) { const r = localQuadratic(t, P, smoothS); P.set(r.P); M = r.M; } else M = hermiteTangents(t, P);
  const desc = types && d.type && types[d.type] ? types[d.type][1] : null;
  const tr = { id: d.id, icao24: d.icao24 ?? null, callsign: d.callsign ?? null, type: d.type ?? null,
    category: d.category ?? 'unknown', engine: engineOf(desc, d.category ?? 'unknown'), t, P, M, t0: t[0], t1: t[n - 1], n };
  if (gapS > 0 && n >= 2) {
    // D15 reported velocities (optional 'vel' [gs m/s, track deg, vrate m/s]) -> ENU, corrected for the report lag
    // (the report at t + lag describes the motion at t; Lane F: lag ~2.75 s)
    let RV = null;
    if (vsrc && useReportedVel) {
      const vt = [], vv = [];
      const vmax = (d.category ?? 'unknown') === 'jet' ? 350 : 150;   // implausible reports (seen on MLAT tracks: 393 m/s for a DV20) are ignored
      for (let i = 0; i < n; i++) { const v = kvel[i]; if (v && v[0] != null && v[1] != null && v[0] <= vmax) { const a = v[1] * Math.PI / 180; vt.push(t[i]); vv.push([v[0] * Math.sin(a), v[0] * Math.cos(a), v[2] ?? NaN]); } }
      if (vt.length >= 2) {
        RV = new Float64Array(3 * n).fill(NaN);
        for (let i = 0; i < n; i++) {
          const tq = t[i] + velLagS;
          let j = vt.findIndex((x) => x >= tq);
          if (j < 0) j = vt.length - 1;
          const k = j > 0 && vt[j] > tq && tq - vt[j - 1] < 10 && vt[j] - tq < 10 ? j - 1 : -1;
          const near = Math.abs(vt[j] - tq) <= 10 ? j : -1;
          if (k >= 0) { const f = (tq - vt[k]) / (vt[j] - vt[k]); for (let c = 0; c < 3; c++) RV[3 * i + c] = vv[k][c] + f * (vv[j][c] - vv[k][c]); }
          else if (near >= 0) for (let c = 0; c < 3; c++) RV[3 * i + c] = vv[near][c];
          else { // no report near t + lag (gap start): use the report at the knot itself, if any
            const m = vt.indexOf(t[i]); if (m >= 0) for (let c = 0; c < 3; c++) RV[3 * i + c] = vv[m][c];
          }
        }
      }
    }
    const g = buildGaps(t, P, M, n, gapS, gapUncertainM, RV); tr.gapSeg = g.segs; tr.gaps = g.gaps; tr.hasReportedVel = !!RV;
  }
  return tr;
}

/** Evaluate position+velocity at time tq into out[0..5]; returns valid (tq within [t0,t1]). */
export function evalTrack(tr, tq, out) {
  const t = tr.t, n = tr.n, P = tr.P, M = tr.M;
  const valid = tq >= t[0] && tq <= t[n - 1];
  if (n < 2) {
    out[0] = P[0]; out[1] = P[1]; out[2] = P[2]; out[3] = 0; out[4] = 0; out[5] = 0;
    return valid;
  }
  const tc = tq < t[0] ? t[0] : tq > t[n - 1] ? t[n - 1] : tq;
  // searchsorted(side='right') - 1, clipped to [0, n-2]
  let lo = 0, hi = n; // first index with t > tc
  while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid] > tc) hi = mid; else lo = mid + 1; }
  let i = lo - 1;
  if (i < 0) i = 0; else if (i > n - 2) i = n - 2;
  const ta = t[i], tb = t[i + 1], h = tb - ta, s = (tc - ta) / h;
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = (s3 - 2 * s2 + s) * h, h01 = -2 * s3 + 3 * s2, h11 = (s3 - s2) * h;
  const d00 = (6 * s2 - 6 * s) / h, d01 = (-6 * s2 + 6 * s) / h, d10 = 3 * s2 - 4 * s + 1, d11 = 3 * s2 - 2 * s;
  const a = 3 * i, b = a + 3;
  for (let k = 0; k < 3; k++) {
    const p0 = P[a + k], p1 = P[b + k], m0 = M[a + k], m1 = M[b + k];
    out[k] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
    out[3 + k] = d00 * p0 + d01 * p1 + d10 * m0 + d11 * m1;
  }
  const g = tr.gapSeg && tr.gapSeg[i];
  if (g && g.hermite) { // D15: Hermite with the reported end velocities as tangents
    for (let k = 0; k < 3; k++) {
      const p0 = P[a + k], p1 = P[b + k], m0 = g.m0[k], m1 = g.m1[k];
      out[k] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
      out[3 + k] = d00 * p0 + d01 * p1 + d10 * m0 + d11 * m1;
    }
  } else if (g) { // D14 kinematic gap interpolation (horizontal)
    const x = (tc - ta) / g.st, k = Math.min(g.m - 1, Math.floor(x)), f = x - k, tm = tc - ta;
    out[0] = g.X[k] + f * (g.X[k + 1] - g.X[k]); out[1] = g.Y[k] + f * (g.Y[k + 1] - g.Y[k]);
    const hh = g.h0 + g.om * tm, sp = g.s0 + (g.s1 - g.s0) * tm / g.dt;
    out[3] = sp * Math.cos(hh) + g.cx; out[4] = sp * Math.sin(hh) + g.cy;
  }
  return valid;
}
