// Sparse delayed-CPA tables (stage 3) for large traffic sets (D8 scale fix).
//
// The dense tables (flights x points, argmin over every track sample for every point) are O(F*N*M) in time and
// O(F*N) in memory: 779 flights x 25k points = 620 MB. Here, per flight:
//   1. the track is cut to the time window [win0, win1] (T_start window + clip) and to the search box (+ rmax),
//   2. its coarse polyline (every 5 s) is rasterised over the grid LATTICE: only lattice points within the flight's
//      radius rmax[f] (max of its audible radius and the largest CPA distance any event accepts) are touched;
//      each keeps the nearest coarse segment (horizontal distance, exact point-to-segment),
//   3. the touched points get the reference CPA: argmin of 3-D distance over the 0.5 s samples of the best segment
//      +-1 segment, then the parabolic refinement of R^2 of doppler.cpa (same lattice of sample times as
//      doppler.sampleTrack, so results equal the dense tables wherever the flight is within rmax).
// Points farther than rmax from a flight get no entry (they are inaudible and cannot be assigned to an event).
// Output: CSR {N, ptr(N+1), f, t_cpa, d_cpa, speed, t_dcpa}, entries of a point sorted by t_dcpa.
import { evalTrack } from './track.js';

/** Lattice descriptor of a grid: {x0, y0, s, nx, ny, idx: Int32Array(nx*ny) point index or -1, off}. */
export function latticeOf(g, cx, cy, half, spacing, off = 0) {
  const nx = g.nx, idx = new Int32Array(nx * nx).fill(-1);
  for (let p = 0; p < g.N; p++) idx[g.iy[p] * nx + g.ix[p]] = p + off;
  return { x0: cx - half, y0: cy - half, s: spacing, nx, ny: nx, idx };
}

function sampleWindow(tr, dt, w0, w1) {
  // sample times t0 + k dt (the doppler.sampleTrack lattice) within [w0, w1]
  const nAll = Math.max(0, Math.ceil((tr.t1 + 1e-9 - tr.t0) / dt));
  if (nAll < 3) return null;
  const k0 = Math.max(0, Math.ceil((w0 - tr.t0) / dt - 1e-9)), k1 = Math.min(nAll - 1, Math.floor((w1 - tr.t0) / dt + 1e-9));
  const n = k1 - k0 + 1;
  if (n < 3) return null;
  const ts = new Float64Array(n), X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n), b = new Float64Array(6);
  for (let i = 0; i < n; i++) { const t = tr.t0 + (k0 + i) * dt; ts[i] = t; evalTrack(tr, t, b); X[i] = b[0]; Y[i] = b[1]; Z[i] = b[2]; }
  return { ts, X, Y, Z, n, step: dt };
}

/** Time span of the track whose knots lie inside the box [bx0, bx1] x [by0, by1] (+ pad seconds), or null. */
function boxSpan(tr, bx0, bx1, by0, by1, pad) {
  let a = -1, z = -1;
  for (let i = 0; i < tr.n; i++) {
    const x = tr.P[3 * i], y = tr.P[3 * i + 1];
    if (x >= bx0 && x <= bx1 && y >= by0 && y <= by1) { if (a < 0) a = i; z = i; }
  }
  if (a < 0) return null;
  return [tr.t[Math.max(0, a - 1)] - pad, tr.t[Math.min(tr.n - 1, z + 1)] + pad];
}

/**
 * Entries for flights fList over the lattices. obs: Float64Array(3N) observer ENU. rmax: Float64Array(F) metres.
 * window: [w0, w1] unix or null. Returns {n, p, f, t_cpa, d_cpa, speed, t_dcpa} (typed arrays, length n).
 */
