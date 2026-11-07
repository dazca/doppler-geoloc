// Browser memory fixes (B1-B12): streaming decode, block-buffered live recording, budgets, cache eviction.
//   node --test web/tests/memory.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StreamResampler, resampleTo, resample, decodeAudioFile, decodeWavStream, decodeMp4Stream, readAudioTrack, adtsHeader,
  parseASC, makeSink, parseWav, maxFullBytes, readMediaMeta } from '../engine/audio.js';
import { decimate, whiten } from '../engine/geoloc/spectro.js';
import { PcmBlockStore, wavFromBlocks, wavHeader, STORE_RATE } from '../live/recorder.js';
import { cropRangeError, parseClock } from '../ui/time-utils.js';
import { budgetHop, stftOptions, PRESETS, SPEC_BUDGET_BYTES } from '../ui/spec-panel.js';
import { poolSizeFor } from '../workers/geoloc-pool.js';
import { cropZToEvents, prepareSpectrogram } from '../engine/geoloc.js';
import { buildTimePyramid, maxRowsInto } from '../ui/spectrogram-view.js';

const DEMO = new URL('../demo/scenario1/audio.m4a', import.meta.url);
const rng = (seed = 1) => () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 - 0.5; };
const concat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0), o = new Float32Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
function streamAll(x, fsIn, fsOut, r) {
  const rs = new StreamResampler(fsIn, fsOut), out = [];
  for (let i = 0; i < x.length;) { const n = 1 + Math.floor((r() + 0.5) * 5000); out.push(rs.push(x.subarray(i, i + n))); i += n; }
  out.push(rs.flush());
  return concat(out);
}
function wavBytes(samples, fs, channels = 1) {
  const n = samples.length / channels, pcm = new Int16Array(samples.length);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 32767;
  const h = new DataView(wavHeader(n, fs));
  h.setUint16(22, channels, true); h.setUint32(28, fs * 2 * channels, true); h.setUint16(32, 2 * channels, true);
  h.setUint32(40, 2 * pcm.length, true); h.setUint32(4, 36 + 2 * pcm.length, true);
  return new Blob([h.buffer, pcm]);
}

// ------------------------------------------------------------------ B8 / streaming resampler
test('B8: StreamResampler output equals resampleTo (integer decimate and non-integer sinc), any block sizes', () => {
  const r = rng(7), x = new Float32Array(48000 * 3).map(() => r());
  for (const [fi, fo] of [[48000, 8000], [16000, 8000], [44100, 8000], [8000, 8000]]) {
    const ref = resampleTo(x, fi, fo), got = streamAll(x, fi, fo, r);
    assert.equal(got.length, ref.length, `${fi}->${fo} length`);
    let maxd = 0; for (let i = 0; i < ref.length; i++) maxd = Math.max(maxd, Math.abs(got[i] - ref[i]));
    assert.ok(maxd < 1e-6, `${fi}->${fo} max diff ${maxd}`);
  }
  assert.deepEqual(resampleTo(x, 48000, 8000), decimate(x, 6));          // integer ratio -> FIR decimator
  assert.deepEqual(resampleTo(x, 44100, 8000), resample(x, 44100, 8000)); // otherwise windowed sinc
});

// ------------------------------------------------------------------ B1 size path
test('B1: a file too large to read whole fails with code too-large, without reading it', async () => {
  let read = false;
  const huge = { name: 'phone.webm', size: 7e9, type: 'video/webm',
    slice: (a, b) => new Blob([new Uint8Array(Math.min(12, b - a)).fill(0x1a)]), arrayBuffer: () => { read = true; throw new RangeError('Array buffer allocation failed'); } };
  await assert.rejects(decodeAudioFile(huge, { sampleRate: 8000, readMeta: false }), (e) => e.code === 'too-large');
  assert.equal(read, false);
  // a huge "MP4" whose moov cannot be parsed is also too-large (never a raw RangeError)
  const fakeMp4 = { ...huge, name: 'x.mp4', slice: (a, b) => new Blob([new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0, 0, 0, 0, 0]).subarray(0, Math.max(0, Math.min(16, b) - a))]) };
  await assert.rejects(decodeAudioFile(fakeMp4, { sampleRate: 8000, readMeta: false }), (e) => e.code === 'too-large');
  assert.equal(read, false);
  assert.ok(maxFullBytes(8) > maxFullBytes(2) && maxFullBytes(undefined) >= 256e6);
});

