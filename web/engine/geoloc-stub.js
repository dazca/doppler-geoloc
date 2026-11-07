// STUB geolocation engine (Lane E). Implements web/engine/geoloc-api.md with fake but plausible behaviour so the UI
// can be exercised end to end. It is NOT the real engine; Lane D replaces it (web/engine/geoloc*.js).
//  - fitEvent: a real (small) Nelder–Mead fit of the straight-pass model, MATH.md eq. 3.2.
//  - fetchFlights: fixture tracks (scenario1, colsto 2026) when the query overlaps them, else synthetic tracks.
//  - runSearch: a fake progress stream and a fake score field (peaks at the known answer for scenario1).
//  - simulateCurves: exact retarded-time Doppler for the assigned flights (flat-earth ENU), honest physics.

export const ENGINE_INFO = { name: 'stub', version: '0.1.0', fake: true };

const C = 343;
const sleep = (ms, signal) => new Promise((res, rej) => {
  if (signal?.aborted) return rej(new DOMException('Aborted', 'AbortError'));
  const id = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(id); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

// ------------------------------------------------------------------ fitEvent
function modelF(T, F0, v, d, c) {
  const b = v / c, tau0 = d * Math.sqrt(1 - b * b) / v;
  return F0 / (1 - b * b) * (1 - b * T / Math.sqrt(T * T + tau0 * tau0));
}

function nelderMead(f, x0, steps, iters = 400) {
  const n = x0.length;
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += steps[i]; simplex.push(x); }
  let vals = simplex.map(f);
  for (let k = 0; k < iters; k++) {
    const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    simplex = order.map((i) => simplex[i]); vals = order.map((i) => vals[i]);
    const cen = Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += simplex[i][j] / n;
    const pt = (a) => cen.map((c, j) => c + a * (simplex[n][j] - c));
    const xr = pt(-1), fr = f(xr);
    if (fr < vals[0]) { const xe = pt(-2), fe = f(xe); [simplex[n], vals[n]] = fe < fr ? [xe, fe] : [xr, fr]; }
    else if (fr < vals[n - 1]) { simplex[n] = xr; vals[n] = fr; }
    else {
      const xc = pt(0.5), fc = f(xc);
      if (fc < vals[n]) { simplex[n] = xc; vals[n] = fc; }
      else for (let i = 1; i <= n; i++) { simplex[i] = simplex[i].map((x, j) => simplex[0][j] + 0.5 * (x - simplex[0][j])); vals[i] = f(simplex[i]); }
    }
  }
  const i = vals.indexOf(Math.min(...vals));
  return { x: simplex[i], fx: vals[i] };
}

export async function fitEvent(points, { c = C } = {}) {
  const pts = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 8) throw new Error('Too few ridge points to fit a pass (need at least 8).');
  const ts = pts.map((p) => p[0]), fs = pts.map((p) => p[1]);
  const sorted = fs.slice().sort((a, b) => a - b);
  const fhi = sorted[Math.floor(0.97 * (sorted.length - 1))], flo = sorted[Math.floor(0.03 * (sorted.length - 1))];
  if (fhi - flo < 0.5) throw new Error('The curve is flat: no Doppler swing to fit.');
  const F0g = 2 * fhi * flo / (fhi + flo), vg = Math.max(15, c * (fhi - flo) / (fhi + flo));
  const fmid = (fhi + flo) / 2;
  let tcg = ts[0], best = Infinity;
  for (let i = 0; i < pts.length; i++) { const e = Math.abs(fs[i] - fmid); if (e < best) { best = e; tcg = ts[i]; } }
  // slope near the centre -> distance guess (MATH.md 3.3)
  let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
  for (let i = 0; i < pts.length; i++) if (Math.abs(ts[i] - tcg) < 4) { sx += ts[i]; sy += fs[i]; sxx += ts[i] ** 2; sxy += ts[i] * fs[i]; m++; }
  const slope = m > 3 ? (m * sxy - sx * sy) / (m * sxx - sx * sx) : -1;
  const dg = Math.min(20000, Math.max(100, F0g * vg * vg / (c * Math.max(0.05, Math.abs(slope)))));
  const scale = Math.max(0.3, (fhi - flo) / 20);
  const cost = ([lF0, lv, ld, tc]) => {
    const F0 = Math.exp(lF0), v = Math.exp(lv), d = Math.exp(ld);
    if (v >= 0.95 * c) return 1e12;
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const r = (fs[i] - modelF(ts[i] - tc, F0, v, d, c)) / scale;
      s += Math.abs(r) < 1 ? r * r : 2 * Math.abs(r) - 1;   // Huber
    }
    return s;
  };
  let r = nelderMead(cost, [Math.log(F0g), Math.log(vg), Math.log(dg), tcg], [0.05, 0.2, 0.4, 3]);
  r = nelderMead(cost, r.x, [0.01, 0.05, 0.1, 0.5]);
  const [F0, v, d] = r.x.slice(0, 3).map(Math.exp), t_c = r.x[3];
  let ss = 0;
  for (let i = 0; i < pts.length; i++) ss += (fs[i] - modelF(ts[i] - t_c, F0, v, d, c)) ** 2;
  const t0 = Math.min(...ts) - 20, t1 = Math.max(...ts) + 20, curve = [];
  for (let k = 0; k <= 200; k++) { const t = t0 + (t1 - t0) * k / 200; curve.push([t, modelF(t - t_c, F0, v, d, c)]); }
  const round = (x, q) => +(Math.round(x / q) * q).toFixed(q < 1 ? 1 : 0);
  return {
    t_cpa_audio: t_c + d / c, t_c, F0,
    v_mps: [round(v * 0.8, 0.1), round(v * 1.25, 0.1)],
    cpa_m: [Math.round(d * 0.7), Math.round(d * 1.5)],
    point: { v, d }, rms_hz: Math.sqrt(ss / pts.length), n: pts.length, curve,
  };
}

