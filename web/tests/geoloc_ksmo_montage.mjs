// Lane D (D12): BLIND montage run on fixtures/real/ksmo_2024-07-09.
//   node web/tests/geoloc_ksmo_montage.mjs [workers=16] [--chrono] [--seed=7]
// Blind inputs only: audio.wav, tracks.json, the date. Cuts from web/ui/segment.js (detectCuts). Per clip one automatic
// "click" at the strongest whitened tonal point (50-400 Hz) extended with Lane E's extendRidge; flyovers kept.
// Region: 15 km radius circle whose centre is 5-10 km from KSMO at a random bearing. Window: the local day.
// Evaluation afterwards (not used by the search): Lane F's combined estimate and clip labels (ref/validation/out).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './geoloc_helpers.mjs';
import { parseWav } from '../engine/audio.js';
import { stft } from '../engine/stft.js';
import { extendRidge, REAL_AUDIO_OPTS } from '../engine/ridge-extend.js';
import { detectCuts } from '../ui/segment.js';
import * as Engine from '../engine/geoloc.js';
import { createGeolocPool, nodeWorkerFactory } from '../workers/geoloc-pool.js';

const args = process.argv.slice(2);
const W = +(args.find((a) => /^\d+$/.test(a)) ?? 16), chrono = args.includes('--chrono');
const seedArg = +(args.find((a) => a.startsWith('--seed='))?.slice(7) ?? 7);
// --tails: NON-BLIND variant, tail numbers per clip as a user would type them from the video description
// (taken from Lane F's clip labels, ref/validation/out/ksmo_clips.json)
const tails = args.includes('--tails') ? JSON.parse(readFileSync(path.join(ROOT, 'ref/validation/out/ksmo_clips.json'))).clips : null;
const D = path.join(ROOT, 'fixtures/real/ksmo_2024-07-09');
const wav = parseWav(readFileSync(path.join(D, 'audio.wav'))), fs = wav.sampleRate, x = wav.samples, dur = x.length / fs;
const tracks = JSON.parse(readFileSync(path.join(D, 'tracks.json')));
let t = performance.now();
const cuts = detectCuts(x, fs).map((c) => c.t);
const bounds = [0, ...cuts, dur];
const S = stft(x, { fs, nperseg: 4096, nfft: 8192, hop: 512, fMax: 1500, whiten: 'freq', whitenWindowS: 120 });
const tCut = performance.now() - t;
const events = [], clips = [];
for (let k = 0; k < bounds.length - 1; k++) {
  const a = bounds[k], b = bounds[k + 1];
  if (b - a < 10) continue;
  // strongest tonal point in 50-400 Hz, away from the clip edges
  let best = -Infinity, bt = 0, bf = 0;
  for (let i = 0; i < S.nT; i++) {
    const ti = S.t0 + i * S.dt; if (ti < a + 2 || ti > b - 2) continue;
    for (let j = 0; j < S.nF; j++) { const f = S.f0 + j * S.df; if (f < 50 || f > 400) continue; const v = S.data[i * S.nF + j]; if (v > best) { best = v; bt = ti; bf = f; } }
  }
  let pts = [];
  try {
    const r = extendRidge(S, { t: bt, f: bf }, { ...REAL_AUDIO_OPTS, harmonics: [1, 2, 3], monotonic: 'down', tMin: a, tMax: b });
    pts = r.points.map((p) => [p.t, p.f]);
  } catch { /* no ridge */ }
  if (pts.length < 20 || pts[pts.length - 1][0] - pts[0][0] < 4) continue;
  const fo = Engine.flyoverCheck(pts);
  if (!fo.ok) { console.log(`  clip ${k} [${a.toFixed(0)}-${b.toFixed(0)} s]: ${fo.kind}, skipped`); continue; }
  let fit;
  try { fit = await Engine.fitEvent(pts, { cls: 'unknown' }); } catch { continue; }
  const id = `c${k}`;
  clips.push({ id, t0: a, t1: b });
  const lab = tails ? tails.find((c) => 0.5 * (a + b) >= c.t_start && 0.5 * (a + b) < c.t_end) : null;
  events.push({ t_cpa_audio: fit.t_cpa_audio, F0: fit.F0, v_mps: fit.v_mps, cpa_m: fit.cpa_m, cls: 'unknown', t_sigma_s: fit.t_sigma_s, ridge: pts, clip: id,
    ...(lab?.reg ? { reg: lab.reg } : {}) });
}
console.log(`ksmo: ${dur.toFixed(0)} s audio, ${cuts.length} cuts -> ${bounds.length - 1} clips, ${events.length} one-click flyover events (cuts + ridges ${(tCut / 1000).toFixed(1)} s)`);