test('B1: WAV is streamed block by block (crop reads only the range) and matches the whole-file decode', async () => {
  const fs = 48000, r = rng(3), x = new Float32Array(fs * 12).map((_, i) => 0.4 * Math.sin(2 * Math.PI * 440 * i / fs) + 0.05 * r());
  const blob = wavBytes(x, fs);
  const whole = resampleTo(parseWav(new Uint8Array(await blob.arrayBuffer())).samples, fs, 8000);
  const all = await decodeAudioFile(blob, { sampleRate: 8000, readMeta: false, streamBytes: 0 });
  assert.equal(all.path, 'wav-stream');
  assert.equal(all.samples.length, whole.length);
  assert.ok(Math.abs(all.duration - 12) < 1e-9);
  let maxd = 0; for (let i = 0; i < whole.length; i++) maxd = Math.max(maxd, Math.abs(all.samples[i] - whole[i]));
  assert.ok(maxd < 1e-6, `max diff ${maxd}`);
  // crop: bytes outside [2 s, 5 s] (+ header) are never read
  let maxEnd = 0, minStart = Infinity;
  const spy = { size: blob.size, name: 'a.wav', slice: (a, b) => { if (a > 0) { minStart = Math.min(minStart, a); maxEnd = Math.max(maxEnd, b); } return blob.slice(a, b); } };
  const c = await decodeWavStream(spy, { sampleRate: 8000, crop: [2, 5] });
  assert.deepEqual(c.crop, [2, 5]);
  assert.equal(c.samples.length, 3 * 8000);
  assert.ok(minStart >= 44 + 2 * fs * 2 && maxEnd <= 44 + 5 * fs * 2, `read ${minStart}..${maxEnd}`);
  // B10 at the decoder: a range past the end is a coded error
  await assert.rejects(decodeWavStream(blob, { sampleRate: 8000, crop: [20, 30] }), (e) => e.code === 'bad-range');
});

test('B1: MP4 sample table, ADTS framing and crop range come from the moov box only', async () => {
  const u8 = new Uint8Array(readFileSync(DEMO));
  const tr = await readAudioTrack(new Blob([u8]));
  assert.equal(tr.aot, 2); assert.equal(tr.sampleRate, 8000); assert.equal(tr.channels, 1);
  assert.equal(tr.mediaTime, 1024);                       // encoder priming skipped through the edit list
  assert.equal(tr.n, 8986);
  assert.ok(Math.abs(tr.duration - 1150.128) < 1e-6);
  for (let s = 0; s < tr.n; s++) assert.ok(tr.offset[s] >= 0 && tr.offset[s] + tr.size[s] <= u8.length);
  const h = adtsHeader(tr, 554);
  assert.equal(h[0], 0xff); assert.equal(h[1] & 0xf6, 0xf0);
  assert.equal(((h[3] & 3) << 11) | (h[4] << 3) | (h[5] >> 5), 561);   // frame length includes the header
  assert.deepEqual(parseASC(tr.asc), { aot: 2, sfi: 11, sampleRate: 8000, channels: 1 });
  await assert.rejects(decodeMp4Stream(new Blob([u8]), { sampleRate: 8000, crop: [2000, 2100] }), (e) => e.code === 'bad-range');
});

