// Audio ingestion + container metadata. ES module; parseWav/resample/readMediaMeta run in Node too,
// decodeAudioFile needs a browser (WebAudio).
//
// decodeAudioFile(file, {sampleRate=16000}) -> {samples: Float32Array (mono), sampleRate, duration,
//                                              channels, meta}   [browser]
// parseWav(arrayBufferOrU8) -> {sampleRate, channels, samples: Float32Array (mono mix), channelData: [Float32Array]}
// resample(x, fsIn, fsOut, {halfTaps=16}) -> Float32Array   (windowed-sinc, anti-aliased)
// readMediaMeta(source) -> {mvhdCreationUnix, durationSec, appleCreationDate, appleCreationUnix,
//                           dayString, best: {unix, source} | null}
//   source: Blob/File, ArrayBuffer, Uint8Array, or an async reader (offset, length) => Uint8Array
// makeReader(source) -> async (offset, length) => Uint8Array

import { decimate } from './geoloc/spectro.js';

// ---------------------------------------------------------------- WAV
export function parseWav(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= u8.length) {
    const id = tag(off), len = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      let format = dv.getUint16(off + 8, true);
      const channels = dv.getUint16(off + 10, true);
      const sampleRate = dv.getUint32(off + 12, true);
      const bits = dv.getUint16(off + 22, true);
      if (format === 0xfffe && len >= 40) format = dv.getUint16(off + 32, true); // EXTENSIBLE subformat
      fmt = { format, channels, sampleRate, bits };
    } else if (id === 'data') {
      dataOff = off + 8; dataLen = Math.min(len, u8.length - dataOff); break;
    }
    off += 8 + len + (len & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV missing fmt/data chunk');
  const { format, channels, sampleRate, bits } = fmt;
  const bps = bits / 8, n = Math.floor(dataLen / (bps * channels));
  const ch = Array.from({ length: channels }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      const o = dataOff + (i * channels + c) * bps;
      let v;
      if (format === 3) v = bits === 64 ? dv.getFloat64(o, true) : dv.getFloat32(o, true);
      else if (bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (bits === 8) v = (u8[o] - 128) / 128;
      else if (bits === 24) v = (((u8[o + 2] << 24) | (u8[o + 1] << 16) | (u8[o] << 8)) >> 8) / 8388608;
      else if (bits === 32) v = dv.getInt32(o, true) / 2147483648;
      else throw new Error(`unsupported WAV bits ${bits}`);
      ch[c][i] = v;
    }
  }
  return { sampleRate, channels, channelData: ch, samples: mixToMono(ch) };
}

export function mixToMono(chs) {
  if (chs.length === 1) return chs[0];
  const n = chs[0].length, out = new Float32Array(n), g = 1 / chs.length;
  for (const c of chs) for (let i = 0; i < n; i++) out[i] += c[i] * g;
  return out;
}

// ---------------------------------------------------------------- resampling
export function resample(x, fsIn, fsOut, { halfTaps = 16 } = {}) {
  if (fsIn === fsOut) return Float32Array.from(x);
  const ratio = fsIn / fsOut;
  const fc = 0.5 * Math.min(1, 1 / ratio) * 0.95;     // cutoff (cycles/input sample)
  const H = Math.ceil(halfTaps * Math.max(1, ratio));  // half-length in input samples
  const nOut = Math.floor(x.length / ratio);
  const out = new Float32Array(nOut);
  for (let n = 0; n < nOut; n++) {
    const tau = n * ratio, k0 = Math.floor(tau);
    let acc = 0, wsum = 0;
    for (let k = k0 - H + 1; k <= k0 + H; k++) {
      if (k < 0 || k >= x.length) continue;
      const d = tau - k;
      const s = d === 0 ? 1 : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d) / (2 * fc);
      const w = 0.5 + 0.5 * Math.cos(Math.PI * d / H);
      acc += x[k] * s * w; wsum += s * w;
    }
    out[n] = wsum ? acc / wsum : 0;
  }
  return out;
}

// ---------------------------------------------------------------- streaming resampler (B8)
/** Resample with the integer-ratio FIR decimator when fsIn/fsOut is an integer, windowed sinc otherwise. */
export function resampleTo(x, fsIn, fsOut) {
  if (fsIn === fsOut) return x;
  const M = fsIn / fsOut;
  return Number.isInteger(M) ? decimate(x, M) : resample(x, fsIn, fsOut);
}

/**
 * Block-by-block version of resampleTo(): push() any number of blocks, then flush(). The concatenated output equals
 * resampleTo(concatenated input) exactly (same taps, same edge handling), while only ~one filter length of input is
 * kept between calls. Used to decode hours of audio without ever holding it at the native rate.
 */