// ------------------------------------------------------------------ fetchFlights
const FIXTURES = [
  { id: 'scenario1', urls: [new URL('../demo/scenario1/tracks.json', import.meta.url), new URL('../../fixtures/scenario1/tracks.json', import.meta.url)],
    bbox: [40.4, -73.4, 41.2, -72.3], t0: 1717236000, t1: 1717250400, source: 'fixture:scenario1 (synthetic)' },
  { id: 'scenario2', urls: [new URL('../../fixtures/scenario2/tracks.json', import.meta.url)],
    bbox: [46.2, 7.2, 46.9, 8.6], t0: 1719990000, t1: 1720010000, source: 'fixture:scenario2 (synthetic)' },
  { id: 'colsto2026', urls: [new URL('../../fixtures/real/colsto_longisland/tracks_2026.json', import.meta.url)],
    bbox: [40.6, -73.86, 41.14, -73.14], t0: 1788825600, t1: 1788933600, source: 'fixture:colsto 2026-09-08 (adsb.lol)' },
];
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

async function fetchJsonWithProgress(url, signal, onProgress) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const total = +r.headers.get('content-length') || 0;
  if (!r.body || !total) return r.json();
  const reader = r.body.getReader(), chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress?.({ stage: 'download', frac: got / total, message: `${(got / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB` });
  }
  onProgress?.({ stage: 'parse', frac: 0 });
  return JSON.parse(await new Blob(chunks).text());
}

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function syntheticTracks(bbox, t0, t1) {
  const rnd = mulberry32(Math.round(bbox[0] * 1000 + bbox[1] * 7 + t0 / 3600));
  const [la0, lo0, la1, lo1] = bbox, latc = (la0 + la1) / 2, lonc = (lo0 + lo1) / 2;
  const kx = 111320 * Math.cos(latc * Math.PI / 180), ky = 110540;
  const span = Math.max((la1 - la0) * ky, (lo1 - lo0) * kx);
  const types = [['C172', 'prop', 55], ['PA28', 'prop', 58], ['SR22', 'prop', 75], ['R44', 'heli', 50],
    ['EC35', 'heli', 60], ['A320', 'jet', 140], ['B738', 'jet', 150], ['PC12', 'prop', 120]];
  const n = Math.round(20 + 8 * Math.max(1, (t1 - t0) / 3600)), out = [];
  for (let i = 0; i < Math.min(n, 200); i++) {
    const [type, category, v] = types[Math.floor(rnd() * types.length)];
    const hdg = rnd() * 2 * Math.PI, off = (rnd() - 0.5) * span;
    const alt = category === 'jet' ? 2000 + rnd() * 4000 : 300 + rnd() * 900;
    const tc = t0 + rnd() * (t1 - t0), len = span * 1.4, dur = len / v, pts = [];
    for (let s = -dur / 2; s <= dur / 2; s += 5) {
      const along = s * v, x = off * Math.cos(hdg + Math.PI / 2) + along * Math.cos(hdg), y = off * Math.sin(hdg + Math.PI / 2) + along * Math.sin(hdg);
      pts.push([tc + s, latc + y / ky, lonc + x / kx, alt]);
    }
    const icao = (0xa00000 + Math.floor(rnd() * 0xfffff)).toString(16);
    out.push({ id: `SYN${i}`, icao24: icao, callsign: `SYN${100 + i}`, type, category, points: pts });
  }
  return out;
}

