// One-click ridge auto-extension (Lane E2). Pure ES module (browser worker + Node).
// Builds on Lane C's trackRidge: a single trackRidge call searches only f_seed·(1 ± bandFrac) and keeps the confident
// segment around the click, so a long Doppler sweep (e.g. 172 → 97 Hz) is cut short. extendRidge re-seeds at each
// end of the current track with the band re-centred there and keeps going while the tracker stays confident (its
// null-test trim decides when the SNR has dropped). Real-audio options from LANE_C_REPORT C6: harmonic stacking,
// falling-only constraint, robust null threshold, emission clip, impulsive-frame coasting.
import { trackRidge, cleanRidge } from './ridge.js';

export const REAL_AUDIO_OPTS = { nullStat: 'robust', nullZ: 1.5, emClip: 15, impulseDb: 6, maxGapS: 4 };

/**
 * @param spec  contract spectrogram (whitened dB)
 * @param seed  {t, f} click on the CLICKED line
 * @param opts  trackRidge options (harmonics, monotonic, ...) plus:
 *              extend (default true), maxSteps per direction (8), minGainS (1 s: stop when a step adds less),
 *              reseedSnap (2 bins), jumpsS ([3, 6] s: re-seed across gaps along the local slope), clean (true)
 * @returns {points:[{t,f,snr,score}], steps, first}  points are in clicked-line frequency, sorted by t
 */
export function extendRidge(spec, seed, opts = {}) {
  const { extend = true, maxSteps = 8, minGainS = 1, reseedSnap = 2, clean = true, jumpsS = [3, 6], minPieceS = 3, snrFrac = 0.6, minSnrDb = 4, ...base } = opts;
  const first = trackRidge(spec, seed, base);
  let pts = first.points.slice();
  let steps = 0;
  if (extend && pts.length >= 8) {
    const half = spec.dt / 2;
    // local slope (Hz/s) over the last `win` seconds at one end, by least squares
    const slopeAt = (dir, win = 4) => {
      const end = dir > 0 ? pts[pts.length - 1] : pts[0];
      const sel = pts.filter((p) => Math.abs(p.t - end.t) <= win);
      if (sel.length < 4) return 0;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const p of sel) { sx += p.t; sy += p.f; sxx += p.t * p.t; sxy += p.t * p.f; }
      const n = sel.length, den = n * sxx - sx * sx;
      return den ? Math.min(0, (n * sxy - sx * sy) / den) : 0;   // falling-only
    };
    const tryStep = (dir, jump) => {
      const end = dir > 0 ? pts[pts.length - 1] : pts[0];
      const slope = slopeAt(dir);
      const ts = end.t + dir * jump, fs = end.f + slope * dir * jump;
      const o = { ...base, snap: jump ? 4 : reseedSnap,
        tMin: dir > 0 ? end.t - 2 : ts - 120, tMax: dir > 0 ? ts + 120 : end.t + 2 };
      let r;
      try { r = trackRidge(spec, { t: ts, f: fs }, o); } catch { return 0; }
      const add = r.points.filter((p) => (dir > 0 ? p.t > end.t + half : p.t < end.t - half));
      if (!add.length) return 0;
      // continuity: the piece must join the extrapolated line (no hop onto another tone)
      const join = dir > 0 ? add[0] : add[add.length - 1];
      const pred = end.f + slope * (join.t - end.t);
      const tol = Math.max(3 * spec.df, 0.04 * end.f) + Math.abs(join.t - end.t) * 0.02 * end.f;
      if (Math.abs(join.f - pred) > tol) return 0;
      if (dir < 0 && add.some((p, i) => i && p.f > add[i - 1].f + 2 * spec.df)) return 0;
      if (jump) {   // a piece found across a gap must be clearly a continuation, not a noise streak
        const dur = add[add.length - 1].t - add[0].t;
        const snrs = pts.map((p) => p.snr).sort((a, b) => a - b), med = snrs[snrs.length >> 1];
        const m = add.reduce((a, p) => a + p.snr, 0) / add.length;
        if (dur < minPieceS || m < Math.max(minSnrDb, med * snrFrac)) return 0;
      }
      const gain = dir > 0 ? add[add.length - 1].t - end.t : end.t - add[0].t;
      pts = dir > 0 ? pts.concat(add) : add.concat(pts);
      return gain;
    };
    for (const dir of [1, -1]) {
      for (let s = 0; s < maxSteps; s++) {
        let gain = tryStep(dir, 0);
        if (gain < minGainS) for (const j of jumpsS) { gain = tryStep(dir, j); if (gain >= minGainS) break; }
        if (gain > 0) steps++;
        if (gain < minGainS) break;
      }
    }
  }
  if (clean && pts.length > 10) pts = cleanRidge(pts, { winS: 2, maxDevHz: Math.max(2, 2 * spec.df) });
  return { points: pts, steps, first };
}
