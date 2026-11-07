// Lane L: real live-polling test against adsb.lol (and a light adsb.fi comparison).
//   node web/tests/live_poll.mjs            # env: MIN=10 LAT=41.52 LON=2.10 NM=25 POLL_S=2 OUT=<dir>
// Polls the re-api point endpoint, builds tracks, then backfills trace_full/trace_recent for the aircraft seen and
// compares the two. Writes <OUT>/live_tracks_poll.json, live_tracks_trace.json, live_summary.json.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { LiveTrackBuilder, backfill, pointUrl, bboxAround } from '../dev/live/adsb-live.js';
import { ServerClock, wallNow } from '../dev/live/clock.js';

const env = process.env;
const MIN = +(env.MIN || 10), LAT = +(env.LAT || 41.52), LON = +(env.LON || 2.10), NM = +(env.NM || 25);
const POLL_S = +(env.POLL_S || 2), OUT = env.OUT || '.';
const LOL = 'https://api.adsb.lol', LOLG = 'https://adsb.lol', FI = 'https://opendata.adsb.fi/api';
const UA = { 'User-Agent': 'doppler-geoloc-research/0.1 (feasibility test, low rate)' };
const types = JSON.parse(readFileSync(new URL('../data/types.json', import.meta.url)));
mkdirSync(OUT, { recursive: true });

const clock = new ServerClock(), poll = new LiveTrackBuilder();
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? +s[Math.floor(p * (s.length - 1))].toFixed(3) : null; };
const stats = { polls: 0, errors: 0, http: {}, rtt: [], seenPos: [], snapAgeMs: [], fiSnapAgeMs: [], fiSeenPos: [], ac: [], rateHdr: null };

const tStart = Date.now() / 1000;
let nextFi = 0;
while (Date.now() / 1000 - tStart < MIN * 60) {
  const t0 = Date.now();
  const sendMs = wallNow();
  try {
    const r = await fetch(pointUrl(LOL, LAT, LON, NM), { headers: UA });
    const recvMs = wallNow();
    stats.http[r.status] = (stats.http[r.status] || 0) + 1;
    if (r.ok) {
      const js = await r.json();
      clock.add({ sendMs, recvMs, serverMs: js.now, dateHeader: r.headers.get('date') });
      stats.rtt.push(recvMs - sendMs);
      stats.snapAgeMs.push(recvMs - js.now); // includes the clock offset; corrected below
      for (const a of js.ac || []) if (a.seen_pos != null) stats.seenPos.push(a.seen_pos);
      stats.ac.push((js.ac || []).length);
      poll.addSnapshot(js);
      stats.polls++;
    } else stats.errors++;
  } catch { stats.errors++; }
  if (Date.now() >= nextFi) { // adsb.fi: one request every 10 s (its limit is 1/s)
    nextFi = Date.now() + 10000;
    try {
      const s = wallNow(), r = await fetch(`${FI}/v3/lat/${LAT}/lon/${LON}/dist/${NM}`, { headers: UA }), e = wallNow();
      if (r.ok) { const js = await r.json(); stats.fiSnapAgeMs.push(e - (js.now > 1e11 ? js.now : js.now * 1000));
        for (const a of js.ac || js.aircraft || []) if (a.seen_pos != null) stats.fiSeenPos.push(a.seen_pos); }
      else stats.http['fi_' + r.status] = (stats.http['fi_' + r.status] || 0) + 1;
    } catch { stats.http.fi_err = (stats.http.fi_err || 0) + 1; }
  }
  const wait = POLL_S * 1000 - (Date.now() - t0);
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  if (stats.polls % 30 === 0) console.log(`[${((Date.now() / 1000 - tStart) / 60).toFixed(1)} min] polls ${stats.polls} ac ${poll.ac.size} err ${stats.errors}`);
}
const tEnd = Date.now() / 1000;
const est = clock.estimate();

// polled tracks inside the recording window
const bbox = bboxAround(LAT, LON, NM * 1852);
const tPoll = poll.toTracks({ bbox, t0: tStart - 5, t1: tEnd, types });
// per-aircraft update interval from polling (unique position times)
const pollDt = [];
for (const d of poll.traces()) for (let i = 1; i < d.trace.length; i++) pollDt.push(d.trace[i][0] - d.trace[i - 1][0]);

