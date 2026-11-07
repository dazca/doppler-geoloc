// Lane C numerical validation. Run: node --test web/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createFFT } from '../engine/fft.js';
import { stft } from '../engine/stft.js';
import { parseWav, readMediaMeta, resample, parseDateToUnix } from '../engine/audio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = path.join(ROOT, 'fixtures/dsp');
const rd = (f) => readFileSync(path.join(FIX, f));
const log = (...a) => console.log('   ', ...a);

test('fft.real matches numpy.fft.rfft', () => {
  const cases = JSON.parse(rd('fft_cases.json'));
  for (const c of cases) {
    const fft = createFFT(c.n);
    const re = new Float64Array(c.n / 2 + 1), im = new Float64Array(c.n / 2 + 1);
    fft.real(Float64Array.from(c.x), re, im);
    let err = 0, mag = 0;
    for (let k = 0; k <= c.n / 2; k++) {
      err = Math.max(err, Math.abs(re[k] - c.re[k]), Math.abs(im[k] - c.im[k]));
      mag = Math.max(mag, Math.hypot(c.re[k], c.im[k]));
    }
    log(`n=${c.n}: max abs err ${err.toExponential(2)} (max |X| ${mag.toFixed(1)})`);
    assert.ok(err < 1e-9 * Math.max(1, mag), `n=${c.n} err ${err}`);
  }
});

test('fft.complex matches DFT', () => {
  const n = 64, fft = createFFT(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) { re[i] = Math.sin(i * 0.7) + i / n; im[i] = Math.cos(i * 1.3); }
  const r0 = re.slice(), i0 = im.slice();
  fft.complex(re, im);
  let err = 0;
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let j = 0; j < n; j++) {
      const a = -2 * Math.PI * j * k / n;
      sr += r0[j] * Math.cos(a) - i0[j] * Math.sin(a);
      si += r0[j] * Math.sin(a) + i0[j] * Math.cos(a);
    }
    err = Math.max(err, Math.abs(sr - re[k]), Math.abs(si - im[k]));
  }
  log(`complex n=64 max err ${err.toExponential(2)}`);
  assert.ok(err < 1e-10);
});

test('parseWav float32 & int16', () => {
  const f = parseWav(rd('stft_signal.wav'));
  const i = parseWav(rd('stft_signal_i16.wav'));
  assert.equal(f.sampleRate, 16000); assert.equal(f.samples.length, 160000);
  assert.equal(i.samples.length, 160000);
  // int16 file was written as round(x*32767*0.9)
  let err = 0;
  for (let k = 0; k < f.samples.length; k++) err = Math.max(err, Math.abs(i.samples[k] * 32768 / (32767 * 0.9) - f.samples[k]));
  log(`int16 vs float32 max err ${err.toExponential(2)}`);
  assert.ok(err < 1e-4);
});

test('stft matches scipy.signal.spectrogram', () => {
  const x = parseWav(rd('stft_signal.wav')).samples;
  const cases = JSON.parse(rd('stft_expected.json'));
  for (const c of cases) {
    const S = stft(x, { fs: c.fs, nperseg: c.nperseg, nfft: c.nfft, hop: c.hop, scaling: c.scaling,
      detrend: c.detrend, fMin: c.fMin, fMax: c.fMax, whiten: c.whiten, dbFloor: c.dbFloor });
    const b = rd(`stft_expected_${c.name}.f32`);
    const exp = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    assert.equal(S.nT, c.nT, `${c.name} nT`); assert.equal(S.nF, c.nF, `${c.name} nF`);
    assert.ok(Math.abs(S.t0 - c.t0) < 1e-12 && Math.abs(S.dt - c.dt) < 1e-12, `${c.name} time axis`);
    assert.ok(Math.abs(S.f0 - c.f0) < 1e-9 && Math.abs(S.df - c.df) < 1e-12, `${c.name} freq axis`);
    // compare where the reference is above -150 dB (exclude numerically-zero bins)
    let maxErr = 0, sum = 0, n = 0, maxErrStrong = 0;
    let peak = -Infinity; for (const v of exp) peak = Math.max(peak, v);
    for (let k = 0; k < exp.length; k++) {
      if (exp[k] < -150 && !c.whiten) continue;
      const e = Math.abs(S.data[k] - exp[k]);
      maxErr = Math.max(maxErr, e); sum += e; n++;
      if (exp[k] > peak - 60) maxErrStrong = Math.max(maxErrStrong, e);
    }
    log(`${c.name}: nT=${S.nT} nF=${S.nF} max|ΔdB|=${maxErr.toExponential(2)} mean=${(sum / n).toExponential(2)} ` +
      `(bins within 60 dB of peak: max ${maxErrStrong.toExponential(2)})`);
    assert.ok(maxErr < 0.01, `${c.name} max err ${maxErr}`);
  }
});

test('resample 48k->16k preserves in-band tone, rejects alias', () => {
  const fs = 48000, n = fs * 2, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * 1000 * i / fs) + Math.sin(2 * Math.PI * 11000 * i / fs);
  const y = resample(x, fs, 16000);
  const S = stft(y, { fs: 16000, nperseg: 4096, hop: 4096 });
  const row = S.data.subarray(S.nF * 3, S.nF * 4);
  const at = (f) => row[Math.round(f / S.df)];
  // 11 kHz would alias to 5 kHz
  log(`resample: 1 kHz ${at(1000).toFixed(1)} dB, 5 kHz alias ${at(5000).toFixed(1)} dB`);
  assert.ok(at(1000) - at(5000) > 60);
});

test('readMediaMeta mvhd / apple creationdate / none', async () => {
  const a = await readMediaMeta(rd('meta_mvhd.mp4'));
  log('mp4:', JSON.stringify(a));
  assert.equal(a.mvhdCreationUnix, Date.UTC(2024, 4, 6, 7, 8, 9) / 1000);
  assert.ok(Math.abs(a.durationSec - 3) < 0.1);
  const b = await readMediaMeta(rd('meta_apple.mov'));
  log('mov:', JSON.stringify(b));
  assert.equal(b.appleCreationDate, '2024-05-06T09:08:10+0200');
  assert.equal(b.appleCreationUnix, Date.UTC(2024, 4, 6, 7, 8, 10) / 1000);
  assert.equal(b.best.source, 'com.apple.quicktime.creationdate');
  const c = await readMediaMeta(rd('meta_none.webm'));
  assert.equal(c.best, null);
  assert.equal(parseDateToUnix('2024-05-06 07:08:09Z'), Date.UTC(2024, 4, 6, 7, 8, 9) / 1000);
});
