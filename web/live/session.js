// Live session glue (Lane L prototype): poller + track selection + search input with T_start known.
// Pure ES module (browser + Node).
import { LiveTrackBuilder, backfill, pointUrl, bboxAround } from './adsb-live.js';
import { ServerClock, wallNow } from './clock.js';

/** Polls the re-api point endpoint every `everyS` s until stop(). Every snapshot feeds the builder and the clock. */
export function startPolling({ base, lat, lon, nm = 25, everyS = 5, builder = new LiveTrackBuilder(), clock = new ServerClock(),
  f = globalThis.fetch.bind(globalThis), onSnapshot } = {}) {
  let stopped = false, timer = null, backoff = 1;
  const stats = { polls: 0, errors: 0 };
  const tick = async () => {
    if (stopped) return;
    const t0 = Date.now(), sendMs = wallNow();
    try {
      const r = await f(pointUrl(base, lat, lon, nm));
      const recvMs = wallNow();
      if (r.ok) {
        const js = await r.json();
        // the production Worker caches snapshots for a few seconds, so its X-Server-Time-Ms (time at serving) is the
        // right clock sample; the JSON `now` (snapshot time) is only exact when nothing in between caches (dev proxy)
        const edge = Number(r.headers.get('x-server-time-ms'));
        clock.add({ sendMs, recvMs, serverMs: Number.isFinite(edge) && edge > 0 ? edge : js.now ?? null, dateHeader: r.headers.get('date') });
        builder.addSnapshot(js); stats.polls++;
        onSnapshot?.({ js, stats, clock: clock.estimate(), aircraft: builder.ac.size });
        backoff = 1;
      } else { stats.errors++; backoff = Math.min(backoff * 2, 6); } // 429: adsb.lol re-api throttles bursts
    } catch { stats.errors++; backoff = Math.min(backoff * 2, 6); }
    if (!stopped) timer = setTimeout(tick, Math.max(0, everyS * backoff * 1000 - (Date.now() - t0)));
  };
  tick();
  return { builder, clock, stats, stop() { stopped = true; clearTimeout(timer); } };
}

/** Hexes worth backfilling: seen within `radiusM` of the centre below `maxAltFt` (props/helis fly low). */
export function hexesNear(builder, { center, radiusM = 15000, maxAltFt = 10000 }) {
  const [la, lo] = center, k = Math.cos(la * Math.PI / 180), out = [];
  for (const a of builder.ac.values()) {
    for (const p of a.pts.values()) {
      const alt = typeof p[3] === 'number' ? p[3] : (typeof p[10] === 'number' ? p[10] : null);
      if (alt == null || alt > maxAltFt) continue;
      if (Math.hypot((p[1] - la) * 111320, (p[2] - lo) * 111320 * k) <= radiusM) { out.push(a.icao); break; }
    }
  }
  return out;
}

/** After the clip: backfill traces, then contract tracks around the centre for [T_start - pad, T_end + pad]. */
export async function finishTracks({ builder, base, center, radiusM = 15000, tStartUnix, durationS, padS = 120, types, f, onProgress }) {
  const hexes = hexesNear(builder, { center, radiusM });
  const bf = await backfill(builder, hexes, { base, rps: 4, f, onProgress });
  const bbox = bboxAround(center[0], center[1], radiusM);
  const tracks = builder.toTracks({ bbox, t0: tStartUnix - padS, t1: tStartUnix + durationS + padS, types });
  return { tracks, hexes, backfill: bf };
}

/**
 * runSearch input for a live clip. T_start is known (device clock + server offset) to `tolS` (default ±3 s: covers the
 * ADS-B position-time latency, ~1-3 s, and the audio anchor, < 0.1 s). With T_start known one event is enough (MATH §10).
 */
export function liveSearchInput({ events, tracks, center, regionRadiusM = 6000, tStartUnix, durationS, audio = null, spec = null,
  tolS = 3, settings = {} }) {
  return {
    events, silences: [],
    region: { shape: 'circle', center, radius_m: regionRadiusM, bbox: bboxAround(center[0], center[1], regionRadiusM) },
    time: { t0: tStartUnix - tolS, t1: tStartUnix + tolS },
    duration_s: durationS, tracks, spec, audio,
    settings: { grid_m: 100, c: 343, topN: 5, offsetTolS: 8, refine: true, ...settings },
  };
}