test('B1: decode sink places blocks by time (gaps -> silence, overlap and pre-crop dropped)', () => {
  const sink = makeSink(1, 3, 1000);                      // keep [1 s, 3 s) at 1 kHz
  const blk = (t, n, v) => sink.put(new Float32Array(n).fill(v), t, 1000);
  blk(0.5, 1000, 1);    // 0.5..1.5: first 500 dropped
  blk(1.4, 200, 9);     // overlaps 1.4..1.5 (dropped) then 1.5..1.6
  blk(2.0, 2000, 3);    // gap 1.6..2.0 -> zeros; 3.0+ dropped
  const y = sink.finish();
  assert.equal(y.length, 2000);
  assert.equal(y[0], 1); assert.equal(y[499], 1); assert.equal(y[500], 9); assert.equal(y[599], 9);
  assert.equal(y[600], 0); assert.equal(y[999], 0); assert.equal(y[1000], 3); assert.equal(y[1999], 3);
});

// ------------------------------------------------------------------ B2 live block buffer
test('B2: live PCM goes to 8 kHz Int16 blocks; the WAV is built from the blocks', async () => {
  const fs = 48000, sec = 75, store = new PcmBlockStore(fs, { blockSeconds: 60 });
  const q = 128, chunk = new Float32Array(q);
  let ph = 0;
  for (let k = 0; k < sec * fs / q; k++) { for (let i = 0; i < q; i++) chunk[i] = 0.5 * Math.sin(ph += 2 * Math.PI * 300 / fs); store.push(chunk); }
  assert.ok(Math.abs(store.seconds - sec) < 1e-9);
  assert.equal(store.bytes, 2 * 60 * STORE_RATE * 2);     // two preallocated 60 s blocks so far
  const { blocks, n, fs: fo } = store.finish();
  assert.equal(fo, 8000); assert.equal(n, sec * 8000); assert.equal(blocks.length, 2);
  assert.equal(blocks[0].length, 60 * 8000); assert.equal(blocks[1].length, 15 * 8000);
  const w = parseWav(new Uint8Array(await wavFromBlocks(blocks, n, fo, 'x.wav').arrayBuffer()));
  assert.equal(w.sampleRate, 8000); assert.equal(w.samples.length, n);
  let zc = 0; for (let i = 8001; i < 16000; i++) if ((w.samples[i - 1] < 0) !== (w.samples[i] < 0)) zc++;
  assert.ok(Math.abs(zc - 600) <= 2, `300 Hz tone survives: ${zc} zero crossings/s`);
  let pk = 0; for (let i = 8000; i < 16000; i++) pk = Math.max(pk, Math.abs(w.samples[i]));
  assert.ok(Math.abs(pk - 0.5) < 0.01, `amplitude ${pk}`);
  // 30 min at 48 kHz: 28.8 MB of blocks vs 691 MB of Float32 at the input rate
  assert.equal(new PcmBlockStore(48000).blockLen * 2 * 30, 28.8e6);
});

// ------------------------------------------------------------------ B10 crop range
test('B10: crop range validation', () => {
  assert.equal(parseClock('1:02:03'), 3723); assert.equal(parseClock('12:30'), 750); assert.equal(parseClock('x'), null);
  assert.equal(cropRangeError(null, 10, 100), 'large.bad');
  assert.equal(cropRangeError(100, 120, 100), 'large.past');
  assert.equal(cropRangeError(150, 160, 100), 'large.past');
  assert.equal(cropRangeError(50, 40, 100), 'large.order');
  assert.equal(cropRangeError(50, 50, 100), 'large.order');
  assert.equal(cropRangeError(99.5, 120, 100), 'large.order');   // less than 1 s left inside the recording
  assert.equal(cropRangeError(10, 200, 100), null);              // the end is clamped to the duration
  assert.equal(cropRangeError(10, 20, null), null);
});