// blind region: centre 5-10 km from KSMO at a random bearing (seeded)
let s = seedArg; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
const ARP = [34.0158, -118.4513], dist = 5000 + 5000 * rnd(), brg = 2 * Math.PI * rnd();
const center = [ARP[0] + dist * Math.cos(brg) / 111000, ARP[1] + dist * Math.sin(brg) / (111000 * Math.cos(ARP[0] * Math.PI / 180))];
const R = 15000, dLa = R / 111000, dLo = R / (111000 * Math.cos(center[0] * Math.PI / 180));
const input = { events, clips, silences: [], region: { shape: 'circle', center, radius_m: R, bbox: [center[0] - dLa, center[1] - dLo, center[0] + dLa, center[1] + dLo] },
  time: { t0: Date.parse('2024-07-09T07:00:00Z') / 1000, t1: Date.parse('2024-07-10T07:00:00Z') / 1000 }, duration_s: dur,
  tracks, audio: { samples: x, fs }, dem: (lat) => new Float64Array(lat.length).fill(50),
  settings: { grid_m: 200, mode: 'robust', config: { montage_chrono: chrono, ...(JSON.parse(process.env.GEOLOC_CFG || '{}')) } } };
const exec = W ? createGeolocPool({ size: W, factory: await nodeWorkerFactory() }) : undefined;
t = performance.now();
const res = await Engine.runSearch(input, { exec, onProgress: (p) => { if (p.frac === 1 && p.message) console.log(`  [${((performance.now() - t) / 1000).toFixed(0)} s] ${p.stage}: ${p.message}`); } });
const el = (performance.now() - t) / 1000;
exec?.close();

// ---- evaluation (truth-side files are read only now)
const F = JSON.parse(readFileSync(path.join(ROOT, 'ref/validation/out/ksmo_clips.json')));
const SF = JSON.parse(readFileSync(path.join(ROOT, 'ref/validation/out/summary_base.json')));
const LF = [34.01862, -118.44960];
const b = res.candidates[0];
const kx = 111320 * Math.cos(LF[0] * Math.PI / 180), err = (la, lo) => Math.hypot((la - LF[0]) * 110950, (lo - LF[1]) * kx);
const regOf = new Map(tracks.map((tr) => [tr.id, tr.reg || tr.callsign]));
let right = 0, judged = 0;
const rows = [];
for (const [e, ev] of events.entries()) {
  const cl = clips.find((c) => c.id === ev.clip), mid = 0.5 * (cl.t0 + cl.t1);
  const lab = F.clips.find((c) => mid >= c.t_start && mid < c.t_end);
  const a = b?.assignments?.[e];
  const reg = a?.flight ? regOf.get(a.flight) : null;
  if (lab) { judged++; if (reg && lab.reg && reg.toUpperCase() === lab.reg.toUpperCase()) right++; }
  const T = b?.t_start_by_clip?.[ev.clip];
  // Lane F shot keys are '<clip index 2 digits><a|b>_<reg>' (index into ksmo_clips.json); chronological pass time
  const li = lab ? F.clips.indexOf(lab) : -1, key = li >= 0 ? Object.keys(SF.shots).find((nm) => nm.startsWith(String(li).padStart(2, '0'))) : null;
  const sh = key ? SF.shots[key] : null;
  const lfT = sh ? (sh.chrono_T_shot_unix ?? (sh.chrono_pass === sh.pass ? sh.T_shot_unix : sh.at_combined?.pass === sh.chrono_pass ? sh.at_combined.T_shot_unix : sh.T_shot_unix)) : null;
  rows.push(`    ${ev.clip} [${cl.t0.toFixed(0)}-${cl.t1.toFixed(0)} s] label ${lab?.reg ?? '?'} (${lab?.label ?? ''}) -> ${reg ?? '-'}; clip start ${T != null ? new Date((T + cl.t0) * 1000).toISOString().slice(11, 19) : '-'}Z` + (lfT ? ` (Lane F ${new Date(lfT * 1000).toISOString().slice(11, 19)}Z)` : ''));
}
console.log(`search ${el.toFixed(1)} s; best ${b ? `${b.lat.toFixed(5)},${b.lon.toFixed(5)}  ${err(b.lat, b.lon).toFixed(0)} m from Lane F (${err(...ARP).toFixed(0)} m ARP-LaneF), score ${b.score.toFixed(2)}` : 'none'}; verdict ${res.confidence.verdict}; margin ${res.confidence.margin?.toFixed(3)}; blind centre ${(dist / 1000).toFixed(1)} km from KSMO`);
console.log(`  right tail number: ${right} of ${judged} labelled clips with events; reasons: ${(res.confidence.absolute?.reasons || []).slice(0, 3).join(' | ')}`);
console.log(rows.join('\n'));
for (const c of res.candidates.slice(1, 4)) console.log(`  alt ${c.lat.toFixed(5)},${c.lon.toFixed(5)} ${err(c.lat, c.lon).toFixed(0)} m score ${c.score.toFixed(2)}`);
writeFileSync(path.join(ROOT, 'fixtures/real/ksmo_2024-07-09', `run_montage_${chrono ? 'chrono' : 'free'}${tails ? '_tails' : ''}.json`), JSON.stringify({ events: events.map(({ ridge, ...e }) => e), clips, center, candidates: res.candidates, confidence: res.confidence, stats: res.stats }));
console.log('timings', JSON.stringify(res.stats.timings), 'notes', res.stats.notes.slice(-2).join(' | '));
