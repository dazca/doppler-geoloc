// Lane K: BLIND real-world run of the JS engine on a Catalonia case.
//   node web/tests/cat_run.mjs fixtures/real/cat_<name> [segName ...] [--modes robust,faithful] [--workers N]
// Reads <case>/blind.json (events marked from the spectrogram, offset region, date window) + audio.wav + tracks.json.
// It NEVER reads meta.json (truth); scoring vs truth is done afterwards by ref/validation_cat/evaluate.py.
// blind.json:
//  { region: {center:[lat,lon], radius_m}, time: {t0, t1} (unix, window for the START of each segment),
//    tracks_filter?: {maxAltM}, settings?: {...},
//    segments: [{name, t0, t1 /*audio s of the original wav*/, events: [{cls, seeds:[[t,f],...] /*fundamental, audio s*/,
//                harmonics?:[1,2,3], monotonic?:'down', t_cpa?: number (hand-read fallback), note?}] }] }
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseWav } from '../engine/audio.js';
import { stft } from '../engine/stft.js';
import { trackRidgeMulti, cleanRidge } from '../engine/ridge.js';
import { fitEvent, runSearch, simulateCurves } from '../engine/geoloc.js';

const args = process.argv.slice(2);
const dir = path.resolve(args[0]);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const modes = opt('--modes', 'robust,faithful').split(',');
const workers = +opt('--workers', '0');
const only = args.slice(1).filter((a, i, A) => !a.startsWith('--') && !(A[i - 1] || '').startsWith('--'));
const blind = JSON.parse(readFileSync(path.join(dir, 'blind.json'), 'utf8'));
const wav = parseWav(readFileSync(path.join(dir, 'audio.wav')));
const fs = wav.sampleRate || wav.fs || 16000;
const allTracks = JSON.parse(readFileSync(path.join(dir, blind.tracks_file || 'tracks.json'), 'utf8'));
const trackList = Array.isArray(allTracks) ? allTracks : allTracks.tracks;
const REAL = { snap: 6, nullStat: 'robust', nullZ: 1.5, emClip: 15, impulseDb: 6, maxGapS: 4 };

// --montage: ONE search over all segments (engine D11: events carry `clip`, independent start time per clip)
const montage = args.includes('--montage');
const segList = montage
  ? [{ name: 'MONTAGE', t0: 0, t1: Math.max(...blind.segments.map((s) => s.t1)) + 5, clips: blind.segments.map((s) => ({ id: s.name, t0: s.t0, t1: s.t1 })),
       events: blind.segments.flatMap((s) => s.events.map((e) => ({ ...e, clip: s.name, segT: [s.t0, s.t1] }))) }]
  : blind.segments;