// ------------------------------------------------------------------ B5 spectrogram budget
test('B5: the display spectrogram stays within the byte budget', () => {
  for (const preset of Object.keys(PRESETS)) {
    for (const dur of [60, 600, 1800, 3600, 7200]) {
      const o = stftOptions({ preset }, dur), p = PRESETS[preset];
      const nF = Math.floor(2000 * p.nfft / 8000) - Math.ceil(30 * p.nfft / 8000) + 1, nT = Math.floor((dur * 8000 - p.nperseg) / o.hop) + 1;
      assert.ok(nT * nF * 4 <= SPEC_BUDGET_BYTES * 1.001, `${preset} ${dur}s: ${(nT * nF * 4 / 1e6).toFixed(0)} MB`);
      assert.equal(o.hop % 256, 0);
      if (dur <= 600) assert.equal(o.hop, p.hop);   // short files keep the preset resolution
    }
  }
  assert.equal(budgetHop(PRESETS.standard, 3600), 1280);
});

// ------------------------------------------------------------------ B3 pool sizing + Z crop
test('B3: worker pool sized by Z bytes and device memory; Z cropped to the events', () => {
  assert.equal(poolSizeFor(56e6, { cpus: 8, deviceMemoryGB: 8, shared: false }), 8);
  assert.equal(poolSizeFor(56e6, { cpus: 8, deviceMemoryGB: 2, shared: false }), 3);
  assert.equal(poolSizeFor(300e6, { cpus: 8, deviceMemoryGB: 2, shared: false }), 1);
  assert.equal(poolSizeFor(300e6, { cpus: 8, deviceMemoryGB: 2, shared: true }), 8);
  const zs = { t0: 100, dt: 0.128, f0: 0, df: 2, nT: 28125, nF: 10 }, Z = new Float32Array(zs.nT * zs.nF).map((_, i) => i);
  const { zs: c, Z: cz } = cropZToEvents(zs, Z, [{ t_cpa_audio: 1500 }, { t_cpa_audio: 1600 }], { tau_half: 60, delta_half: 4, soft: { offset_gate: 30, delta_half_coarse: 12 } });
  assert.ok(c.nT < zs.nT / 5);
  assert.ok(c.t0 <= 1500 - 162 && c.t0 + c.nT * c.dt >= 1600 + 162);
  const i0 = Math.round((c.t0 - zs.t0) / zs.dt);
  assert.equal(cz[0], Z[i0 * zs.nF]); assert.equal(cz.length, c.nT * zs.nF);
  assert.equal(cropZToEvents(zs, Z, [{ t_cpa_audio: 100 }, { t_cpa_audio: 3700 }], {}).Z, Z);   // spans everything: no copy
  assert.equal(cropZToEvents(zs, Z, [{ t_cpa_audio: 1500 }], { use_offset_filter: false }).Z, Z); // no gate: no crop
  // per-event time uncertainty widens the window: 3*sqrt2*30 s gate + min(40, 60) s sweep
  const w = cropZToEvents(zs, Z, [{ t_cpa_audio: 1500, t_sigma_s: 30 }], { tau_half: 60, delta_half: 4, soft: { offset_gate: 30, sigma_t: 8, delta_half_coarse: 12 } }).zs;
  assert.ok(w.t0 <= 1500 - (60 + 40 + 3 * Math.SQRT2 * 30 + 60));
});

// ------------------------------------------------------------------ B11 whitened spectrogram from the worker
test('B11: a whitened full-band spectrogram, band-cropped, equals whitening the cropped band', () => {
  const r = rng(11), nT = 300, nF = 64, spec = { t0: 0, dt: 0.128, f0: 0, df: 1.953125, nT, nF, data: new Float32Array(nT * nF).map(() => 10 * r()) };
  const ref = prepareSpectrogram(spec, 60);
  const got = prepareSpectrogram({ ...spec, unit: 'z', data: whiten(spec) }, 60);
  assert.equal(got.spec.nF, ref.spec.nF);
  assert.deepEqual(got.Z, ref.Z);
});