export async function fetchFlights({ bbox, t0, t1, padS = 1800, duration_s = 0 }, { signal, onProgress } = {}) {
  const q0 = t0 - padS, q1 = t1 + duration_s + padS;
  onProgress?.({ stage: 'index', frac: 0, message: 'Looking up flight index' });
  await sleep(250, signal);
  const fx = FIXTURES.find((f) => overlaps(f.bbox, bbox) && f.t0 <= q1 && f.t1 >= q0);
  let tracks, source, notes = [];
  let all = null;
  if (fx) {
    // the deploy bundle ships only the demo copy (web/demo); fixtures/ exists in development only
    for (const u of fx.urls) {
      try { all = await fetchJsonWithProgress(u, signal, onProgress); break; } catch (e) { if (e?.name === 'AbortError') throw e; }
    }
    if (!all) notes.push(`Sample data for this area (${fx.id}) is not included in this build.`);
  }
  if (all) {
    const pad = 0.05;
    const bb = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad];
    tracks = [];
    for (const tr of all) {
      const pts = tr.points.filter((p) => p[0] >= q0 && p[0] <= q1 && p[1] >= bb[0] && p[1] <= bb[2] && p[2] >= bb[1] && p[2] <= bb[3]);
      if (pts.length >= 2) tracks.push({ ...tr, points: pts });
    }
    source = fx.source;
  } else {
    await sleep(500, signal);
    tracks = syntheticTracks(bbox, q0, q1);
    source = 'synthetic (stub: no data source for this region/time)';
    notes.push('No fixture covers this region and time, so the stub generated random tracks.');
  }
  onProgress?.({ stage: 'parse', frac: 1 });
  const counts = { prop: 0, jet: 0, heli: 0, unknown: 0 };
  for (const t of tracks) counts[counts[t.category] != null ? t.category : 'unknown']++;
  return { tracks, source, attribution: 'ADS-B data © adsb.lol contributors, ODbL 1.0', counts, notes };
}

// ------------------------------------------------------------------ geometry helpers
function enuFrame(lat0, lon0) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  return { x: (lon) => (lon - lon0) * kx, y: (lat) => (lat - lat0) * ky, lat: (y) => lat0 + y / ky, lon: (x) => lon0 + x / kx };
}
function interp(points, t) {
  let lo = 0, hi = points.length - 1;
  if (t <= points[0][0]) return points[0];
  if (t >= points[hi][0]) return points[hi];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (points[m][0] <= t) lo = m; else hi = m; }
  const a = points[lo], b = points[hi], u = (t - a[0]) / (b[0] - a[0] || 1);
  return [t, a[1] + u * (b[1] - a[1]), a[2] + u * (b[2] - a[2]), a[3] + u * (b[3] - a[3])];
}
function trackCpa(track, lat, lon, elev) {
  const E = enuFrame(lat, lon);
  let best = { d: Infinity, t: null };
  for (const p of track.points) {
    const d = Math.hypot(E.x(p[2]), E.y(p[1]), p[3] - elev);
    if (d < best.d) best = { d, t: p[0] };
  }
  return best;
}

// ------------------------------------------------------------------ runSearch
const STAGES = ['grid', 'cpa', 'filters', 'sim', 'score', 'refine'];
const SCENARIO1_BEST = { lat: 40.79354242756772, lon: -72.88244948685625, elev_m: 239.3, t_start_unix: 1717243199.6, flights: ['P1', 'P2'] };

