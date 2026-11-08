// Historical ADS-B in the browser: adsb.lol globe_history via the Worker proxy (worker/src/index.js).
// Mirrors ref/data/fetch_adsb.py (INDEX mode).  Pure ES module (browser + Node 18+).
//
//   import { fetchTracks } from './adsb.js';
//   const tracks = await fetchTracks({ worker: 'https://<worker>.workers.dev', bbox: [41.2, 1.7, 41.9, 2.5],
//                                      t0: 1793520000, t1: 1793548800, types });   // contract flight tracks
//
// Flow: per UTC day and feed -> per 0.5 deg cell index shard (/adsb/index/<tag>/<cell>.json, built by
// ref/data/build_index.py) -> select traces that were low enough in the window -> /adsb/range for each
// trace (gzip JSON) -> parse readsb trace -> contract tracks (alt converted to MSL with the shard's geoid N).

const FT = 0.3048;
const LEG_GAP_S = 300;
export const CELL_DEG = 0.5;

export function cellId(lat, lon) {
  return (Math.floor(lat / CELL_DEG) + 180) * 1000 + (Math.floor(lon / CELL_DEG) + 360);
}

export function cellsForBbox([la0, lo0, la1, lo1]) {
  const out = [];
  for (let i = Math.floor(la0 / CELL_DEG); i <= Math.floor(la1 / CELL_DEG); i++)
    for (let j = Math.floor(lo0 / CELL_DEG); j <= Math.floor(lo1 / CELL_DEG); j++) out.push((i + 180) * 1000 + (j + 360));
  return out;
}

export function tagFor(tUnix, feed = 'prod') {
  const d = new Date(tUnix * 1000).toISOString();
  return `v${d.slice(0, 4)}.${d.slice(5, 7)}.${d.slice(8, 10)}-planes-readsb-${feed}-0`;
}

/**
 * Where a shard's byte offsets point: {release, repo}.  release = the shard's real release tag (default: the canonical
 * tag); repo = 'YYYY' only when the shard's globe_history_YYYY differs from the release tag's year (else undefined).
 */
export function rangeSource(tag, sh = {}) {
  const release = typeof sh.release === 'string' && /^v\d{4}\.\d{2}\.\d{2}-planes-readsb-[a-z]+-(\d|0tmp)$/.test(sh.release) ? sh.release : tag;
  const m = /^globe_history_(\d{4})$/.exec(sh.repo || '');
  return { release, repo: m && m[1] !== release.slice(1, 5) ? m[1] : undefined };
}

export function categoryFor(type, types) {
  const e = type && types ? types[type] : null;
  return e ? e[0] : 'unknown';
}

/** fetch with retry + exponential backoff on network errors, 429 and 5xx (404 and other 4xx are returned). */
export async function fetchRetry(f, url, { retries = 3, baseMs = 300, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    let wait = baseMs * 2 ** i;
    try {
      const r = await f(url);
      if (r.status !== 429 && r.status < 500) return r;
      last = new Error(`HTTP ${r.status}`);
      const ra = Number(r.headers?.get?.('Retry-After'));
      if (r.status === 429 && ra > 0) wait = Math.min(30, ra) * 1000; // Worker rate limit: honour Retry-After
      // 502/503/504 (Worker already retried upstream): honour a short Retry-After, capped so one bad trace cannot stall a slot
      else if (ra > 0) wait = Math.max(wait, Math.min(3, ra) * 1000);
    } catch (e) { if (e?.name === 'AbortError') throw e; last = e; }
    if (i < retries) await sleep(wait);
  }
  const err = new Error(`${url}: ${last?.message || last} (after ${retries + 1} attempts)`);
  // fetch() rejects with a TypeError only when the request never got an HTTP answer (offline, DNS, CORS, CSP)
  err.code = last instanceof TypeError ? 'network' : 'http';
  throw err;
}

async function gunzip(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(s).text();
}

