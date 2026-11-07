// Microphone recorder with a wall-clock anchor (Lane L prototype). Browser only.
//
// Raw PCM is captured with an AudioWorklet (no MediaRecorder: its timestamps are not exposed and the codec adds
// an unknown delay). The anchor maps audio frame 0 to wall-clock time:
//   ctx.getOutputTimestamp() -> {contextTime, performanceTime} links the audio clock to performance.now();
//   frame k was captured at contextTime_k = startFrame/fs + k/fs, minus the input latency (not exposed by browsers;
//   typically 5-40 ms, we subtract ctx.baseLatency as a rough proxy). Error budget: well under 0.1 s.
// T_start (server clock) = tStartLocalMs + clockOffsetMs.

const WORKLET = `
class Cap extends AudioWorkletProcessor {
  constructor() { super(); this.first = true; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      if (this.first) { this.port.postMessage({ startFrame: currentFrame, startTime: currentTime }); this.first = false; }
      this.port.postMessage(ch.slice(0));
    }
    return true;
  }
}
registerProcessor('cap', Cap);`;

export async function startRecording({ onLevel } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  const ctx = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'cap', { numberOfInputs: 1, numberOfOutputs: 0 });
  const chunks = [];
  let anchor = null, n = 0;
  node.port.onmessage = (e) => {
    if (e.data.startFrame !== undefined) {
      const ts = ctx.getOutputTimestamp(); // contextTime (s) <-> performanceTime (ms)
      const perfAtStart = ts.performanceTime - (ts.contextTime - e.data.startTime) * 1000 - (ctx.baseLatency || 0) * 1000;
      anchor = { tStartLocalMs: performance.timeOrigin + perfAtStart, fs: ctx.sampleRate, baseLatency: ctx.baseLatency };
      return;
    }
    chunks.push(e.data); n += e.data.length;
    if (onLevel && chunks.length % 20 === 0) {
      let s = 0; for (const v of e.data) s += v * v; onLevel(Math.sqrt(s / e.data.length), n / ctx.sampleRate);
    }
  };
  src.connect(node);
  return {
    get seconds() { return n / ctx.sampleRate; },
    async stop() {
      src.disconnect(); node.port.onmessage = null;
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
      const samples = new Float32Array(n); let o = 0;
      for (const c of chunks) { samples.set(c, o); o += c.length; }
      return { samples, fs: anchor?.fs ?? 48000, tStartLocalMs: anchor?.tStartLocalMs ?? null, anchor };
    },
  };
}
