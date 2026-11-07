// Live ADS-B -> contract tracks (Lane L prototype). Pure ES module, browser + Node 18+.
//
// Two ways to get tracks, both through a CORS proxy (adsb.lol sends no Access-Control-Allow-Origin):
//   1. poll  GET {base}/v2/point/{lat}/{lon}/{nm}            (re-api snapshot, readsb aircraft.json format)
//      every few seconds and append each aircraft's position (time = now/1000 - seen_pos);
//   2. backfill GET {base}/data/traces/{xx}/trace_full_{hex}.json  (+ trace_recent_{hex}.json)
//      for every hex seen. trace_full covers the last ~24 h (lags real time by ~1-2 min); trace_recent
//      covers the last few minutes at ~1 s. Together they give the past 30 min without any polling history.
// Both are stored as readsb trace points so that web/engine/adsb.js#traceToTracks does the MSL conversion.

import { traceToTracks, baroCalibration } from '../engine/adsb.js';
import { geoidN } from './geoid.js';

/** Builds per-aircraft readsb-style traces from snapshots and/or trace files. */
export class LiveTrackBuilder {
  constructor() { this.ac = new Map(); this.snapshots = 0; this.lastNow = null; }

  _get(hex) {
    let a = this.ac.get(hex);
    if (!a) { a = { icao: hex, r: null, t: null, desc: null, timestamp: 0, pts: new Map() }; this.ac.set(hex, a); }
    return a;
  }

  /** snapshot: re-api JSON {now (ms), ac:[...]} (adsb.lol) or {now (s), aircraft:[...]} (adsb.fi). */
  addSnapshot(js) {
    const list = js.ac || js.aircraft || [];
    const nowS = js.now > 1e11 ? js.now / 1000 : js.now;
    this.snapshots++; this.lastNow = nowS;
    let added = 0;
    for (const s of list) {
      if (s.lat == null || s.lon == null || s.seen_pos == null) continue;
      const a = this._get(s.hex);
      a.r = s.r ?? a.r; a.t = s.t ?? a.t; a.desc = s.desc ?? a.desc;
      const t = Math.round((nowS - s.seen_pos) * 100) / 100;
      const key = t.toFixed(2);
      if (a.pts.has(key)) continue;
      const extra = { flight: s.flight, category: s.category };
      a.pts.set(key, [t, s.lat, s.lon, s.alt_baro ?? null, s.gs ?? null, s.track ?? null, 0, s.baro_rate ?? null,
        extra, s.type ?? null, s.alt_geom ?? null, s.geom_rate ?? null, s.ias ?? null, s.roll ?? null]);
      added++;
    }
    return added;
  }

  /** d: readsb trace JSON (trace_full / trace_recent). Points are merged by time. */
  addTrace(d) {
    if (!d?.trace) return 0;
    const a = this._get(d.icao);
    a.r = d.r ?? a.r; a.t = d.t ?? a.t; a.desc = d.desc ?? a.desc;
    let added = 0;
    for (const p of d.trace) {
      const t = Math.round((d.timestamp + p[0]) * 100) / 100, key = t.toFixed(2);
      if (a.pts.has(key)) continue;
      const q = p.slice(); q[0] = t; q[6] = (p[6] || 0) & ~2; // leg-start flags are meaningless after merging
      a.pts.set(key, q); added++;
    }
    return added;
  }

  /** readsb trace objects, points sorted, with near-duplicates (<0.3 s apart, same place) removed. */
  traces() {
    const out = [];
    for (const a of this.ac.values()) {
      const pts = [...a.pts.values()].sort((x, y) => x[0] - y[0]);
      const keep = [];
      for (const p of pts) {
        const l = keep[keep.length - 1];
        if (l && p[0] - l[0] < 0.3) continue;
        keep.push(p);
      }
      out.push({ icao: a.icao, r: a.r, t: a.t, desc: a.desc, timestamp: 0, trace: keep });
    }
    return out;
  }

  /** Contract tracks inside bbox/window, alt MSL = alt_geom - N(EGM96), baro-only points locally calibrated. */
  toTracks({ bbox, t0 = -Infinity, t1 = Infinity, types = null, maxAltM = Infinity }) {
    const tr = this.traces();
    const baroOffset = baroCalibration(tr, { bbox, t0: Math.max(t0, 0), t1: Math.min(t1, 4e9), geoidN: geoidN });
    const out = [];
    for (const d of tr) for (const t of traceToTracks(d, { bbox, t0, t1, geoidN, baroOffset, types })) {
      if (Math.min(...t.points.map((p) => p[3])) <= maxAltM) out.push(t);
    }
    return out;
  }
}

/** Distance in nm from a point to a bbox corner, to size the re-api radius. */
export function bboxAround(lat, lon, radiusM) {
  const dLat = radiusM / 111320, dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

export const traceUrl = (base, hex, kind = 'full') =>
  `${base}/data/traces/${hex.slice(-2)}/trace_${kind}_${hex}.json`;
// L3: the position is rounded to 0.05 deg (~5 km) BEFORE it leaves the browser (same grid as the Worker's cache key);
// local track selection keeps using the precise centre.
export const roughDeg = (v) => (Math.round(v * 20) / 20).toFixed(2);
export const pointUrl = (base, lat, lon, nm) => `${base}/v2/point/${roughDeg(lat)}/${roughDeg(lon)}/${Math.round(nm)}`;

/**
 * Fetch trace_full + trace_recent for each hex (sequential-ish, at most `rps` requests per second).
 * Returns {ok, failed}. f: fetch implementation.
 */
export async function backfill(builder, hexes, { base, rps = 4, f = globalThis.fetch.bind(globalThis), signal, onProgress } = {}) {
  let ok = 0, failed = 0, i = 0;
  const gap = 1000 / rps;
  for (const hex of hexes) {
    for (const kind of ['full', 'recent']) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const t0 = Date.now();
      try {
        const r = await f(traceUrl(base, hex, kind), { signal });
        if (r.ok) { builder.addTrace(await r.json()); ok++; } else failed++;
      } catch (e) { if (e.name === 'AbortError') throw e; failed++; }
      const wait = gap - (Date.now() - t0);
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    }
    onProgress?.({ done: ++i, total: hexes.length });
  }
  return { ok, failed };
}