for (const seg of segList) {
  if (only.length && !only.includes(seg.name)) continue;
  const i0 = Math.round(seg.t0 * fs), i1 = Math.min(wav.samples.length, Math.round(seg.t1 * fs));
  const x = wav.samples.subarray(i0, i1);
  const dur = x.length / fs;
  // ridge spectrogram on the crop (segment-local time)
  const S = stft(x, { fs, nperseg: 4096, nfft: 8192, hop: 512, fMax: 1500, whiten: 'freq', whitenWindowS: Math.min(120, dur) });
  const events = [], fits = [];
  for (const [k, ev] of seg.events.entries()) {
    const seeds = ev.seeds.map(([t, f]) => ({ t: t - seg.t0, f }));
    const ts = seeds.map((s) => s.t);
    const lo = ev.segT ? ev.segT[0] - seg.t0 : 0, hi = ev.segT ? ev.segT[1] - seg.t0 : dur;
    const range = { tMin: Math.max(lo, Math.min(...ts) - (ev.padS ?? 40)), tMax: Math.min(hi, Math.max(...ts) + (ev.padS ?? 40)) };
    let pts = [];
    try {
      const r = trackRidgeMulti(S, seeds, { ...REAL, ...range, harmonics: ev.harmonics || [1, 2, 3], monotonic: ev.monotonic ?? 'down', bandFrac: ev.bandFrac ?? 0.25 });
      pts = cleanRidge(r.points, { winS: 2, maxDevHz: 2 }).map((q) => [q.t, q.f]);
    } catch (e) { console.log(`  [${seg.name}] ev${k}: ridge failed ${e.message}`); }
    let fit = null;
    try { fit = await fitEvent(pts, { cls: ev.cls }); } catch (e) { console.log(`  [${seg.name}] ev${k}: fit failed ${e.message}`); }
    const t_cpa = fit ? fit.t_cpa_audio : (ev.t_cpa != null ? ev.t_cpa - seg.t0 : ts[Math.floor(ts.length / 2)]);
    const F0 = fit ? fit.F0 : ev.seeds[Math.floor(ev.seeds.length / 2)][1];
    const e = { t_cpa_audio: t_cpa, F0, cls: ev.cls,
      v_mps: fit ? fit.v_mps : (ev.cls === 'jet' ? [60, 300] : ev.cls === 'heli' ? [20, 80] : [30, 100]),
      cpa_m: fit ? fit.cpa_m : [30, 4000], ridge: pts.length >= 8 ? pts : undefined, ...(ev.clip ? { clip: ev.clip } : {}) };
    if (fit?.poorly_constrained || !fit) e.t_sigma_s = Math.max(fit?.t_sigma_s || 0, ev.t_sigma_s || 8);
    events.push(e);
    fits.push({ event: k, n: pts.length, span: pts.length ? [pts[0][0], pts.at(-1)[0]] : null,
      fit: fit && { t_cpa_audio: fit.t_cpa_audio, F0: fit.F0, v: fit.point.v, d: fit.point.d, v_mps: fit.v_mps, cpa_m: fit.cpa_m,
        rms_hz: fit.rms_hz, t_sigma_s: fit.t_sigma_s, poorly_constrained: fit.poorly_constrained, reasons: fit.quality?.reasons, coverage: fit.quality?.coverage },
      ridge: pts.map(([t, f]) => [+(t + seg.t0).toFixed(3), +f.toFixed(2)]) });
    console.log(`  [${seg.name}] ev${k} ${ev.cls}: ${pts.length} pts` + (fit ? `, t_cpa ${(fit.t_cpa_audio + seg.t0).toFixed(1)} F0 ${fit.F0.toFixed(1)} v ${fit.point.v.toFixed(0)} d ${fit.point.d.toFixed(0)} cov ${(fit.quality?.coverage ?? 0).toFixed(2)}${fit.poorly_constrained ? ' POOR' : ''}` : ''));
  }
  // time window for the START of this segment
  const time = { t0: blind.time.t0, t1: blind.time.t1 };
  const maxAltM = blind.tracks_filter?.maxAltM ?? 4000;
  const tracks = trackList.filter((t) => t.points.length >= 2 && t.points.some((p) => p[3] <= maxAltM)
    && t.points.at(-1)[0] >= time.t0 - 900 && t.points[0][0] <= time.t1 + dur + 900);
  for (const mode of modes) {
    const t0 = performance.now();
    let res;
    try {
      res = await runSearch({ events, ...(seg.clips ? { clips: seg.clips } : {}), silences: seg.silences || [], region: { shape: 'circle', ...blind.region }, time, duration_s: dur, tracks,
        spec: null, audio: { samples: x, fs }, settings: { grid_m: 100, c: 343, topN: 10, offsetTolS: 10, refine: true, mode, workers, ...(blind.settings || {}) } });
    } catch (e) { console.log(`  [${seg.name}] ${mode}: FAILED ${e.message}`); continue; }
    const best = res.candidates[0];
    let curves = [];
    if (best) curves = await simulateCurves(best, { events, tracks, harmonics: [1, 2, 3] });
    const out = { case: path.basename(dir), segment: seg.name, seg_t0: seg.t0, duration_s: dur, mode, n_tracks: tracks.length,
      elapsed_s: (performance.now() - t0) / 1000, events: events.map((e) => ({ ...e, ridge: undefined })), fits,
      candidates: res.candidates, confidence: res.confidence, verdict: res.confidence?.verdict, absolute: res.confidence?.absolute, field: res.field, stats: res.stats, curves };
    const f = path.join(dir, `run_${seg.name}_${mode}.json`);
    writeFileSync(f, JSON.stringify(out));
    console.log(`  [${seg.name}] ${mode}: ${tracks.length} tracks, ${(out.elapsed_s).toFixed(1)} s, best ` +
      (best ? `${best.lat.toFixed(5)},${best.lon.toFixed(5)} score ${best.score.toFixed(3)} margin ${res.confidence.margin?.toFixed(3)} flights ${best.flights.join(',')} T0 ${new Date(best.t_start_unix * 1000).toISOString()} verdict ${res.confidence?.verdict}` : `none (verdict ${res.confidence?.verdict})`));
  }
}