// ------------------------------------------------------------------ B9 pooled pyramid
test('B9: time-pooled pyramid gives the exact column max', () => {
  const r = rng(5), nT = 5000, nF = 7, data = new Float32Array(nT * nF).map(() => r());
  const levels = buildTimePyramid(data, nT, nF);
  assert.deepEqual(levels.map((l) => l.F), [8, 64, 512]);
  for (const [i0, i1] of [[0, 4999], [3, 700], [511, 1024], [100, 101], [4096, 4999], [17, 17]]) {
    const a = new Float32Array(nF).fill(-Infinity), b = new Float32Array(nF).fill(-Infinity);
    maxRowsInto(a, 0, nF - 1, data, nF, levels, i0, i1);
    for (let i = i0; i <= i1; i++) for (let j = 0; j < nF; j++) b[j] = Math.max(b[j], data[i * nF + j]);
    assert.deepEqual(a, b, `${i0}..${i1}`);
  }
});

// ------------------------------------------------------------------ B12 track cache
function fakeIndexedDB({ quotaOnce = false } = {}) {
  const stores = new Map();   // name -> Map(key -> value)
  let quota = quotaOnce, version = 0;
  const later = (f) => setTimeout(f, 0);
  const request = (fn) => { const req = {}; later(() => { try { req.result = fn(); req.onsuccess?.({ target: req }); } catch (e) { req.error = e; req.onerror?.({ target: req }); } }); return req; };
  const makeDb = () => ({
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore: (n) => { stores.set(n, new Map()); return storeApi(n, null); },
    close() {},
    transaction(n) {
      const tx = { error: null, pending: 0, aborted: false };
      const finish = () => later(() => { if (tx.pending === 0 && !tx.done) { tx.done = true; tx.aborted ? tx.onabort?.() : tx.oncomplete?.(); } });
      tx.objectStore = () => storeApi(n, tx, finish);
      finish();
      return tx;
    },
  });
  function storeApi(n, tx, finish = () => {}) {
    const m = stores.get(n);
    const op = (f) => { if (tx) tx.pending++; return request(() => { try { return f(); } finally { if (tx) { tx.pending--; finish(); } } }); };
    return {
      indexNames: { contains: () => true }, createIndex() {},
      put: (v, k) => op(() => { if (quota) { quota = false; const e = new Error('quota'); e.name = 'QuotaExceededError'; tx.error = e; tx.aborted = true; throw e; } m.set(k, structuredClone(v)); }),
      get: (k) => op(() => m.get(k)),
      delete: (k) => op(() => m.delete(k)),
      clear: () => op(() => m.clear()),
      index: () => ({ openKeyCursor: (_, dir) => {
        const keys = [...m.entries()].sort((a, b) => (dir === 'prev' ? b[1].savedAt - a[1].savedAt : a[1].savedAt - b[1].savedAt)).map(([k]) => k);
        if (tx) tx.pending++;
        const req = {}; let i = 0;
        const step = () => later(() => {
          const c = i < keys.length ? { primaryKey: keys[i], continue: () => { i++; step(); } } : null;
          req.onsuccess?.({ target: { result: c } });
          if (!c && tx) { tx.pending--; finish(); }
        });
        step();
        return req;
      } }),
    };
  }
  return {
    stores,
    open: (_name, v) => { const req = {}; later(() => { req.result = makeDb(); if (v > version) { version = v; req.transaction = { objectStore: (n) => storeApi(n, null) }; req.onupgradeneeded?.(); } req.onsuccess?.(); }); return req; },
  };
}