export class StreamResampler {
  constructor(fsIn, fsOut, { halfTaps = 16 } = {}) {
    this.fsIn = fsIn; this.fsOut = fsOut; this.ratio = fsIn / fsOut;
    this.M = Number.isInteger(this.ratio) ? this.ratio : 0;
    if (this.M) {                                  // taps of web/engine/geoloc/spectro.js#decimate
      const M = this.M, half = M === 1 ? 0 : 8 * M, L = 2 * half + 1, h = new Float64Array(L), fc = 0.45 / M;
      let sum = 0;
      for (let i = 0; i < L; i++) {
        const k = i - half, w = 0.5 + 0.5 * Math.cos(Math.PI * k / (half + 1));
        h[i] = M === 1 ? 1 : w * (k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k));
        sum += h[i];
      }
      for (let i = 0; i < L; i++) h[i] /= sum;
      this.h = h; this.half = half;
    } else {
      this.fc = 0.5 * Math.min(1, 1 / this.ratio) * 0.95;
      this.H = Math.ceil(halfTaps * Math.max(1, this.ratio));
    }
    this.buf = new Float32Array(1 << 12); this.base = 0; this.len = 0; this.n = 0;   // buf[i] = input[base + i]
  }
  get inputLength() { return this.len; }
  _hi(n) { return this.M ? n * this.M + this.half : Math.floor(n * this.ratio) + this.H; }
  _lo(n) { return this.M ? n * this.M - this.half : Math.floor(n * this.ratio) - this.H + 1; }
  _one(n, end) {
    const b = this.buf, base = this.base;
    if (this.M) {
      const c = n * this.M, half = this.half, h = this.h, L = h.length;
      let acc = 0;
      if (c - half >= 0 && c + half < end) { const o = c - half - base; for (let i = 0; i < L; i++) acc += h[i] * b[o + i]; }
      else for (let i = 0; i < L; i++) { const j = c - half + i; if (j >= 0 && j < end) acc += h[i] * b[j - base]; }
      return acc;
    }
    const tau = n * this.ratio, k0 = Math.floor(tau), H = this.H, fc = this.fc;
    let acc = 0, wsum = 0;
    for (let k = k0 - H + 1; k <= k0 + H; k++) {
      if (k < 0 || k >= end) continue;
      const d = tau - k;
      const s = d === 0 ? 1 : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d) / (2 * fc);
      const w = 0.5 + 0.5 * Math.cos(Math.PI * d / H);
      acc += b[k - base] * s * w; wsum += s * w;
    }
    return wsum ? acc / wsum : 0;
  }
  _emit(final) {
    const nMax = Math.floor(this.len / this.ratio);
    let m = 0;
    while (this.n + m < nMax && (final || this._hi(this.n + m) < this.len)) m++;
    const out = new Float32Array(m);
    for (let i = 0; i < m; i++) out[i] = this._one(this.n++, this.len);
    const keep = Math.max(this.base, Math.min(this.len, this._lo(this.n)));   // drop input no future output needs
    if (keep > this.base) { this.buf.copyWithin(0, keep - this.base, this.len - this.base); this.base = keep; }
    return out;
  }
  /** Append input (any length, may be a zero-filled gap); returns the newly available output samples. */
  push(x) {
    const used = this.len - this.base;
    if (used + x.length > this.buf.length) {
      const nb = new Float32Array(Math.max(2 * this.buf.length, used + x.length)); nb.set(this.buf.subarray(0, used)); this.buf = nb;
    }
    this.buf.set(x, used); this.len += x.length;
    return this._emit(false);
  }
  flush() { return this._emit(true); }
}

/** Growable Float32 output (avoids holding a list of blocks plus their concatenation). */
class F32Out {
  constructor(n) { this.a = new Float32Array(Math.max(1024, Math.ceil(n) || 0)); this.n = 0; }
  push(x) {
    if (this.n + x.length > this.a.length) { const b = new Float32Array(Math.ceil((this.n + x.length) * 1.25)); b.set(this.a.subarray(0, this.n)); this.a = b; }
    this.a.set(x, this.n); this.n += x.length;
  }
  result() { return this.n === this.a.length ? this.a : this.a.slice(0, this.n); }
}

// ---------------------------------------------------------------- browser decode
/** Above this size, MP4/MOV/M4A and WAV are decoded by streaming (only the audio bytes, a block at a time). */
export const STREAM_BYTES = 100e6;
/** Largest file read whole into memory (formats we cannot stream: MP3, WebM, Ogg, FLAC, ...). */
export function maxFullBytes(deviceMemoryGB = globalThis.navigator?.deviceMemory) {
  return Math.max(256e6, Math.min(1.5e9, (deviceMemoryGB ?? 4) * 1e9 / 6));
}
/** Error with a machine-readable code; the UI maps codes to translated messages ('too-large', 'undecodable', 'bad-range'). */
export function audioError(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }

async function sniff(file) {
  const u8 = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (u8.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WAVE') return 'wav';
  if (u8.length >= 8 && /^(ftyp|moov|mdat|free|wide|skip|pnot)$/.test(tag(4))) return 'iso';
  return /\.wav$/i.test(file.name || '') ? 'wav' : 'other';
}

/**
 * Decode a user's audio/video File to mono Float32 at `sampleRate`.
 *   crop: [a, b] seconds of the original recording to keep (null = all). Returned `samples` cover only the crop;
 *         `crop` echoes the exact range kept, `duration` is the FULL recording's duration.
 * MP4/MOV/M4A (AAC) and WAV larger than `streamBytes`, or any cropped one, are decoded by streaming: only the audio
 * samples (inside the crop) are read with Blob.slice and decoded block by block (WebCodecs AudioDecoder, else
 * ADTS-wrapped AAC through decodeAudioData). Other formats are read whole, up to `maxBytes`; beyond that an
 * audioError('too-large') is thrown, never a raw allocation failure.
 */
export async function decodeAudioFile(file, { sampleRate = 16000, readMeta = true, crop = null, streamBytes = STREAM_BYTES,
  maxBytes = maxFullBytes(), onProgress } = {}) {
  const meta = readMeta ? await readMediaMeta(file).catch((e) => ({ error: String(e) })) : null;
  const kind = await sniff(file);
  const big = file.size > maxBytes;
  if (kind === 'wav' && (file.size > streamBytes || crop)) {
    try { return { ...(await decodeWavStream(file, { sampleRate, crop, onProgress })), meta }; }
    catch (e) {
      if (e.code === 'bad-range') throw e;
      if (big) throw audioError('too-large', `Cannot stream "${file.name}" (${e.message || e}) and it is too large to read whole.`, { cause: e });
    }
  }
  if (kind === 'iso' && (file.size > streamBytes || crop)) {
    try { return { ...(await decodeMp4Stream(file, { sampleRate, crop, onProgress })), meta }; }
    catch (e) {
      if (e.code === 'bad-range') throw e;
      if (big) throw audioError('too-large', `Cannot stream the audio of "${file.name}" (${e.message || e}) and the file is too large to read whole.`, { cause: e });
      console.warn('[audio] streaming decode failed, reading the whole file:', e?.message || e);
    }
  }
  if (big) throw audioError('too-large', `"${file.name}" is too large to decode in the browser (${Math.round(file.size / 1e6)} MB).`);
  const r = await decodeWhole(file, kind, sampleRate);
  let { samples } = r;
  const duration = samples.length / r.sampleRate;
  let range = null;
  if (crop) {
    const a = Math.max(0, Math.floor(crop[0] * r.sampleRate)), b = Math.min(samples.length, Math.ceil(crop[1] * r.sampleRate));
    if (!(b > a)) throw audioError('bad-range', 'The chosen range is outside the recording.');
    samples = samples.slice(a, b); range = [a / r.sampleRate, b / r.sampleRate];
  }
  return { samples, sampleRate: r.sampleRate, duration, channels: r.channels, meta, crop: range, path: 'whole' };
}

async function decodeWhole(file, kind, sampleRate) {
  let buf;
  try { buf = await file.arrayBuffer(); }
  catch (e) { throw audioError('too-large', `Could not read "${file.name}" into memory: ${e?.message || e}`, { cause: e }); }
  try {
    const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OAC) throw new Error('no OfflineAudioContext');
    const ctx = new OAC(1, 1, sampleRate);
    // decodeAudioData decodes AND resamples to the context rate; it detaches `buf` (no defensive copy: B7)
    const ab = await ctx.decodeAudioData(buf);
    buf = null;
    const channels = ab.numberOfChannels;
    return { samples: mixToMono(Array.from({ length: channels }, (_, c) => ab.getChannelData(c))), sampleRate: ab.sampleRate, channels };
  } catch (err) {
    if (kind !== 'wav') {
      throw audioError('undecodable', `Could not decode audio from "${file.name}": ${err?.message || err}. ` +
        'Try converting to WAV/MP3 or a browser-supported codec (AAC/Opus/MP3).', { cause: err });
    }
    if (!buf || buf.byteLength === 0) buf = await file.arrayBuffer();   // detached by decodeAudioData: re-read only now
    const w = parseWav(buf);                 // fallback: pure-JS WAV
    buf = null;
    return { samples: resampleTo(w.samples, w.sampleRate, sampleRate), sampleRate, channels: w.channels };
  }
}

// ---------------------------------------------------------------- streaming WAV
/** Parse a WAV header from the first bytes of a file -> {format, channels, sampleRate, bits, dataOff, dataLen}. */
export function parseWavHeader(u8, fileSize = Infinity) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let off = 12, fmt = null;
  while (off + 8 <= u8.length) {
    const id = tag(off), len = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      let format = dv.getUint16(off + 8, true);
      if (format === 0xfffe && len >= 40) format = dv.getUint16(off + 32, true);
      fmt = { format, channels: dv.getUint16(off + 10, true), sampleRate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
    } else if (id === 'data') {
      if (!fmt) break;
      const dataOff = off + 8, avail = Math.max(0, fileSize - dataOff);
      return { ...fmt, dataOff, dataLen: len === 0 || len === 0xffffffff ? avail : Math.min(len, avail) };
    }
    off += 8 + len + (len & 1);
  }
  throw new Error('WAV missing fmt/data chunk');
}

function pcmToMono(u8, { format, channels, bits }, out) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), bps = bits / 8, n = out.length, g = 1 / channels;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * bps;
      let v;
      if (format === 3) v = bits === 64 ? dv.getFloat64(o, true) : dv.getFloat32(o, true);
      else if (bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (bits === 8) v = (u8[o] - 128) / 128;
      else if (bits === 24) v = (((u8[o + 2] << 24) | (u8[o + 1] << 16) | (u8[o] << 8)) >> 8) / 8388608;
      else if (bits === 32) v = dv.getInt32(o, true) / 2147483648;
      else throw new Error(`unsupported WAV bits ${bits}`);
      acc += v;
    }
    out[i] = channels === 1 ? acc : acc * g;
  }
  return out;
}