export async function runSearch(input, { signal, onProgress } = {}) {
  const t0 = performance.now();
  const { region, events, tracks = [], settings = {} } = input;
  const grid_m = settings.grid_m || 100, topN = settings.topN || 10;
  const [la0, lo0, la1, lo1] = region.bbox;
  const latc = (la0 + la1) / 2;
  const kx = 111320 * Math.cos(latc * Math.PI / 180);
  const gridPoints = Math.max(1, Math.round(((la1 - la0) * 110540 / grid_m) * ((lo1 - lo0) * kx / grid_m)));
  const nTr = Math.max(1, tracks.length);
  const surv = {};
  const stage = async (name, ms, survivors, message) => {
    for (let k = 1; k <= 5; k++) { await sleep(ms / 5, signal); onProgress?.({ stage: name, frac: k / 5, survivors: k === 5 ? survivors : undefined, total: gridPoints, message }); }
    surv[name] = survivors;
  };
  const combos = gridPoints * Math.min(nTr, 50) ** Math.max(1, events.length);
  await stage('grid', 400, gridPoints, `${gridPoints.toLocaleString()} grid points at ${grid_m} m`);
  await stage('cpa', 600, Math.round(gridPoints * Math.min(nTr, 50)), 'Delayed CPA per point × flight');
  await stage('filters', 700, Math.max(12, Math.round(combos * 1e-6) + 40), 'Speed, CPA distance, offset and silence filters');
  await stage('sim', 600, surv.filters, 'Doppler simulation');
  await stage('score', 600, Math.min(surv.filters, 400), 'Spectrogram scoring');
  await stage('refine', 500, Math.min(surv.filters, 60), 'Refinement around the best points');

  // fake score field
  const isScenario1 = tracks.some((t) => t.id === 'P1') && tracks.some((t) => t.id === 'P2');
  const rnd = mulberry32(Math.round(la0 * 1e4 + lo0 * 1e3));
  let peak;
  if (isScenario1 && overlaps(region.bbox, [SCENARIO1_BEST.lat, SCENARIO1_BEST.lon, SCENARIO1_BEST.lat, SCENARIO1_BEST.lon])) peak = [SCENARIO1_BEST.lat, SCENARIO1_BEST.lon];
  else peak = [la0 + (0.3 + 0.4 * rnd()) * (la1 - la0), lo0 + (0.3 + 0.4 * rnd()) * (lo1 - lo0)];
  const blobs = [[...peak, 1, 0.01], [la0 + rnd() * (la1 - la0), lo0 + rnd() * (lo1 - lo0), 0.55, 0.012],
    [la0 + rnd() * (la1 - la0), lo0 + rnd() * (lo1 - lo0), 0.4, 0.01]];
  const nLat = 64, nLon = 64, values = new Array(nLat * nLon);
  let vmin = Infinity, vmax = -Infinity;
  for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) {
    const lat = la0 + (i + 0.5) / nLat * (la1 - la0), lon = lo0 + (j + 0.5) / nLon * (lo1 - lo0);
    let s = 0.08 * rnd();
    for (const [bl, bo, a, w] of blobs) s += a * Math.exp(-(((lat - bl) / w) ** 2 + ((lon - bo) * Math.cos(latc * Math.PI / 180) / w) ** 2));
    if (region.shape === 'circle' && region.radius_m) {
      const dx = (lon - region.center[1]) * kx, dy = (lat - region.center[0]) * 110540;
      if (Math.hypot(dx, dy) > region.radius_m) s = NaN;
    }
    if (s < 0.06) s = NaN;           // "filtered out"
    values[i * nLon + j] = s;
    if (Number.isFinite(s)) { vmin = Math.min(vmin, s); vmax = Math.max(vmax, s); }
  }
  // candidates: local maxima of the field, distinct by ≥ 3 cells
  const cells = [];
  for (let k = 0; k < values.length; k++) if (Number.isFinite(values[k])) cells.push(k);
  cells.sort((a, b) => values[b] - values[a]);
  const picked = [];
  for (const k of cells) {
    const i = Math.floor(k / nLon), j = k % nLon;
    if (picked.every((p) => Math.max(Math.abs(p.i - i), Math.abs(p.j - j)) >= 3)) picked.push({ i, j, k });
    if (picked.length >= topN) break;
  }
  const evs = events.slice().sort((a, b) => a.t_cpa_audio - b.t_cpa_audio);
  const candidates = picked.map(({ i, j, k }, rank) => {
    let lat = la0 + (i + 0.5) / nLat * (la1 - la0), lon = lo0 + (j + 0.5) / nLon * (lo1 - lo0);
    const elev = 30 + 40 * rnd();
    if (rank === 0 && isScenario1 && peak[0] === SCENARIO1_BEST.lat) {
      return { ...SCENARIO1_BEST, score: 2.59, F0: evs.map((e) => e.F0), assignments: evs.map((e, n) => ({ event: n, flight: SCENARIO1_BEST.flights[n] || SCENARIO1_BEST.flights[0], t_cpa_unix: SCENARIO1_BEST.t_start_unix + e.t_cpa_audio, cpa_m: (e.cpa_m[0] + e.cpa_m[1]) / 2 })) };
    }
    // assign, per event, the class-matching flight passing closest
    const assignments = [];
    let tStart = null;
    for (let n = 0; n < evs.length; n++) {
      const e = evs[n];
      const pool = tracks.filter((t) => e.cls === 'unknown' || t.category === e.cls || t.category === 'unknown');
      let best = null;
      for (const t of (pool.length ? pool : tracks)) {
        const cpa = trackCpa(t, lat, lon, elev);
        const tStartHyp = cpa.t + cpa.d / C - e.t_cpa_audio;
        const pen = tStart == null ? 0 : Math.abs(tStartHyp - tStart) / 10;
        const cost = cpa.d / 1000 + pen;
        if (!best || cost < best.cost) best = { cost, t, cpa };
      }
      if (!best) continue;
      if (tStart == null) tStart = best.cpa.t + best.cpa.d / C - e.t_cpa_audio;
      assignments.push({ event: n, flight: best.t.id, t_cpa_unix: best.cpa.t, cpa_m: best.cpa.d });
    }
    return { lat, lon, elev_m: elev, score: +(values[k] * 2.5).toFixed(3), flights: assignments.map((a) => a.flight),
      t_start_unix: tStart ?? input.time?.t0 ?? 0, F0: evs.map((e) => e.F0), assignments };
  });
  const field = { bbox: region.bbox, nLat, nLon, values, min: vmin, max: vmax };
  return { candidates, field, stats: { gridPoints, survivorsByStage: surv, elapsedMs: performance.now() - t0 } };
}

