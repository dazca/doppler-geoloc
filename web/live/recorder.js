// Microphone recorder with a wall-clock anchor (Lane L prototype). Browser only (PcmBlockStore also runs in Node).
//
// Raw PCM is captured with an AudioWorklet (no MediaRecorder: its timestamps are not exposed and the codec adds
// an unknown delay). The anchor maps audio frame 0 to wall-clock time:
//   ctx.getOutputTimestamp() -> {contextTime, performanceTime} links the audio clock to performance.now();
//   frame k was captured at contextTime_k = startFrame/fs + k/fs, minus the input latency (not exposed by browsers;
//   typically 5-40 ms, we subtract ctx.baseLatency as a rough proxy). Error budget: well under 0.1 s.
// T_start (server clock) = tStartLocalMs + clockOffsetMs.
//
// Memory (B2): the worklet batches ~1 s of samples per message (transferred, not copied) and the main thread
// immediately resamples them to STORE_RATE (8 kHz, the app's analysis rate; centred FIR, so frame 0 keeps its
// time) and stores 16-bit PCM in preallocated 60 s blocks: 45 min = 43 MB instead of ~0.6 GB of Float32 chunks.
import { StreamResampler } from '../engine/audio.js';

export const STORE_RATE = 8000;

const WORKLET = `
class Cap extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = (o && o.processorOptions) || {};
    this.first = true; this.N = p.block || 48000; this.buf = new Float32Array(this.N); this.k = 0;
    this.lvEvery = p.level || 4800; this.lvS = 0; this.lvN = 0;
    this.port.onmessage = (e) => {
      if (e.data !== 'flush') return;
      const rest = this.buf.slice(0, this.k); this.k = 0;
      this.port.postMessage({ final: rest }, [rest.buffer]);
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      if (this.first) { this.port.postMessage({ startFrame: currentFrame, startTime: currentTime }); this.first = false; }
      for (let i = 0; i < ch.length; i++) {
        const v = ch[i];
        this.buf[this.k++] = v; this.lvS += v * v; this.lvN++;
        if (this.k === this.N) { const b = this.buf; this.port.postMessage(b, [b.buffer]); this.buf = new Float32Array(this.N); this.k = 0; }
        if (this.lvN === this.lvEvery) { this.port.postMessage({ rms: Math.sqrt(this.lvS / this.lvN) }); this.lvS = 0; this.lvN = 0; }
      }
    }
    return true;
  }
}
registerProcessor('cap', Cap);`;

/**
 * 16-bit mono PCM in fixed-size blocks, fed at any input rate and stored at `fsOut`.
 *   push(Float32Array)   finish() -> {blocks: [Int16Array], n, fs}   wavFile(name) -> File   bytes   seconds
 */
export class PcmBlockStore {
  constructor(fsIn, { fsOut = STORE_RATE, blockSeconds = 60 } = {}) {
    this.fs = fsOut; this.rs = new StreamResampler(fsIn, fsOut);
    this.blockLen = Math.round(blockSeconds * fsOut); this.blocks = []; this.cur = null; this.k = 0; this.n = 0; this.inN = 0; this.fsIn = fsIn;
  }
  get bytes() { return (this.blocks.length + (this.cur ? 1 : 0)) * this.blockLen * 2; }
  /** seconds captured so far (input side) */
  get seconds() { return this.inN / this.fsIn; }
  _write(y) {
    for (let i = 0; i < y.length; i++) {
      if (!this.cur) { this.cur = new Int16Array(this.blockLen); this.k = 0; }
      const v = y[i];
      this.cur[this.k++] = (v > 1 ? 1 : v < -1 ? -1 : v) * 32767;
      if (this.k === this.blockLen) { this.blocks.push(this.cur); this.cur = null; }
    }
    this.n += y.length;
  }
  push(x) { this.inN += x.length; this._write(this.rs.push(x)); }
  finish() {
    this._write(this.rs.flush());
    if (this.cur) { this.blocks.push(this.cur.subarray(0, this.k)); this.cur = null; }
    return { blocks: this.blocks, n: this.n, fs: this.fs };
  }
}

/** RIFF/WAVE header for n 16-bit mono samples. */
export function wavHeader(n, fs) {
  const buf = new ArrayBuffer(44), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + 2 * n, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, fs, true);
  v.setUint32(28, fs * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, 2 * n, true);
  return buf;
}
/** Int16 blocks -> one Float32Array (dev tools; the app never needs it). */
export function blocksToFloat32(blocks, n) {
  const out = new Float32Array(n); let o = 0;
  for (const b of blocks) { for (let i = 0; i < b.length && o < n; i++) out[o++] = b[i] / 32768; }
  return out;
}
/** WAV File straight from Int16 blocks (no concatenated copy in JS). */
export const wavFromBlocks = (blocks, n, fs, name) => new File([wavHeader(n, fs), ...blocks], name, { type: 'audio/wav' });

export async function startRecording({ onLevel } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  const ctx = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const src = ctx.createMediaStreamSource(stream);
  const fs = ctx.sampleRate;
  const node = new AudioWorkletNode(ctx, 'cap', { numberOfInputs: 1, numberOfOutputs: 0,
    processorOptions: { block: Math.round(fs), level: Math.round(fs / 10) } });
  const store = new PcmBlockStore(fs);
  let anchor = null, onFinal = null;
  node.port.onmessage = (e) => {
    const d = e.data;
    if (d instanceof Float32Array) { store.push(d); return; }
    if (d.rms !== undefined) { onLevel?.(d.rms, store.seconds); return; }
    if (d.final) { store.push(d.final); onFinal?.(); return; }
    if (d.startFrame !== undefined) {
      const ts = ctx.getOutputTimestamp(); // contextTime (s) <-> performanceTime (ms)
      const perfAtStart = ts.performanceTime - (ts.contextTime - d.startTime) * 1000 - (ctx.baseLatency || 0) * 1000;
      anchor = { tStartLocalMs: performance.timeOrigin + perfAtStart, fs, storedFs: store.fs, baseLatency: ctx.baseLatency };
    }
  };
  src.connect(node);
  return {
    get seconds() { return store.seconds; },
    get bytes() { return store.bytes; },
    /** -> {blocks: [Int16Array], n, fs (stored rate), tStartLocalMs, anchor}. The caller owns (and should drop) blocks. */
    async stop() {
      src.disconnect();
      await new Promise((res) => { onFinal = res; node.port.postMessage('flush'); setTimeout(res, 500); });   // the last < 1 s
      node.port.onmessage = null;
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
      const { blocks, n } = store.finish();
      return { blocks, n, fs: store.fs, tStartLocalMs: anchor?.tStartLocalMs ?? null, anchor };
    },
  };
}