/** Stream a WAV (any size) block by block -> mono at `sampleRate`, optionally only crop [a, b] s. */
export async function decodeWavStream(file, { sampleRate = 8000, crop = null, onProgress, blockBytes = 4 << 20 } = {}) {
  const read = makeReader(file), size = sourceSize(file);
  const hd = parseWavHeader(await read(0, 1 << 20), size);
  // only integer PCM / IEEE float can be converted here; anything else (ADPCM, mu-law, ...) falls back to the
  // browser's whole-file decoder (decodeAudioFile catches this plain Error)
  const okBits = hd.format === 1 ? [8, 16, 24, 32] : hd.format === 3 ? [32, 64] : [];
  if (!okBits.includes(hd.bits) || !(hd.channels >= 1 && hd.channels <= 64) || !(hd.sampleRate >= 1000 && hd.sampleRate <= 768000)) {
    throw new Error(`WAV format ${hd.format} / ${hd.bits} bit / ${hd.channels} ch / ${hd.sampleRate} Hz cannot be streamed`);
  }
  const align = hd.channels * hd.bits / 8, total = Math.floor(hd.dataLen / align), duration = total / hd.sampleRate;
  const a = crop ? Math.max(0, Math.floor(crop[0] * hd.sampleRate)) : 0, b = crop ? Math.min(total, Math.ceil(crop[1] * hd.sampleRate)) : total;
  if (!(b > a)) throw audioError('bad-range', 'The chosen range is outside the recording.');
  const rs = new StreamResampler(hd.sampleRate, sampleRate), out = new F32Out((b - a) / rs.ratio + 16);
  const per = Math.max(1, Math.floor(blockBytes / align));
  for (let i = a; i < b; i += per) {
    const n = Math.min(per, b - i);
    out.push(rs.push(pcmToMono(await read(hd.dataOff + i * align, n * align), hd, new Float32Array(n))));
    onProgress?.((i + n - a) / (b - a));
  }
  out.push(rs.flush());
  return { samples: out.result(), sampleRate, duration, channels: hd.channels, crop: crop ? [a / hd.sampleRate, b / hd.sampleRate] : null, path: 'wav-stream' };
}

// ---------------------------------------------------------------- streaming MP4 / MOV audio (AAC)
/** Locate the top-level moov box -> {offset, size, hdr} or null. */
async function findMoov(read, size) {
  let o = 0;
  for (let guard = 0; guard < 4096 && o < size; guard++) {
    const h = await read(o, 16);
    if (h.length < 8) return null;
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let sz = dv.getUint32(0), hdr = 8;
    const type = fourcc(h, 4);
    if (guard === 0 && !/^(ftyp|moov|mdat|free|wide|skip|pnot)$/.test(type)) return null;
    if (sz === 1) { sz = u64(dv, 8); hdr = 16; } else if (sz === 0) sz = size - o;
    if (sz < 8) return null;
    if (type === 'moov') return { offset: o, size: sz, hdr };
    o += sz;
  }
  return null;
}

/** MPEG-4 AudioSpecificConfig -> {aot, sfi, sampleRate, channels}. */
export function parseASC(asc) {
  let bit = 0;
  const rd = (n) => { let v = 0; for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((asc[bit >> 3] >> (7 - (bit & 7))) & 1); return v; };
  let aot = rd(5); if (aot === 31) aot = 32 + rd(6);
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const sfi = rd(4), sampleRate = sfi === 15 ? rd(24) : RATES[sfi];
  return { aot, sfi, sampleRate, channels: rd(4) };
}

function readEsds(u8, b) {
  // full box (4) then descriptors: 0x03 ES_Descriptor > 0x04 DecoderConfig > 0x05 DecoderSpecificInfo (the ASC)
  let o = b.body + 4;
  const len = () => { let n = 0; for (let i = 0; i < 4; i++) { const c = u8[o++]; n = (n << 7) | (c & 0x7f); if (!(c & 0x80)) break; } return n; };
  while (o < b.end) {
    const tag = u8[o++], n = len();
    if (tag === 0x03) { const flags = u8[o + 2]; o += 3; if (flags & 0x80) o += 2; if (flags & 0x40) o += 1 + u8[o]; if (flags & 0x20) o += 2; }
    else if (tag === 0x04) { if (![0x40, 0x66, 0x67].includes(u8[o])) throw new Error(`audio object type 0x${u8[o].toString(16)} is not AAC`); o += 13; }
    else if (tag === 0x05) return u8.slice(o, o + n);
    else o += n;
  }
  throw new Error('esds without AudioSpecificConfig');
}

/** Most samples a sample table may declare (AAC at 48 kHz: ~47 frames/s -> > 100 h). Bounds the table arrays. */
export const MAX_TRACK_SAMPLES = 20e6;

/**
 * Sample table of the first AAC sound track of a moov box (u8 = moov body; fileSize = size of the whole file).
 * -> {timescale, duration (s), mediaTime (media units), delay (s), asc, aot, sfi, sampleRate, channels, n,
 *     offset: Float64Array (file offsets), size: Uint32Array, dts: Float64Array (media units)}
 * Hostile tables are rejected before any big allocation (audioError 'not-streamable': the caller falls back): sample
 * counts beyond the file / MAX_TRACK_SAMPLES or beyond their box, samples outside the file or overlapping (their
 * sizes summing to more than the file). An empty table (fragmented MP4: samples live in moof boxes) is not streamable.
 */