export function sparseCpaEntries(tracks, fList, lattices, obs, c, rmax, window = null, dt = 0.5, coarse = 10) {
  let cap = 1 << 14, n = 0;
  let P = new Int32Array(cap), Fi = new Int32Array(cap), TC = new Float64Array(cap), DC = new Float64Array(cap), SP = new Float64Array(cap), TD = new Float64Array(cap);
  const grow = () => {
    cap *= 2;
    const g = (A, T) => { const B = new T(cap); B.set(A); return B; };
    P = g(P, Int32Array); Fi = g(Fi, Int32Array); TC = g(TC, Float64Array); DC = g(DC, Float64Array); SP = g(SP, Float64Array); TD = g(TD, Float64Array);
  };
  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity, maxPt = 0;
  for (const L of lattices) {
    bx0 = Math.min(bx0, L.x0); by0 = Math.min(by0, L.y0); bx1 = Math.max(bx1, L.x0 + (L.nx - 1) * L.s); by1 = Math.max(by1, L.y0 + (L.ny - 1) * L.s);
    for (const v of L.idx) if (v + 1 > maxPt) maxPt = v + 1;
  }
  const bestD = new Float64Array(maxPt), bestK = new Int32Array(maxPt), stamp = new Int32Array(maxPt).fill(-1), touched = new Int32Array(maxPt);
  const b6 = new Float64Array(6);
  for (const f of fList) {
    const tr = tracks[f], R = rmax[f];
    if (!(R > 0) || tr.n < 2) continue;
    if (window && (tr.t1 < window[0] || tr.t0 > window[1])) continue;
    const span = boxSpan(tr, bx0 - R, bx1 + R, by0 - R, by1 + R, 2 * coarse * dt);
    if (!span) continue;
    const w0 = Math.max(span[0], window ? window[0] : -Infinity), w1 = Math.min(span[1], window ? window[1] : Infinity);
    const S = window || w0 > tr.t0 || w1 < tr.t1 ? sampleWindow(tr, dt, w0, w1) : sampleWindow(tr, dt, -Infinity, Infinity);
    if (!S) continue;
    const { ts, X, Y, Z } = S, ns = S.n, R2 = R * R;
    let nt = 0;
    const nSeg = Math.ceil((ns - 1) / coarse);
    for (let k = 0; k < nSeg; k++) {
      const a = k * coarse, b = Math.min(ns - 1, a + coarse);
      const ax = X[a], ay = Y[a], ex = X[b] - ax, ey = Y[b] - ay, ee = ex * ex + ey * ey;
      const xmin = Math.min(ax, X[b]) - R, xmax = Math.max(ax, X[b]) + R, ymin = Math.min(ay, Y[b]) - R, ymax = Math.max(ay, Y[b]) + R;
      for (const L of lattices) {
        const q0 = Math.max(0, Math.ceil((xmin - L.x0) / L.s)), q1 = Math.min(L.nx - 1, Math.floor((xmax - L.x0) / L.s));
        const r0 = Math.max(0, Math.ceil((ymin - L.y0) / L.s)), r1 = Math.min(L.ny - 1, Math.floor((ymax - L.y0) / L.s));
        for (let r = r0; r <= r1; r++) {
          const py = L.y0 + r * L.s, row = r * L.nx;
          for (let q = q0; q <= q1; q++) {
            const p = L.idx[row + q];
            if (p < 0) continue;
            const px = L.x0 + q * L.s;
            let u = ee > 0 ? ((px - ax) * ex + (py - ay) * ey) / ee : 0;
            u = u < 0 ? 0 : u > 1 ? 1 : u;
            const dx = ax + u * ex - px, dy = ay + u * ey - py, d2 = dx * dx + dy * dy;
            if (d2 > R2) continue;
            if (stamp[p] !== f) { stamp[p] = f; bestD[p] = d2; bestK[p] = k; touched[nt++] = p; }
            else if (d2 < bestD[p]) { bestD[p] = d2; bestK[p] = k; }
          }
        }
      }
    }
    for (let t = 0; t < nt; t++) {
      const p = touched[t], k = bestK[p];
      const ox = obs[3 * p], oy = obs[3 * p + 1], oz = obs[3 * p + 2];
      const a = Math.max(0, (k - 1) * coarse), b = Math.min(ns - 1, (k + 2) * coarse);
      let best = Infinity, jb = a;
      for (let j = a; j <= b; j++) {
        const dx = X[j] - ox, dy = Y[j] - oy, dz = Z[j] - oz, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) { best = d2; jb = j; }
      }
      const j = jb < 1 ? 1 : jb > ns - 2 ? ns - 2 : jb;
      const r2 = (i) => { const dx = X[i] - ox, dy = Y[i] - oy, dz = Z[i] - oz; return dx * dx + dy * dy + dz * dz; };
      const y0 = r2(j - 1), y1 = r2(j), y2 = r2(j + 1), den = y0 - 2 * y1 + y2;
      let off = den > 0 ? 0.5 * (y0 - y2) / den : 0.0;
      off = off < -1 ? -1 : off > 1 ? 1 : off;
      const tc = ts[j] + off * S.step;
      evalTrack(tr, tc, b6);
      const d = Math.hypot(ox - b6[0], oy - b6[1], oz - b6[2]);
      if (d > R) continue;
      if (n === cap) grow();
      P[n] = p; Fi[n] = f; TC[n] = tc; DC[n] = d; SP[n] = Math.hypot(b6[3], b6[4], b6[5]); TD[n] = tc + d / c; n++;
    }
  }
  return { n, p: P.subarray(0, n), f: Fi.subarray(0, n), t_cpa: TC.subarray(0, n), d_cpa: DC.subarray(0, n), speed: SP.subarray(0, n), t_dcpa: TD.subarray(0, n) };
}

/** Merge entry sets into CSR over N points, sorted by (point, t_dcpa). */
export function toCSR(N, parts) {
  let nnz = 0;
  for (const e of parts) nnz += e.n;
  const ptr = new Int32Array(N + 1);
  for (const e of parts) for (let i = 0; i < e.n; i++) ptr[e.p[i] + 1]++;
  for (let i = 0; i < N; i++) ptr[i + 1] += ptr[i];
  const pos = ptr.slice(0, N);
  const f = new Int32Array(nnz), t_cpa = new Float64Array(nnz), d_cpa = new Float64Array(nnz), speed = new Float64Array(nnz), t_dcpa = new Float64Array(nnz);
  for (const e of parts) for (let i = 0; i < e.n; i++) {
    const q = pos[e.p[i]]++;
    f[q] = e.f[i]; t_cpa[q] = e.t_cpa[i]; d_cpa[q] = e.d_cpa[i]; speed[q] = e.speed[i]; t_dcpa[q] = e.t_dcpa[i];
  }
  // sort each row by t_dcpa (insertion sort: rows are short)
  for (let p = 0; p < N; p++) {
    for (let i = ptr[p] + 1; i < ptr[p + 1]; i++) {
      const tf = f[i], ttc = t_cpa[i], td = d_cpa[i], tsp = speed[i], tt = t_dcpa[i];
      let j = i - 1;
      while (j >= ptr[p] && (t_dcpa[j] > tt || (t_dcpa[j] === tt && f[j] > tf))) {
        f[j + 1] = f[j]; t_cpa[j + 1] = t_cpa[j]; d_cpa[j + 1] = d_cpa[j]; speed[j + 1] = speed[j]; t_dcpa[j + 1] = t_dcpa[j]; j--;
      }
      f[j + 1] = tf; t_cpa[j + 1] = ttc; d_cpa[j + 1] = td; speed[j + 1] = tsp; t_dcpa[j + 1] = tt;
    }
  }
  return { N, nnz, ptr, f, t_cpa, d_cpa, speed, t_dcpa };
}