/**
 * readsb trace JSON -> contract tracks inside bbox/window.
 * geoidN: metres (number, or (lat,lon)=>N).  baroOffset: (t)=>metres|null for baro-only points.
 * Trace point: [dt, lat, lon, alt_baro_ft|"ground"|null, gs_kt, track, flags, vrate, extra|null,
 *               source, alt_geom_ft (WGS84 ellipsoid), geom_rate, ias, roll]
 */
export function traceToTracks(d, { bbox, t0, t1, geoidN = 0, baroOffset = () => null, types = null }) {
  const [la0, lo0, la1, lo1] = bbox;
  const N = typeof geoidN === 'function' ? geoidN : () => geoidN;
  const base = d.timestamp || 0;
  const type = d.t || null;
  let category = categoryFor(type, types);
  const legs = [];
  let cur = [], lastT = null, callsign = null;
  for (const p of d.trace || []) {
    const t = base + p[0], flags = typeof p[6] === 'number' ? p[6] : 0;
    const extra = p[8] && typeof p[8] === 'object' ? p[8] : null;
    if (extra?.flight) callsign = extra.flight.trim() || callsign;
    if (category === 'unknown' && extra?.category === 'A7') category = 'heli';
    const lat = p[1], lon = p[2];
    const inside = t >= t0 && t <= t1 && lat != null && lat >= la0 && lat <= la1 && lon >= lo0 && lon <= lo1 && p[3] !== 'ground';
    if (!inside) { if (cur.length) legs.push(cur); cur = []; lastT = null; continue; }
    if (cur.length && ((flags & 2) || (lastT != null && t - lastT > LEG_GAP_S))) { legs.push(cur); cur = []; }
    let geom = typeof p[10] === 'number' ? p[10] : null;
    let baro = typeof p[3] === 'number' ? p[3] : null;
    if (baro != null && (flags & 8)) { geom = geom ?? baro; baro = null; }
    if (typeof p[9] === 'string' && p[9].startsWith('tisb') && baro != null) geom = null; // TIS-B geom unreliable
    if (lastT != null && t <= lastT) continue; // duplicate / out-of-order timestamp
    let alt;
    if (geom != null) alt = geom * FT - N(lat, lon);
    else if (baro != null) alt = baro * FT + (baroOffset(t) ?? 0);
    else continue;
    cur.push([Math.round(t * 100) / 100, lat, lon, Math.round(alt * 10) / 10]);
    // D15 optional reported velocity [gs m/s, track deg, vrate m/s] (geom rate, else baro rate), aligned with points
    const gs = typeof p[4] === 'number' ? p[4] * 0.514444 : null, trk = typeof p[5] === 'number' ? p[5] : null;
    const vr = typeof p[11] === 'number' ? p[11] * 0.00508 : typeof p[7] === 'number' ? p[7] * 0.00508 : null;
    (cur.vel ||= []).push([gs != null ? Math.round(gs * 100) / 100 : null, trk, vr != null ? Math.round(vr * 100) / 100 : null]);
    lastT = t;
  }
  if (cur.length) legs.push(cur);
  return legs.filter((l) => l.length >= 2).map((pts) => ({
    id: `${d.icao}_${Math.floor(pts[0][0])}`, icao24: d.icao, callsign, type, category, points: Array.from(pts),
    reg: d.r ?? null, desc: d.desc ?? null,
    ...(pts.vel && pts.vel.some((v) => v[0] != null) ? { vel: pts.vel } : {}),
  }));
}