export function parseAudioTrack(u8, fileSize = Infinity) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const kid = (b, t) => (b ? boxes(u8, b.body, b.end).find((k) => k.type === t) : undefined);
  const top = boxes(u8, 0, u8.length);
  const mvhd = top.find((b) => b.type === 'mvhd');
  const movieTs = mvhd ? dv.getUint32(mvhd.body + (u8[mvhd.body] === 1 ? 20 : 12)) : 0;
  let codecSeen = null;
  for (const trak of top.filter((b) => b.type === 'trak')) {
    const mdia = kid(trak, 'mdia'), hdlr = kid(mdia, 'hdlr');
    if (!hdlr || fourcc(u8, hdlr.body + 8) !== 'soun') continue;
    const mdhd = kid(mdia, 'mdhd');
    if (!mdhd || mdhd.end - mdhd.body < 24) continue;
    const v1 = u8[mdhd.body] === 1;
    if (v1 && mdhd.end - mdhd.body < 32) continue;
    const timescale = dv.getUint32(mdhd.body + (v1 ? 20 : 12)), duration = v1 ? u64(dv, mdhd.body + 24) : dv.getUint32(mdhd.body + 16);
    const stbl = kid(kid(mdia, 'minf'), 'stbl'), stsd = kid(stbl, 'stsd');
    if (!stsd || stsd.end - stsd.body < 16) continue;
    const ent = stsd.body + 8, fmt = fourcc(u8, ent + 4);
    codecSeen = fmt;
    if (fmt !== 'mp4a') continue;
    const ver = dv.getUint16(ent + 16), childStart = ent + 36 + (ver === 1 ? 16 : ver === 2 ? 36 : 0), entEnd = ent + dv.getUint32(ent);
    const kids = boxes(u8, childStart, entEnd);
    const esds = kids.find((k) => k.type === 'esds') || kid(kids.find((k) => k.type === 'wave'), 'esds');
    if (!esds) throw new Error('mp4a track without esds');
    const asc = readEsds(u8, esds), cfg = parseASC(asc);
    if (!timescale) throw notStreamable('audio track timescale is 0');
    if (!(cfg.sampleRate >= 1000 && cfg.sampleRate <= 768000) || !(cfg.channels >= 1 && cfg.channels <= 8)) {
      throw notStreamable(`unsupported AAC configuration (${cfg.sampleRate} Hz, ${cfg.channels} ch)`);
    }
    // edit list: empty edits delay the track, the first real edit's media_time skips the encoder priming
    let mediaTime = 0, delay = 0;
    const elst = kid(kid(trak, 'edts'), 'elst');
    if (elst) {
      const ev1 = u8[elst.body] === 1, cnt = dv.getUint32(elst.body + 4), es = ev1 ? 20 : 12;
      for (let i = 0, o = elst.body + 8; i < cnt; i++, o += es) {
        const segDur = ev1 ? u64(dv, o) : dv.getUint32(o), mt = ev1 ? Number(dv.getBigInt64(o + 8)) : dv.getInt32(o + 4);
        if (mt === -1) { delay += movieTs ? segDur / movieTs : 0; continue; }
        mediaTime = mt; break;
      }
    }
    const stsz = kid(stbl, 'stsz'), stts = kid(stbl, 'stts'), stsc = kid(stbl, 'stsc');
    const stco = kid(stbl, 'stco'), co64 = kid(stbl, 'co64'), cb = stco || co64;
    if (!stsz) throw notStreamable('no stsz (compact stz2 sample sizes are not supported)');
    if (!stts || !stsc || !cb || [stsz, stts, stsc, cb].some((b) => b.end - b.body < 8)) throw notStreamable('incomplete sample table');
    const uni = dv.getUint32(stsz.body + 4), n = stsz.end - stsz.body >= 12 ? dv.getUint32(stsz.body + 8) : 0;
    if (!n) throw notStreamable('empty sample table (fragmented MP4?)');
    if (n > MAX_TRACK_SAMPLES || n > fileSize || (uni && n * uni > fileSize)) throw notStreamable(`sample table claims ${n} samples`);
    if (!uni && stsz.body + 12 + 4 * n > stsz.end) throw notStreamable('stsz table overruns its box');
    const size = new Uint32Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) { size[i] = uni || dv.getUint32(stsz.body + 12 + 4 * i); total += size[i]; }
    if (total > fileSize) throw notStreamable('sample sizes add up to more than the file');
    const dts = new Float64Array(n);
    { let s = 0, t = 0; const cnt = Math.min(dv.getUint32(stts.body + 4), Math.floor((stts.end - stts.body - 8) / 8));
      for (let e = 0; e < cnt && s < n; e++) { const c = dv.getUint32(stts.body + 8 + 8 * e), d = dv.getUint32(stts.body + 12 + 8 * e); for (let k = 0; k < c && s < n; k++) { dts[s++] = t; t += d; } }
      for (; s < n; s++) dts[s] = t; }
    const nCh = Math.min(dv.getUint32(cb.body + 4), Math.floor((cb.end - cb.body - 8) / (co64 ? 8 : 4)), n), chunkOff = new Float64Array(nCh);
    for (let i = 0; i < nCh; i++) chunkOff[i] = co64 ? u64(dv, cb.body + 8 + 8 * i) : dv.getUint32(cb.body + 8 + 4 * i);
    const nE = Math.min(dv.getUint32(stsc.body + 4), Math.floor((stsc.end - stsc.body - 8) / 12)), offset = new Float64Array(n);
    let s = 0;
    for (let e = 0; e < nE && s < n; e++) {
      const first = Math.max(0, dv.getUint32(stsc.body + 8 + 12 * e) - 1), per = dv.getUint32(stsc.body + 12 + 12 * e);
      if (!per) continue;                                        // 0 samples per chunk: nothing to place
      const next = Math.min(nCh, e + 1 < nE ? Math.max(0, dv.getUint32(stsc.body + 20 + 12 * e) - 1) : nCh);
      for (let c = first; c < next && s < n; c++) {
        let o = chunkOff[c];
        for (let k = 0; k < per && s < n; k++, s++) {
          if (o + size[s] > fileSize) throw notStreamable(`sample ${s} lies outside the file`);
          offset[s] = o; o += size[s];
        }
      }
    }
    if (s < n) throw notStreamable(`sample table places only ${s} of ${n} samples`);
    return { timescale, duration: duration / timescale, mediaTime, delay, asc, ...cfg, n, offset, size, dts };
  }
  throw notStreamable(codecSeen ? `audio codec "${codecSeen}" cannot be streamed (only AAC)` : 'no audio track');
}
function notStreamable(msg) { return audioError('not-streamable', msg); }

