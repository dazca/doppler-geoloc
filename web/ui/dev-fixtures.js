// Development-only flight fixtures used by the UI when no ADS-B proxy is configured (E6).
// Real Catalonia cases fetched by Lane B/K from adsb.lol (fixtures/real/*). They do not exist in the deploy bundle;
// a missing file simply means "not available" and the engine's own fallback is used.
// `days` reproduces Lane B's measured archive status (docs/DATA.md §9) so the partial-day warning can be exercised
// offline; with a proxy the UI asks the Worker (adsb.js#fetchDayStatus) instead.
export const DEV_FIXTURES = [
  { id: 'lell_20261101', url: new URL('../../fixtures/real/lell_20261101/tracks.json', import.meta.url),
    bbox: [41.2, 1.7, 41.9, 2.5], t0: 1793516400, t1: 1793545200, source: 'fixture:lell 2026-11-01 (adsb.lol)',
    days: [{ day: '2026-11-01', feed: 'prod', status: 'ok' }, { day: '2026-11-01', feed: 'mlatonly', status: 'ok' }] },
  { id: 'cat_lell_terrace_20260611', url: new URL('../../fixtures/real/cat_lell_terrace_20260611/tracks.json', import.meta.url),
    bbox: [41.3, 1.8, 41.75, 2.4], t0: 1781186400, t1: 1781195400, source: 'fixture:lell 2026-06-11 (adsb.lol)',
    days: [{ day: '2026-06-11', feed: 'prod', status: 'partial', n_traces: 42314, ratio: 0.59, note: '42,314 traces vs ~71,600 on complete days' },
      { day: '2026-06-11', feed: 'mlatonly', status: 'empty', n_traces: 0, note: 'no MLAT-only traces' }] },
];

const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Tracks from a matching dev fixture, clipped to bbox(+pad) and [t0 - pad, t1 + duration + pad]; null if none. */
export async function devFixtureFlights({ bbox, t0, t1, duration_s = 0, padS = 1800 }, { signal } = {}) {
  const q0 = t0 - padS, q1 = t1 + duration_s + padS;
  const fx = DEV_FIXTURES.find((f) => overlaps(f.bbox, bbox) && f.t0 <= q1 && f.t1 >= q0);
  if (!fx) return null;
  let all;
  try { const r = await fetch(fx.url, { signal }); if (!r.ok) return null; all = await r.json(); }
  catch (e) { if (e?.name === 'AbortError') throw e; return null; }
  const pad = 0.05, bb = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad];
  const tracks = [];
  for (const tr of all) {
    const pts = tr.points.filter((p) => p[0] >= q0 && p[0] <= q1 && p[1] >= bb[0] && p[1] <= bb[2] && p[2] >= bb[1] && p[2] <= bb[3]);
    if (pts.length >= 2) tracks.push({ ...tr, points: pts });
  }
  const counts = { prop: 0, jet: 0, heli: 0, unknown: 0 };
  for (const t of tracks) counts[counts[t.category] != null ? t.category : 'unknown']++;
  return { tracks, source: fx.source, attribution: 'ADS-B data © adsb.lol contributors, ODbL 1.0', counts, days: fx.days,
    notes: ['Development fixture (no ADS-B proxy configured).'] };
}
