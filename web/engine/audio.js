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

// ---------------------------------------------------------------- browser decode
/** Decode a user's audio/video File to mono Float32 at `sampleRate` (browser resamples). */
export async function decodeAudioFile(file, { sampleRate = 16000, readMeta = true } = {}) {
  const meta = readMeta ? await readMediaMeta(file).catch((e) => ({ error: String(e) })) : null;
  const buf = await file.arrayBuffer();
  let samples, channels, rate = sampleRate;
  const isWav = /\.wav$/i.test(file.name || '') || (buf.byteLength > 12 &&
    String.fromCharCode(...new Uint8Array(buf, 0, 4)) === 'RIFF');
  try {
    const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OAC) throw new Error('no OfflineAudioContext');
    const ctx = new OAC(1, 1, sampleRate);
    // decodeAudioData decodes AND resamples to the context rate; it detaches `buf`.
    const ab = await ctx.decodeAudioData(isWav ? buf.slice(0) : buf);
    channels = ab.numberOfChannels;
    samples = mixToMono(Array.from({ length: channels }, (_, c) => ab.getChannelData(c)));
    rate = ab.sampleRate;
  } catch (err) {
    if (!isWav) throw new Error(`Could not decode audio from "${file.name}": ${err.message || err}. ` +
      'Try converting to WAV/MP3 or a browser-supported codec (AAC/Opus/MP3).');
    const w = parseWav(buf);                 // fallback: pure-JS WAV
    channels = w.channels;
    samples = resample(w.samples, w.sampleRate, sampleRate);
  }
  return { samples, sampleRate: rate, duration: samples.length / rate, channels, meta };
}

// ---------------------------------------------------------------- MP4 / MOV metadata
const MAC_EPOCH_OFFSET = 2082844800; // seconds between 1904-01-01 and 1970-01-01

export function makeReader(src) {
  if (typeof src === 'function') return src;
  if (typeof Blob !== 'undefined' && src instanceof Blob) {
    return async (o, n) => new Uint8Array(await src.slice(o, Math.min(src.size, o + n)).arrayBuffer());
  }
  const u8 = src instanceof Uint8Array ? src : new Uint8Array(src);
  return async (o, n) => u8.subarray(o, Math.min(u8.length, o + n));
}

function sourceSize(src) {
  if (typeof Blob !== 'undefined' && src instanceof Blob) return src.size;
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
      keys.push(utf8(u8.subarray(o + 8, o + sz)));
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