test('B12: track cache evicts in its own transaction and recovers from QuotaExceededError', async () => {
  const { putTracks, getTracks } = await import('../ui/track-cache.js');
  globalThis.indexedDB = fakeIndexedDB();
  for (let i = 0; i < 9; i++) { assert.equal(await putTracks(`k${i}`, [{ id: i }]), true); await new Promise((r) => setTimeout(r, 2)); }
  const keys = [...globalThis.indexedDB.stores.get('tracks').keys()].sort();
  assert.deepEqual(keys, ['k3', 'k4', 'k5', 'k6', 'k7', 'k8']);
  assert.deepEqual(await getTracks('k8'), [{ id: 8 }]);
  // the next write hits the quota: the store is cleared and the write retried once
  const quotaDb = fakeIndexedDB({ quotaOnce: true });
  quotaDb.stores.set('tracks', new Map([['old', { savedAt: 1, tracks: [0] }]]));
  globalThis.indexedDB = quotaDb;
  assert.equal(await putTracks('new', [{ id: 'n' }]), true);
  assert.deepEqual([...quotaDb.stores.get('tracks').keys()], ['new']);
  delete globalThis.indexedDB;
});

// ------------------------------------------------------------------ security L1 + review F6-F9: hostile / unusual MP4 and WAV
// Crafted ISO-BMFF builders (from the security audit's fuzz harness).
const be32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; };
const be16 = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); return b; };
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
const str = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const box = (type, ...kids) => { const body = cat(...kids); return cat(be32(8 + body.length), str(type), body); };
function esdsBox(asc = [0x15, 0x88]) {   // AAC LC, 8 kHz, mono
  const dsi = cat(Uint8Array.of(0x05, asc.length), Uint8Array.from(asc));
  const dcd = cat(Uint8Array.of(0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0), be32(0), be32(0), dsi);
  return box('esds', be32(0), cat(Uint8Array.of(0x03, 3 + dcd.length, 0, 1, 0), dcd));
}
const soundEntry = (fmt, kids = []) => box(fmt, new Uint8Array(6), be16(1), be16(0), be16(0), be32(0), be16(1), be16(16), be16(0), be16(0), be32(8000 << 16), ...kids);
function moovBox(o) {
  const mvhd = box('mvhd', be32(0), be32(0), be32(0), be32(1000), be32(1000), new Uint8Array(80));
  const mdhd = box('mdhd', be32(0), be32(0), be32(0), be32(o.timescale ?? 8000), be32(o.duration ?? 8000), be32(0));
  const hdlr = box('hdlr', be32(0), be32(0), str('soun'), new Uint8Array(12), Uint8Array.of(0));
  const stsd = box('stsd', be32(0), be32(1), o.entry || soundEntry('mp4a', [esdsBox()]));
  const stts = box('stts', be32(0), be32(o.stts.length), ...o.stts.flatMap(([c, d]) => [be32(c), be32(d)]));
  const stsc = box('stsc', be32(0), be32(o.stsc.length), ...o.stsc.flatMap(([f, p]) => [be32(f), be32(p), be32(1)]));
  const stsz = box('stsz', be32(0), be32(o.stsz.uni), be32(o.stsz.n), ...(o.stsz.table || []).map(be32));
  const stco = box('stco', be32(0), be32(o.stco.length), ...o.stco.map(be32));
  const trak = box('trak', box('mdia', mdhd, hdlr, box('minf', box('stbl', stsd, stts, stsc, stsz, stco))));
  return box('moov', mvhd, trak);
}
const mp4File = (moov, pad = 0) => cat(box('ftyp', str('M4A '), be32(0)), moov, pad ? cat(be32(8 + pad), str('mdat'), new Uint8Array(pad)) : new Uint8Array(0));
const okTable = (n) => ({ stsz: { uni: 100, n }, stts: [[n, 1024]], stsc: [[1, 1]], stco: Array.from({ length: n }, (_, i) => 2000 + 100 * i), duration: n * 1024 });
/** fake WebAudio for the ADTS / whole-file paths: 1024 samples per ~107-byte frame */
function withFakeOAC(fn) {
  const prev = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = class {
    constructor(c, l, r) { this.r = r; }
    async decodeAudioData(buf) {
      const n = 1024 * Math.max(1, Math.round(buf.byteLength / 107));
      return { numberOfChannels: 1, sampleRate: this.r, getChannelData: () => new Float32Array(n) };
    }
  };
  return Promise.resolve().then(fn).finally(() => { globalThis.OfflineAudioContext = prev; });
}
const memMB = () => (process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers) / 1e6;
async function promptBounded(p, { ms = 2000, mb = 64 } = {}) {
  const t = performance.now(), m0 = memMB();
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(performance.now() - t < ms, `took ${performance.now() - t} ms`);
  assert.ok(memMB() - m0 < mb, `memory grew ${memMB() - m0} MB`);
  return err;
}