/** 7-byte ADTS header for one raw AAC frame (profile from the ASC object type; HE-AAC signalled as LC core). */
export function adtsHeader(cfg, frameLen) {
  const len = frameLen + 7, aot = cfg.aot === 5 || cfg.aot === 29 ? 2 : cfg.aot, prof = Math.max(0, Math.min(3, aot - 1)), h = new Uint8Array(7);
  h[0] = 0xff; h[1] = 0xf1;
  h[2] = (prof << 6) | ((cfg.sfi & 0x0f) << 2) | ((cfg.channels >> 2) & 1);
  h[3] = ((cfg.channels & 3) << 6) | ((len >> 11) & 3);
  h[4] = (len >> 3) & 0xff; h[5] = ((len & 7) << 5) | 0x1f; h[6] = 0xfc;
  return h;
}

/** Read samples [s0, s1) of the track, grouping neighbouring byte ranges into few Blob reads. Yields [index, bytes]. */
export async function* readSamples(read, tr, s0, s1, { gap = 64 << 10, maxGroup = 8 << 20 } = {}) {
  let s = s0;
  while (s < s1) {
    let e = s + 1, end = tr.offset[s] + tr.size[s];
    while (e < s1 && tr.offset[e] >= end && tr.offset[e] - end <= gap && tr.offset[e] + tr.size[e] - tr.offset[s] <= maxGroup) { end = tr.offset[e] + tr.size[e]; e++; }
    const base = tr.offset[s], u8 = await read(base, end - base);
    for (let k = s; k < e; k++) yield [k, u8.subarray(tr.offset[k] - base, tr.offset[k] - base + tr.size[k])];
    s = e;
  }
}

/** moov sample table of an MP4/MOV source (Blob/ArrayBuffer/reader) -> parseAudioTrack() result. */
export async function readAudioTrack(src) {
  const read = makeReader(src), mv = await findMoov(read, sourceSize(src));
  if (!mv) throw new Error('no moov box');
  if (mv.size > 256 * 1024 * 1024) throw new Error('moov box too large');
  return parseAudioTrack(await read(mv.offset + mv.hdr, mv.size - mv.hdr), sourceSize(src));
}

/**
 * Decode only the AAC audio of an MP4/MOV/M4A (optionally just [crop[0], crop[1]] s), downmixed and resampled to
 * `sampleRate` block by block. Peak memory ~ the output plus a few MB, whatever the size of the video.
 */
export async function decodeMp4Stream(file, { sampleRate = 8000, crop = null, onProgress, prefer = 'auto' } = {}) {
  const read = makeReader(file), tr = await readAudioTrack(file);
  // presentation time of sample s = (dts - mediaTime) / timescale + delay
  const pt = (s) => (tr.dts[s] - tr.mediaTime) / tr.timescale + tr.delay;
  // a crafted mdhd can claim hours over a few samples: never decode (silence) beyond the last real sample + 1 s
  const lastEnd = pt(tr.n - 1) + 1024 / tr.sampleRate;
  // n AAC frames hold at most n*2048 samples (HE-AAC): timestamps stretched far beyond that are a crafted file
  const realS = tr.n * 2048 / tr.sampleRate;
  if (!(tr.delay <= 60 + realS) || !(lastEnd - pt(0) <= 2 * realS + 60)) throw audioError('not-streamable', 'timestamps span too long');
  const duration = Math.max(0, Math.min(tr.duration - tr.mediaTime / tr.timescale + tr.delay, lastEnd + 1));
  const a = crop ? Math.max(0, crop[0]) : 0, b = crop ? Math.min(duration, crop[1]) : duration;
  if (!(b > a)) throw audioError('bad-range', 'The chosen range is outside the recording.');
  let s0 = 0; while (s0 < tr.n - 1 && pt(s0 + 1) <= a) s0++;
  s0 = Math.max(0, s0 - 2);                                    // 2 warm-up frames (MDCT overlap)
  let s1 = s0; while (s1 < tr.n && pt(s1) < b) s1++;
  s1 = Math.min(tr.n, s1 + 1);
  const sink = makeSink(a, b, sampleRate);
  const useWC = prefer !== 'adts' && typeof globalThis.AudioDecoder === 'function' && await wcSupported(tr);
  if (useWC) await decodeWebCodecs(read, tr, s0, s1, pt, sink, onProgress);
  else await decodeAdts(read, tr, s0, s1, pt, sink, onProgress);
  return { samples: sink.finish(), sampleRate, duration, channels: tr.channels, crop: crop ? [a, b] : null, path: useWC ? 'mp4-webcodecs' : 'mp4-adts' };
}

