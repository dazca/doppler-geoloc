// Benchmark: node web/tests/bench_stft.mjs
import { stft } from '../engine/stft.js';
import { resample } from '../engine/audio.js';

// machine-load reference: 1e8 multiply-adds (unloaded i7-13620H: ~0.1-0.15 s)
{ const a = new Float64Array(1e7).map(Math.random); const t = performance.now(); let s = 0;
  for (let r = 0; r < 10; r++) for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  console.log(`baseline 1e8 mul-add: ${(performance.now() - t).toFixed(0)} ms`); }
const fs = 16000, N = fs * 600;
const x = new Float32Array(N);
let s = 1;
for (let i = 0; i < N; i++) { s = (s * 16807) % 2147483647; x[i] = Math.sin(i * 0.05) + (s / 2147483647 - 0.5); }

const configs = [
  { nperseg: 2048, nfft: 2048, hop: 512 },
  { nperseg: 4096, nfft: 4096, hop: 512, fMax: 2000 },
  { nperseg: 4096, nfft: 8192, hop: 256, fMax: 2000 },
  { nperseg: 4096, nfft: 8192, hop: 256, fMax: 2000, whiten: 'freq' },
  { nperseg: 4096, nfft: 8192, hop: 256, fMax: 2000, whiten: 'both' },
];
stft(x.subarray(0, fs * 10), { fs, nperseg: 2048 }); // warm-up
for (const c of configs) {
  const t = performance.now();
  const S = stft(x, { fs, ...c });
  const ms = performance.now() - t;
  console.log(`${JSON.stringify(c)} -> nT=${S.nT} nF=${S.nF} (${(S.data.byteLength / 1e6).toFixed(1)} MB) ${ms.toFixed(0)} ms`);
}
const t = performance.now();
const x48 = new Float32Array(48000 * 60).map((_, i) => Math.sin(i * 0.01));
resample(x48, 48000, 16000);
console.log(`resample 60 s 48k->16k (JS sinc, Node-only path): ${(performance.now() - t).toFixed(0)} ms`);