test('L1: hostile sample tables are rejected promptly with bounded memory (not-streamable)', async () => {
  const cases = {
    stsz_4e8: mp4File(moovBox({ ...okTable(1), stsz: { uni: 1, n: 400_000_000 }, stts: [[0xffffffff, 1]], stsc: [[1, 0xffffffff]], stco: [0] })),
    stsz_table_overrun: mp4File(moovBox({ ...okTable(1), stsz: { uni: 0, n: 5000, table: [100] } }), 1 << 20),
    stsc_zero_per_chunk: mp4File(moovBox({ ...okTable(5), stsc: [[1, 0], [0xffffffff, 1]] }), 4000),
    overlapping_samples: mp4File(moovBox({ ...okTable(1100), stsz: { uni: 0xffffffff, n: 1100 }, stco: Array(1100).fill(0) }), 1 << 20),
    overlap_small: mp4File(moovBox({ ...okTable(1100), stsz: { uni: 900, n: 1100 }, stco: Array(1100).fill(0) }), 1 << 19),
    beyond_file: mp4File(moovBox({ ...okTable(20), stco: Array(20).fill(0xfffffff0) }), 4000),
    timescale0: mp4File(moovBox({ ...okTable(20), timescale: 0 }), 4000),
  };
  for (const [name, u8] of Object.entries(cases)) {
    const err = await promptBounded(readAudioTrack(new Blob([u8])));
    assert.equal(err?.code, 'not-streamable', `${name}: ${err?.message}`);
    // the public entry point fails with a friendly coded error (too large to read whole), never hangs or allocates GBs
    const e2 = await promptBounded(withFakeOAC(() => decodeAudioFile(new Blob([u8]), { sampleRate: 8000, readMeta: false, streamBytes: 0, maxBytes: 100 })));
    assert.equal(e2?.code, 'too-large', name);
  }
});

test('L1: a claimed 1 h duration over 20 frames decodes ~3.5 s, not an hour of silence', async () => {
  const u8 = mp4File(moovBox({ ...okTable(20), timescale: 8000, duration: 3600 * 8000 }), 4000);
  const err = await promptBounded(withFakeOAC(async () => {
    const r = await decodeMp4Stream(new Blob([u8]), { sampleRate: 8000, prefer: 'adts' });
    assert.ok(r.duration < 20 * 1024 / 8000 + 1.01, `duration ${r.duration}`);
    assert.ok(r.samples.length <= Math.ceil(r.duration * 8000) + 1);
  }));
  assert.equal(err, null);
  // the sink writes long gaps in bounded chunks (no single giant allocation)
  const sink = makeSink(0, 600, 1000);
  sink.put(new Float32Array(10), 0, 96000);
  sink.put(new Float32Array(10), 599, 96000);   // a 599 s gap at 96 kHz = 57.5M samples, written 1M at a time
  assert.equal(sink.finish().length, 600 * 1000);
});

test('L1: metadata keys box with a zero-size entry does not loop forever', async () => {
  const keys = box('keys', be32(0), be32(0xffffffff), be32(0), str('mdta'), new Uint8Array(32));
  const meta = box('meta', box('hdlr', be32(0), be32(0), str('mdta'), new Uint8Array(12)), keys, box('ilst'));
  const u8 = mp4File(box('moov', box('udta', meta)));
  const err = await promptBounded(readMediaMeta(new Blob([u8])));
  assert.equal(err, null);
});