/** Pairs (t, geom_msl - baro) from traces carrying both, used to correct baro-only (MLAT) points. */
export function baroCalibration(traces, { bbox, t0, t1, geoidN = 0 }) {
  const [la0, lo0, la1, lo1] = bbox;
  const pairs = [];
  for (const d of traces) for (const p of d.trace || []) {
    const t = (d.timestamp || 0) + p[0];
    if (t < t0 - 1800 || t > t1 + 1800 || p[1] < la0 || p[1] > la1 || p[2] < lo0 || p[2] > lo1) continue;
    if (typeof p[3] === 'number' && p[3] < 10000 && typeof p[10] === 'number' && !(p[6] & 8) &&
        !(typeof p[9] === 'string' && p[9].startsWith('tisb'))) {
      const n = typeof geoidN === 'function' ? geoidN(p[1], p[2]) : geoidN;
      pairs.push([t, p[10] * FT - n - p[3] * FT]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
  const all = median(pairs.map((q) => q[1]));
  return (t) => {
    if (pairs.length < 5) return null;
    const w = pairs.filter((q) => Math.abs(q[0] - t) <= 1800).map((q) => q[1]);
    return w.length >= 5 ? median(w) : all;
  };
}

/**
 * Completeness of the adsb.lol releases for the UTC days of [t0, t1]: reads /adsb/index/<tag>/day.json (written by
 * ref/data/build_index.py).  Returns [{day, feed, status: ok|partial|empty|missing|unknown, n_traces, ratio, note}].
 * A missing mlatonly release (normal before ~2024-03) is reported, never thrown.
 */
export async function fetchDayStatus({ worker, t0, t1, feeds = ['prod', 'mlatonly'], fetch: f = globalThis.fetch.bind(globalThis) }) {
  const out = [];
  for (let t = Math.floor(t0 / 86400) * 86400; t <= t1; t += 86400) for (const feed of feeds) {
    const day = new Date(t * 1000).toISOString().slice(0, 10);
    try {
      const r = await fetchRetry(f, `${worker}/adsb/index/${tagFor(t, feed)}/day.json`, { retries: 1 });
      out.push(r.ok ? await r.json() : { day, feed, status: 'unknown', note: `day.json HTTP ${r.status} (not built)` });
    } catch (e) { out.push({ day, feed, status: 'unknown', note: String(e.message || e) }); }
  }
  return out;
}

const RANGE_BREAKER = 8; // consecutive failed trace downloads before retries are dropped (GitHub release CDN outage)

export async function fetchTracks({ worker, bbox, t0, t1, feeds = ['prod', 'mlatonly'], maxAltFt = 20000,
  types = null, skipJets = false, fetch: f = globalThis.fetch.bind(globalThis), concurrency = 8, onProgress = () => {},
  retry = {} }) {
  // Never throws for a missing day/feed or a failing trace: see out.days / out.failed / out.warnings.
  // skipJets: drop traces whose type designator is a known jet before downloading (LELL day: 39 MB -> 1.3 MB)
  const days = [];
  for (let t = Math.floor(t0 / 86400) * 86400; t <= t1; t += 86400) days.push(t);
  const jobs = [], failed = [];
  let geoidN = 0, nN = 0, idxTried = 0, idxNet = 0, idxErr = null;
  for (const day of days) for (const feed of feeds) {
    const tag = tagFor(day, feed);
    for (const cell of cellsForBbox(bbox)) {
      let r;
      idxTried++;
      try { r = await fetchRetry(f, `${worker}/adsb/index/${tag}/${cell}.json`, retry); } catch (e) {
        if (e?.name === 'AbortError') throw e;
        if (e?.code === 'network') { idxNet++; idxErr = e; }
        failed.push(String(e.message || e)); continue;
      }
      if (r.status === 404) continue; // feed/day/cell not indexed (e.g. no mlatonly release that day)
      if (!r.ok) { failed.push(`index ${tag}/${cell}: HTTP ${r.status}`); continue; }
      const sh = await r.json();
      geoidN += sh.geoid_N; nN++;
      // F1: the bytes live in the real release (-0tmp/-1 re-runs) and repo (Dec 31 can be in next year's repo)
      const rel = rangeSource(tag, sh);
      for (const [icao, type, part, start, size, tmin, tmax, minAlt] of sh.traces) {
        if (skipJets && categoryFor(type, types) === 'jet') continue;
        if (tmax >= t0 && tmin <= t1 && minAlt <= maxAltFt) jobs.push({ tag, ...rel, icao, part, start, size });
      }
    }
  }
  if (idxTried && idxNet === idxTried) { // not a single index answer: the data server is unreachable
    const err = new Error(`ADS-B data server unreachable (${worker}): ${idxErr?.message || idxErr}`);
    err.code = 'unreachable';
    throw err;
  }
  geoidN = nN ? geoidN / nN : 0; // N varies < ~3 m over a 150 km bbox; one value is enough
  const uniq = [...new Map(jobs.map((j) => [`${j.repo || ''}/${j.release}/${j.part}/${j.start}`, j])).values()];
  const traces = [];
  let done = 0, streak = 0;
  const total = uniq.length;
  async function worker1() {
    while (uniq.length) {
      const j = uniq.pop();
      try {
        // The Worker retries GitHub 3x itself; 3 client attempts more, then the trace is counted in `failed` and skipped.
        // Circuit breaker: after RANGE_BREAKER consecutive failures (upstream archive down) one attempt per trace only.
        const opt = streak >= RANGE_BREAKER ? { ...retry, retries: 0 } : { retries: 2, ...retry };
        const r = await fetchRetry(f, `${worker}/adsb/range?tag=${j.release}&part=${j.part}&start=${j.start}&end=${j.start + j.size - 1}${j.repo ? `&repo=${j.repo}` : ''}`, opt);
        if (!r.ok) throw new Error(`range ${j.icao}: HTTP ${r.status}`);
        traces.push({ feed: j.tag.includes('mlatonly') ? 'mlatonly' : 'prod',
          d: JSON.parse(await gunzip(new Uint8Array(await r.arrayBuffer()))) });
        streak = 0;
      } catch (e) { if (e?.name === 'AbortError') throw e; streak++; failed.push(`${j.icao}: ${e.message || e}`); }
      try { onProgress(++done, total); } catch { /* a broken progress callback must not fail the download */ }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker1));
  const opt = { bbox, t0, t1, geoidN, types };
  const baroOffset = baroCalibration(traces.map((x) => x.d), opt);
  // prod first; mlatonly tracks only for aircraft not already present from prod
  traces.sort((a, b) => (a.feed === b.feed ? 0 : a.feed === 'prod' ? -1 : 1));
  const seen = new Set(), out = [];
  for (const { feed, d } of traces) {
    if (feed !== 'prod' && seen.has(d.icao)) continue;
    const tr = traceToTracks(d, { ...opt, baroOffset });
    if (tr.length) seen.add(d.icao);
    out.push(...tr);
  }
  out.sort((a, b) => a.points[0][0] - b.points[0][0]);
  out.days = await fetchDayStatus({ worker, t0, t1, feeds, fetch: f });
  out.failed = failed;
  out.warnings = dayWarnings(out.days).concat(failed.length ? [`${failed.length} index/trace downloads failed`] : []);
  return out;
}

function dayWarnings(days) {
  return days.filter((d) => d.status !== 'ok' && d.status !== 'unknown').map((d) => `${d.day} ${d.feed}: ${d.status}`);
}

/**
 * FAST PATH: pre-extracted per-cell/per-day tiles (worker /adsb/tile/<date>/<cell>.json, built by
 * ref/data/build_tiles.py).  Non-jet tracks only, already in contract format (alt MSL).  One request per cell-day.
 * Tracks of the same aircraft split at cell borders are merged back and re-split at gaps > 300 s.
 */
export async function fetchTracksFromTiles({ worker, bbox, t0, t1, fetch: f = globalThis.fetch.bind(globalThis),
  retry = {}, dayStatus = true }) {
  const days = [];
  for (let t = Math.floor(t0 / 86400) * 86400; t <= t1; t += 86400) days.push(new Date(t * 1000).toISOString().slice(0, 10));
  const urls = days.flatMap((d) => cellsForBbox(bbox).map((c) => `${worker}/adsb/tile/${d}/${c}.json`));
  const failed = [];
  const tiles = await Promise.all(urls.map(async (u) => {
    try {
      const r = await fetchRetry(f, u, retry);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { failed.push(`${u}: ${e.message || e}`); return null; }
  }));
  const missing = urls.filter((_, i) => !tiles[i]);
  const [la0, lo0, la1, lo1] = bbox;
  const byIcao = new Map();
  for (const tile of tiles) for (const tr of tile?.tracks || []) {
    // keep the optional per-point reported velocity (D15 'vel') attached to its point through filter/sort/split
    const pts = [];
    tr.points.forEach((p, i) => { if (p[0] >= t0 && p[0] <= t1 && p[1] >= la0 && p[1] <= la1 && p[2] >= lo0 && p[2] <= lo1) pts.push({ p, v: tr.vel ? tr.vel[i] : null }); });
    if (!pts.length) continue;
    const e = byIcao.get(tr.icao24);
    if (e) e.pv.push(...pts); else { const { vel, ...rest } = tr; byIcao.set(tr.icao24, { ...rest, pv: pts }); }
  }
  const out = [];
  for (const tr0 of byIcao.values()) {
    const { pv, ...tr } = tr0;
    pv.sort((a, b) => a.p[0] - b.p[0]);
    let cur = [];
    const flush = () => {
      if (cur.length >= 2) {
        const o = { ...tr, id: `${tr.icao24}_${Math.floor(cur[0].p[0])}`, points: cur.map((q) => q.p) };
        if (cur.some((q) => q.v && q.v[0] != null)) o.vel = cur.map((q) => q.v || [null, null, null]);
        out.push(o);
      }
      cur = [];
    };
    for (const q of pv) {
      if (cur.length && q.p[0] <= cur[cur.length - 1].p[0]) continue;
      if (cur.length && q.p[0] - cur[cur.length - 1].p[0] > LEG_GAP_S) flush();
      cur.push(q);
    }
    flush();
  }
  out.sort((a, b) => a.points[0][0] - b.points[0][0]);
  out.missing = missing; // cell-days not built yet or failed (caller may fall back to fetchTracks)
  out.failed = failed;
  out.days = dayStatus ? await fetchDayStatus({ worker, t0, t1, fetch: f }) : [];
  out.warnings = dayWarnings(out.days).concat(missing.length ? [`${missing.length} tile(s) unavailable`] : []);
  return out;
}

// ------------------------------------------------------------------ coverage check
/**
 * Low non-jet traffic actually received (same as ref/data/fetch_adsb.py coverage_from_tracks): per bin
 * (default 1 h), tracks / aircraft with >= 1 point below maxAltM MSL in [t0, t1] and, if center=[lat,lon] and
 * radiusKm are given, within radiusKm of the site.
 */
export function coverage(tracks, { t0, t1, center = null, radiusKm = null, maxAltM = 1500, binS = 3600 }) {
  const nb = Math.max(1, Math.ceil((t1 - t0) / binS));
  const bins = Array.from({ length: nb }, (_, i) => ({ t_start: t0 + i * binS, n_tracks: 0, ac: new Set() }));
  const all = new Set();
  let ntr = 0;
  const cos = center ? Math.cos((center[0] * Math.PI) / 180) : 1, r2 = radiusKm != null ? radiusKm * radiusKm : null;
  for (const tr of tracks) {
    if (tr.category === 'jet') continue;
    const hit = new Set();
    for (const [t, la, lo, alt] of tr.points) {
      if (t < t0 || t > t1 || alt == null || alt >= maxAltM) continue;
      if (center && r2 != null) {
        const dy = (la - center[0]) * 111.195, dx = (lo - center[1]) * 111.195 * cos;
        if (dx * dx + dy * dy > r2) continue;
      }
      hit.add(Math.min(nb - 1, Math.floor((t - t0) / binS)));
    }
    if (!hit.size) continue;
    ntr++; all.add(tr.icao24);
    for (const b of hit) { bins[b].n_tracks++; bins[b].ac.add(tr.icao24); }
  }
  return { t0, t1, center, radius_km: radiusKm, max_alt_m: maxAltM, n_tracks: ntr, n_aircraft: all.size,
    tracks_per_h: Math.round((ntr / Math.max((t1 - t0) / 3600, 1e-9)) * 100) / 100,
    per_bin: bins.map((b) => ({ t_start: b.t_start, n_tracks: b.n_tracks, n_aircraft: b.ac.size })) };
}

/**
 * Baseline from the fast-path tiles of other days at the same UTC time (default -28..+14 days, weekly):
 * [{day, n_aircraft}] counted exactly like coverage() (same site/radius).  Days without tiles are skipped.
 */
export async function coverageBaseline({ worker, bbox, t0, t1, center = null, radiusKm = null, maxAltM = 1500,
  offsetsDays = [-28, -21, -14, -7, 7, 14], fetch: f = globalThis.fetch.bind(globalThis) }) {
  const res = await Promise.all(offsetsDays.map(async (k) => {
    const a = t0 + k * 86400, b = t1 + k * 86400;
    if (b > Date.now() / 1000 - 86400) return null; // not published yet
    const tr = await fetchTracksFromTiles({ worker, bbox, t0: a, t1: b, fetch: f, dayStatus: false, retry: { retries: 1 } });
    if (tr.missing.length === cellsForBbox(bbox).length * Math.ceil((b - Math.floor(a / 86400) * 86400) / 86400)) return null;
    return { day: new Date(a * 1000).toISOString().slice(0, 10), n_aircraft: coverage(tr, { t0: a, t1: b, center, radiusKm, maxAltM }).n_aircraft };
  }));
  return res.filter(Boolean);
}

/** {level: ok|weak|poor, messages[]} for the UI.  baseline: [{n_aircraft}] (coverageBaseline), days: fetchDayStatus. */
// Per-hour rate of low non-jet tracks near the site (5 km, < 1500 m MSL) within the recording's plausible window:
// < 1/h poor, 1-3/h weak, > 3/h ok (same as ref/data/fetch_adsb.py).  4 aircraft in 4.5 h (Egelsbach 2023-09-12) is poor.
export const COVERAGE_POOR_PER_H = 1, COVERAGE_OK_PER_H = 3;
export const NO_ADSB_NOTE = 'Aircraft without ADS-B (many GA in the circuit) cannot be matched; marking only flyovers likely to be ' +
  'transponder-equipped (louder/faster, overflying rather than circuit traffic) helps.';

/**
 * {level: ok|weak|poor, messages[]} for the UI.  Compute `cov` with coverage() over the recording's plausible time
 * window only.  baseline: [{n_aircraft}] (coverageBaseline), days: fetchDayStatus.
 */
export function coverageVerdict(cov, { baseline = [], days = [] } = {}) {
  const msgs = [];
  let level = 'ok';
  const rate = cov.tracks_per_h, hrs = (cov.t1 - cov.t0) / 3600;
  const what = `${cov.n_tracks} low light-aircraft track(s) / ${cov.n_aircraft} aircraft received${cov.radius_km != null ? ` within ${cov.radius_km} km` : ''} below ${cov.max_alt_m} m MSL in ${hrs.toFixed(1)} h (${rate.toFixed(1)}/h)`;
  if (rate < COVERAGE_POOR_PER_H) {
    level = 'poor';
    msgs.push(`ADS-B coverage of low-flying aircraft here on that date is poor: ${what}; results are unlikely. ${NO_ADSB_NOTE}`);
  } else if (rate <= COVERAGE_OK_PER_H) {
    level = 'weak';
    msgs.push(`ADS-B coverage of low-flying aircraft is weak: ${what}. ${NO_ADSB_NOTE}`);
  }
  if (baseline.length) {
    const v = baseline.map((b) => b.n_aircraft).sort((a, b) => a - b), med = v[v.length >> 1];
    if (med > 0 && cov.n_aircraft < 0.25 * med) {
      level = 'poor';
      msgs.push(`${cov.n_aircraft} light aircraft received vs a median of ${med} on ${v.length} other day(s) at the same time: receivers or the archive were probably down.`);
    }
  }
  for (const d of days) {
    if (d.feed === 'prod' && (d.status === 'partial' || d.status === 'empty')) {
      level = 'poor';
      msgs.push(`adsb.lol archive for ${d.day} is ${d.status}${d.note ? ` (${d.note})` : ''}.`);
    } else if (['partial', 'empty', 'missing'].includes(d.status)) {
      msgs.push(`adsb.lol ${d.feed} feed for ${d.day} is ${d.status} (MLAT-only aircraft may be missing).`);
    }
  }
  return { level, messages: msgs };
}