// ------------------------------------------------------------------ simulateCurves
export async function simulateCurves(candidate, { events, tracks, c = C, harmonics = [1, 2, 3] }) {
  const E = enuFrame(candidate.lat, candidate.lon);
  const obsZ = (candidate.elev_m || 0) + 1.5;
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const evs = events.slice().sort((a, b) => a.t_cpa_audio - b.t_cpa_audio);
  const out = [];
  evs.forEach((ev, n) => {
    const fid = candidate.assignments?.find((a) => a.event === n)?.flight ?? candidate.flights?.[n];
    const tr = byId.get(fid);
    if (!tr || tr.points.length < 2) return;
    const F0 = candidate.F0?.[n] ?? ev.F0;
    const pos = (t) => { const p = interp(tr.points, t); return [E.x(p[2]), E.y(p[1]), p[3]]; };
    const pts = [];
    for (let ta = ev.t_cpa_audio - 90; ta <= ev.t_cpa_audio + 90; ta += 0.5) {
      const trx = candidate.t_start_unix + ta;
      let te = trx;
      for (let it = 0; it < 6; it++) { const s = pos(te); te = trx - Math.hypot(s[0], s[1], s[2] - obsZ) / c; }
      if (te < tr.points[0][0] || te > tr.points[tr.points.length - 1][0]) continue;
      const s = pos(te), s2 = pos(te + 0.5), s1 = pos(te - 0.5);
      const v = [(s2[0] - s1[0]), (s2[1] - s1[1]), (s2[2] - s1[2])];
      const R = Math.hypot(s[0], s[1], s[2] - obsZ), u = [-s[0] / R, -s[1] / R, (obsZ - s[2]) / R];
      const vu = v[0] * u[0] + v[1] * u[1] + v[2] * u[2];
      pts.push([ta, F0 * c / (c - vu)]);
    }
    for (const h of harmonics) out.push({ event: n, flight: fid, harmonic: h, points: pts.map(([t, f]) => [t, f * h]) });
  });
  return out;
}

export const STAGE_ORDER = STAGES;