test('F6/F8: fragmented MP4 (empty sample table) and MOV LPCM are not streamable -> whole-file fallback, never bad-range', async () => {
  const frag = mp4File(moovBox({ stsz: { uni: 0, n: 0 }, stts: [], stsc: [], stco: [], duration: 0 }), 4000);
  const lpcm = mp4File(moovBox({ ...okTable(20), entry: soundEntry('sowt') }), 4000);
  for (const u8 of [frag, lpcm]) {
    await assert.rejects(readAudioTrack(new Blob([u8])), (e) => e.code === 'not-streamable');
    const blob = new Blob([u8]);
    // crop given: the streaming path is tried first; its failure must fall back (here: too large to read whole)
    await assert.rejects(decodeAudioFile(blob, { sampleRate: 8000, readMeta: false, crop: [0, 1], maxBytes: 100 }), (e) => e.code === 'too-large');
    // small enough: the whole-file decoder (fake WebAudio)
    const r = await withFakeOAC(() => decodeAudioFile(blob, { sampleRate: 8000, readMeta: false, crop: [0, 1] }));
    assert.equal(r.path, 'whole');
  }
});

test('F7: only PCM/float WAV is streamed; other formats fall back to the whole-file decoder', async () => {
  const blob = wavBytes(new Float32Array(8000), 8000);
  const u8 = new Uint8Array(await blob.arrayBuffer());
  new DataView(u8.buffer).setUint16(20, 2, true);             // MS ADPCM
  await assert.rejects(decodeWavStream(new Blob([u8]), { sampleRate: 8000 }), /cannot be streamed/);
  await assert.rejects(decodeAudioFile(new Blob([u8]), { sampleRate: 8000, readMeta: false, streamBytes: 0, maxBytes: 100 }), (e) => e.code === 'too-large');
  const r = await withFakeOAC(() => decodeAudioFile(new Blob([u8]), { sampleRate: 8000, readMeta: false, streamBytes: 0 }));
  assert.equal(r.path, 'whole');
});

test('F9: WebCodecs path flushes once at the end and waits on the decode queue', async () => {
  const u8 = new Uint8Array(readFileSync(DEMO));
  let flushes = 0, maxQ = 0;
  const prev = [globalThis.AudioDecoder, globalThis.EncodedAudioChunk];
  globalThis.EncodedAudioChunk = class { constructor(o) { Object.assign(this, o); } };
  globalThis.AudioDecoder = class extends EventTarget {
    static async isConfigSupported() { return { supported: true }; }
    constructor({ output }) { super(); this.output = output; this.q = []; }
    configure() {}
    get decodeQueueSize() { return this.q.length; }
    decode(c) {
      this.q.push(c); maxQ = Math.max(maxQ, this.q.length);
      if (this.q.length === 1) setTimeout(() => this._drain(), 0);
    }
    _drain() {
      for (const c of this.q.splice(0, 16)) this._out(c);
      this.dispatchEvent(new Event('dequeue'));
      if (this.q.length) setTimeout(() => this._drain(), 0);
    }
    _out(c) { this.output({ numberOfFrames: 1024, numberOfChannels: 1, sampleRate: 8000, timestamp: c.timestamp, copyTo: () => {}, close() {} }); }
    async flush() { flushes++; for (const c of this.q.splice(0)) this._out(c); }
    close() {}
  };
  try {
    const r = await decodeMp4Stream(new Blob([u8]), { sampleRate: 8000 });
    assert.equal(r.path, 'mp4-webcodecs');
    assert.equal(flushes, 1);
    assert.ok(maxQ <= 66, `queue grew to ${maxQ}`);
    assert.ok(Math.abs(r.samples.length / 8000 - r.duration) < 0.5);
  } finally { [globalThis.AudioDecoder, globalThis.EncodedAudioChunk] = prev; }
});