/** Collects mono native-rate blocks placed by presentation time, keeps [a, b), resamples to fsOut on the fly. */
export function makeSink(a, b, fsOut) {
  let rs = null, out = null, next = 0, endIdx = 0, fs = 0, zeros = null;
  const silence = (g) => {                                         // <= 1M native samples per allocation
    zeros ||= new Float32Array(1 << 20);
    for (let k = 0; k < g; k += zeros.length) out.push(rs.push(zeros.subarray(0, Math.min(zeros.length, g - k))));
  };
  return {
    /** x: mono samples at rate r whose first sample is at presentation time t (s). */
    put(x, t, r) {
      if (!rs) { fs = r; rs = new StreamResampler(r, fsOut); next = Math.round(a * r); endIdx = Math.round(b * r); out = new F32Out((endIdx - next) / rs.ratio + 16); }
      else if (r !== fs) throw new Error('sample rate changed mid-stream');
      const idx = Math.round(t * r);
      if (idx > next) {                                            // gap: fill with silence
        const g = Math.min(idx, endIdx) - next;
        if (g > 0) { silence(g); next += g; }
      }
      const k = Math.max(0, next - idx);                           // overlap / before the crop: skip
      const m = Math.min(x.length, k + Math.max(0, endIdx - next));
      if (m > k) { out.push(rs.push(x.subarray(k, m))); next += m - k; }
    },
    finish() {
      if (!rs) return new Float32Array(0);
      if (next < endIdx) { silence(endIdx - next); next = endIdx; }   // trailing silence
      out.push(rs.flush());
      return out.result();
    },
  };
}

const wcConfig = (tr) => ({ codec: `mp4a.40.${tr.aot}`, sampleRate: tr.sampleRate, numberOfChannels: tr.channels, description: tr.asc });
async function wcSupported(tr) {
  try { return !!(await AudioDecoder.isConfigSupported(wcConfig(tr))).supported; } catch { return false; }
}

function monoOf(ad) {
  const n = ad.numberOfFrames, C = ad.numberOfChannels, out = new Float32Array(n), tmp = C > 1 ? new Float32Array(n) : out;
  for (let c = 0; c < C; c++) {
    ad.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
    if (C > 1) for (let i = 0; i < n; i++) out[i] += tmp[i] / C;
  }
  return out;
}

async function decodeWebCodecs(read, tr, s0, s1, pt, sink, onProgress) {
  let err = null;
  const dec = new AudioDecoder({
    output: (ad) => { try { sink.put(monoOf(ad), ad.timestamp / 1e6, ad.sampleRate); } catch (e) { err ||= e; } finally { ad.close(); } },
    error: (e) => { err ||= e; },
  });
  dec.configure(wcConfig(tr));
  // Backpressure: wait for the queue to drain below MAXQ ('dequeue' event; a short poll where it is not supported).
  // flush() only once at the end: a flush resets the decoder state (MDCT overlap) and costs a round trip.
  const MAXQ = 64;
  const drained = () => new Promise((res) => {
    const t = setTimeout(done, 20);
    function done() { clearTimeout(t); dec.removeEventListener?.('dequeue', done); res(); }
    dec.addEventListener?.('dequeue', done);
  });
  let k = 0;
  try {
    for await (const [s, bytes] of readSamples(read, tr, s0, s1)) {
      if (err) throw err;
      const dur = s + 1 < tr.n ? (tr.dts[s + 1] - tr.dts[s]) / tr.timescale : 1024 / tr.sampleRate;
      dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(pt(s) * 1e6), duration: Math.round(dur * 1e6), data: bytes }));
      while (dec.decodeQueueSize > MAXQ && !err) await drained();
      if (++k % 256 === 0) onProgress?.((s - s0) / (s1 - s0));
    }
    await dec.flush();
    if (err) throw err;
  } finally { try { dec.close(); } catch { /* already closed */ } }
}

async function decodeAdts(read, tr, s0, s1, pt, sink, onProgress, { segment = 1024, warm = 2 } = {}) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) throw new Error('no OfflineAudioContext');
  for (let a = s0; a < s1; a += segment) {
    const w0 = Math.max(s0, a - warm), e = Math.min(s1, a + segment), parts = [];
    let total = 0;
    for await (const [, bytes] of readSamples(read, tr, w0, e)) { parts.push(adtsHeader(tr, bytes.length), bytes); total += 7 + bytes.length; }
    const buf = new Uint8Array(total); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
    const ab = await new OAC(1, 1, tr.sampleRate).decodeAudioData(buf.buffer);
    const x = mixToMono(Array.from({ length: ab.numberOfChannels }, (_, c) => ab.getChannelData(c)));
    const r = ab.sampleRate, perFrame = (pt(Math.min(tr.n - 1, w0 + 1)) - pt(w0)) * r || 1024 * r / tr.sampleRate;
    // decoders may drop the first frame of a raw ADTS stream (Chrome does): missing samples are at the start, so
    // x[k] is at time pt(w0) + (missing + k) / r. The warm-up frames are dropped; the sink fills any leading gap.
    const missing = Math.max(0, Math.round((e - w0) * perFrame) - x.length);
    const skip = Math.max(0, Math.round((a - w0) * perFrame) - missing);
    sink.put(x.subarray(Math.min(x.length, skip)), pt(w0) + (missing + skip) / r, r);
    onProgress?.((e - s0) / (s1 - s0));
  }
}

// ---------------------------------------------------------------- MP4 / MOV metadata
const MAC_EPOCH_OFFSET = 2082844800; // seconds between 1904-01-01 and 1970-01-01

const isBlobLike = (src) => (typeof Blob !== 'undefined' && src instanceof Blob) ||
  (!!src && typeof src.slice === 'function' && typeof src.size === 'number' && !ArrayBuffer.isView(src));

export function makeReader(src) {
  if (typeof src === 'function') return src;
  if (isBlobLike(src)) {
    return async (o, n) => new Uint8Array(await src.slice(o, Math.min(src.size, o + n)).arrayBuffer());
  }
  const u8 = src instanceof Uint8Array ? src : new Uint8Array(src);
  return async (o, n) => u8.subarray(o, Math.min(u8.length, o + n));
}

