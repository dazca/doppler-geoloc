// C6: track the two Doppler events of the real colsto/Long Island recording.
// Run: node web/tests/track_colsto.mjs   -> fixtures/real/colsto_longisland/ridges.json
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stft } from '../engine/stft.js';
import { parseWav } from '../engine/audio.js';
import { trackRidgeMulti, cleanRidge } from '../engine/ridge.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/real/colsto_longisland');
const x = parseWav(readFileSync(path.join(DIR, 'audio.wav'))).samples;
let t = performance.now();
// stationary-tone suppression: 120 s running per-frequency median (hum lines that come and go)
const S = stft(x, { fs: 16000, nperseg: 4096, nfft: 8192, hop: 512, fMax: 1500, whiten: 'freq', whitenWindowS: 120 });
console.log(`STFT ${S.nT}x${S.nF} in ${(performance.now() - t).toFixed(0)} ms`);

// a few clicks along each (intermittent) fundamental, as a user would do in the demo
const events = [
  { event: 1, seeds: [{ t: 205, f: 170 }, { t: 230, f: 145 }, { t: 250, f: 120 }] },
  { event: 2, seeds: [{ t: 1150, f: 168 }, { t: 1160, f: 155 }, { t: 1175, f: 130 }] },
];
// real-audio options: robust null threshold, emission clip, impulsive-frame coasting
const real = { snap: 6, nullStat: 'robust', nullZ: 1.5, emClip: 15, impulseDb: 6, maxGapS: 4 };
const out = [];
for (const ev of events) {
  const range = { tMin: ev.seeds[0].t - 120, tMax: ev.seeds.at(-1).t + 120 };
  t = performance.now();
  // fundamental: harmonics 1..3 stacked, monotonic (a straight pass never rises in frequency)
  const h1 = trackRidgeMulti(S, ev.seeds, { ...real, ...range, harmonics: [1, 2, 3], monotonic: 'down' });
  const g = h1.points;
  const gf = (tt) => g.reduce((b, p) => (Math.abs(p.t - tt) < Math.abs(b.t - tt) ? p : b)).f;
  const rows = [{ m: 1, pts: cleanRidge(g, { winS: 2, maxDevHz: 2 }), method: 'viterbi, harmonics [1,2,3] stacked, monotonic down' }];
  // harmonics: tracked independently but restricted to m * fundamental ± 3m Hz
  for (const m of [2, 3]) {
    const r = trackRidgeMulti(S, ev.seeds.map((sd) => ({ t: sd.t, f: gf(sd.t) * m })),
      { ...real, ...range, maxGapS: 6, guide: g, guideMult: m, guideTolHz: 3 * m, guideOnly: true });
    rows.push({ m, pts: cleanRidge(r.points, { winS: 2, maxDevHz: 2 * m }), method: `viterbi guided by fundamental x${m} (±${3 * m} Hz)` });
  }
  for (const { m, pts, method } of rows) {
    const fs = pts.map((q) => q.f);
    console.log(`event ${ev.event} h${m}: ${pts.length} pts, t ${pts[0].t.toFixed(1)}-${pts.at(-1).t.toFixed(1)} s, ` +
      `f ${Math.max(...fs).toFixed(1)}->${Math.min(...fs).toFixed(1)} Hz, mean SNR ${(pts.reduce((a, q) => a + q.snr, 0) / pts.length).toFixed(1)} dB`);
    out.push({ event: ev.event, harmonic: m, method, points: pts.map((q) => [+q.t.toFixed(3), +q.f.toFixed(2)]),
      snr_db: pts.map((q) => +q.snr.toFixed(1)) });
  }
  console.log(`  tracking ${(performance.now() - t).toFixed(0)} ms`);
}
const meta = { source: 'fixtures/real/colsto_longisland/audio.wav (audio time, s; add 1900 s for orig.opus time)',
  stft: { fs: 16000, nperseg: 4096, nfft: 8192, hop: 512, whiten: 'freq', whitenWindowS: 120 }, generator: 'web/tests/track_colsto.mjs' };
writeFileSync(path.join(DIR, 'ridges.json'), JSON.stringify(out.map((r) => ({ ...r, meta }))));
console.log('wrote', path.join(DIR, 'ridges.json'));