// backfill: aircraft seen, below 3000 m at some point (GA/approach) - cap 60
const low = [...new Set(tPoll.filter((t) => Math.min(...t.points.map((p) => p[3])) < 3000).map((t) => t.icao24))].slice(0, 60);
const bt0 = Date.now();
const tb = new LiveTrackBuilder();
let traceHdr = null;
const f = async (u, o) => { const r = await fetch(u, { ...o, headers: UA }); traceHdr ??= r.headers.get('x-ratelimit-limit'); return r; };
const bf = await backfill(tb, low, { base: LOLG, rps: 4, f });
const backfillS = (Date.now() - bt0) / 1000;
// look back 30 min before the poll started: does the trace give the past?
const tTr = tb.toTracks({ bbox, t0: tStart - 1800, t1: tEnd + 60, types });
const trDt = [], trLagS = [], cover = [];
for (const d of tb.traces()) {
  const pts = d.trace.filter((p) => p[0] >= tStart - 1800);
  for (let i = 1; i < pts.length; i++) trDt.push(pts[i][0] - pts[i - 1][0]);
  if (pts.length) trLagS.push(tEnd - pts[pts.length - 1][0]);
  cover.push(pts.length ? (Math.min(tEnd, pts[pts.length - 1][0]) - Math.max(tStart - 1800, pts[0][0])) / 60 : 0);
}
// compare polled vs trace positions at the same instants (linear interp in the trace, gaps <= 10 s)
const pos = new Map(tb.traces().map((d) => [d.icao, d.trace]));
const dH = [], dV = [];
for (const t of tPoll) {
  const tr = pos.get(t.icao24); if (!tr) continue;
  const all = tb.toTracks({ bbox, t0: tStart - 60, t1: tEnd + 60, types }).filter((x) => x.icao24 === t.icao24).flatMap((x) => x.points);
  for (const p of t.points) {
    let j = all.findIndex((x) => x[0] >= p[0]); if (j <= 0) continue;
    const a = all[j - 1], b = all[j]; if (b[0] - a[0] > 10 || b[0] === p[0]) continue;
    const w = (p[0] - a[0]) / (b[0] - a[0]);
    const la = a[1] + w * (b[1] - a[1]), lo = a[2] + w * (b[2] - a[2]), al = a[3] + w * (b[3] - a[3]);
    dH.push(Math.hypot((p[1] - la) * 111320, (p[2] - lo) * 111320 * Math.cos(LAT * Math.PI / 180))); dV.push(Math.abs(p[3] - al));
  }
}

const off = est.offsetMs ?? 0;
const summary = {
  site: { LAT, LON, NM }, window_utc: [new Date(tStart * 1000).toISOString(), new Date(tEnd * 1000).toISOString()],
  polls: stats.polls, poll_s: POLL_S, errors: stats.errors, http: stats.http,
  aircraft_seen: poll.ac.size, ac_per_snapshot: [q(stats.ac, 0), q(stats.ac, 0.5), q(stats.ac, 1)],
  rtt_ms: [q(stats.rtt, 0.1), q(stats.rtt, 0.5), q(stats.rtt, 0.9)],
  clock: { offset_ms_server_minus_local: off, min_rtt_ms: est.minRttMs, n: est.n, date_header_bound_ms: est.dateBoundMs },
  lol_snapshot_age_ms_p10_50_90: [q(stats.snapAgeMs.map((x) => x + off), 0.1), q(stats.snapAgeMs.map((x) => x + off), 0.5), q(stats.snapAgeMs.map((x) => x + off), 0.9)],
  lol_seen_pos_s_p10_50_90: [q(stats.seenPos, 0.1), q(stats.seenPos, 0.5), q(stats.seenPos, 0.9)],
  fi_snapshot_age_ms_p10_50_90: [0.1, 0.5, 0.9].map((p) => q(stats.fiSnapAgeMs.map((x) => x + off), p)),
  fi_seen_pos_s_p10_50_90: [q(stats.fiSeenPos, 0.1), q(stats.fiSeenPos, 0.5), q(stats.fiSeenPos, 0.9)],
  poll_tracks: tPoll.length, poll_points: tPoll.reduce((s, t) => s + t.points.length, 0),
  poll_dt_s_p10_50_90: [q(pollDt, 0.1), q(pollDt, 0.5), q(pollDt, 0.9)],
  backfill: { hexes: low.length, ok: bf.ok, failed: bf.failed, seconds: backfillS, ratelimit_header: traceHdr },
  trace_tracks_past30: tTr.length, trace_points: tTr.reduce((s, t) => s + t.points.length, 0),
  trace_dt_s_p10_50_90: [q(trDt, 0.1), q(trDt, 0.5), q(trDt, 0.9)],
  trace_last_point_lag_s_p10_50_90: [q(trLagS, 0.1), q(trLagS, 0.5), q(trLagS, 0.9)],
  trace_coverage_min_p10_50_90: [q(cover, 0.1), q(cover, 0.5), q(cover, 0.9)],
  poll_vs_trace: { n: dH.length, horiz_m_p50_90_99: [q(dH, 0.5), q(dH, 0.9), q(dH, 0.99)], vert_m_p50_90: [q(dV, 0.5), q(dV, 0.9)] },
};
writeFileSync(`${OUT}/live_tracks_poll.json`, JSON.stringify(tPoll));
writeFileSync(`${OUT}/live_tracks_trace.json`, JSON.stringify(tTr));
writeFileSync(`${OUT}/live_summary.json`, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