function sourceSize(src) {
  if (isBlobLike(src)) return src.size;
  if (src instanceof Uint8Array || src instanceof ArrayBuffer) return src.byteLength;
  return Infinity;
}

const fourcc = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
function u64(dv, o) { return dv.getUint32(o) * 4294967296 + dv.getUint32(o + 4); }

/** iterate child boxes in u8[start,end) -> [{type, start (header), body, end}] */
function boxes(u8, start, end) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o), hdr = 8;
    const type = fourcc(u8, o + 4);
    if (size === 1) { size = u64(dv, o + 8); hdr = 16; } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) break;
    out.push({ type, start: o, body: o + hdr, end: o + size });
    o += size;
  }
  return out;
}

const utf8 = (u8) => new TextDecoder().decode(u8);

/** parse an ISO-ish date with optional "+hhmm" offset -> unix seconds or null */
export function parseDateToUnix(s) {
  if (!s) return null;
  let t = s.trim().replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  if (/^\d{4}-\d\d-\d\d \d/.test(t)) t = t.replace(' ', 'T');
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function parseMeta(u8, b, res) {
  // QuickTime 'meta' is a plain box; ISO 'meta' is a FullBox (4 extra bytes). Detect.
  let body = b.body;
  const t1 = fourcc(u8, body + 4);
  if (!/^(hdlr|keys|ilst)$/.test(t1)) body += 4;
  const kids = boxes(u8, body, b.end);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const keys = [null];
  const keysBox = kids.find((k) => k.type === 'keys');
  if (keysBox) {
    const cnt = dv.getUint32(keysBox.body + 4);
    let o = keysBox.body + 8;
    for (let i = 0; i < cnt && o + 8 <= keysBox.end; i++) {
      const sz = dv.getUint32(o);
      if (sz < 8) break;                                         // malformed: would never advance
      keys.push(utf8(u8.subarray(o + 8, Math.min(o + sz, keysBox.end))));
      o += sz;
    }
  }
  const ilst = kids.find((k) => k.type === 'ilst');
  if (!ilst) return;
  for (const item of boxes(u8, ilst.body, ilst.end)) {
    const idx = dv.getUint32(item.start + 4);
    const name = keysBox && idx > 0 && idx < keys.length ? keys[idx] : item.type;
    const data = boxes(u8, item.body, item.end).find((k) => k.type === 'data');
    if (!data) continue;
    const val = utf8(u8.subarray(data.body + 8, data.end));
    if (name === 'com.apple.quicktime.creationdate') res.appleCreationDate = val;
    else if (name === '©day' && !res.dayString) res.dayString = val;
  }
}

function parseMoov(u8, res) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const walk = (start, end) => {
    for (const b of boxes(u8, start, end)) {
      if (b.type === 'mvhd') {
        const v = u8[b.body];
        let ct, ts, dur;
        if (v === 1) { ct = u64(dv, b.body + 4); ts = dv.getUint32(b.body + 20); dur = u64(dv, b.body + 24); }
        else { ct = dv.getUint32(b.body + 4); ts = dv.getUint32(b.body + 12); dur = dv.getUint32(b.body + 16); }
        res.mvhdCreationUnix = ct > 0 ? ct - MAC_EPOCH_OFFSET : null;
        res.durationSec = ts ? dur / ts : null;
      } else if (b.type === 'udta') {
        for (const c of boxes(u8, b.body, b.end)) {
          if (c.type === 'meta') parseMeta(u8, c, res);
          else if (c.type === '©day') {
            // QuickTime user-data text: u16 len, u16 lang, text
            const len = dv.getUint16(c.body);
            res.dayString = utf8(u8.subarray(c.body + 4, c.body + 4 + len));
          }
        }
      } else if (b.type === 'meta') parseMeta(u8, b, res);
    }
  };
  walk(0, u8.length);
}

export async function readMediaMeta(src) {
  const read = makeReader(src);
  const size = sourceSize(src);
  const res = { container: null, mvhdCreationUnix: null, durationSec: null, appleCreationDate: null,
    appleCreationUnix: null, dayString: null, best: null };
  let o = 0;
  for (let guard = 0; guard < 4096 && o < size; guard++) {
    const h = await read(o, 16);
    if (h.length < 8) break;
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let sz = dv.getUint32(0);
    const type = fourcc(h, 4);
    if (guard === 0 && !/^(ftyp|moov|mdat|free|wide|skip|pnot)$/.test(type)) return res; // not ISO-BMFF
    res.container = 'isobmff';
    if (sz === 1) sz = u64(dv, 8); else if (sz === 0) sz = size - o;
    if (sz < 8) break;
    if (type === 'moov') {
      if (sz > 256 * 1024 * 1024) throw new Error('moov box too large');
      parseMoov(await read(o + 8, sz - 8), res);
      break;
    }
    o += sz;
  }
  res.appleCreationUnix = parseDateToUnix(res.appleCreationDate);
  if (res.appleCreationUnix != null) res.best = { unix: res.appleCreationUnix, source: 'com.apple.quicktime.creationdate' };
  else if (res.mvhdCreationUnix != null) res.best = { unix: res.mvhdCreationUnix, source: 'mvhd.creation_time' };
  else if (parseDateToUnix(res.dayString) != null) res.best = { unix: parseDateToUnix(res.dayString), source: '©day' };
  return res;
}
