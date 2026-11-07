// Clock offset between this device and the ADS-B server (Lane L prototype).
//
// Wall clock for the recording = performance.timeOrigin + performance.now() (monotonic, not affected by
// NTP steps during the clip). Each poll gives one sample: local send/receive times and a server time.
//  - adsb.lol re-api JSON carries `now` in **milliseconds** (the readsb snapshot time). offset = now - mid,
//    error <= RTT/2 + snapshot age (the snapshot is regenerated about every 0.5-1 s, so `now` is a lower bound).
//  - The HTTP `Date` header has 1 s resolution: each sample only says server_time in [D, D+1). Intersecting
//    the intervals [D - recv, D + 1 - send] over many polls narrows the offset (the "second edge" trick).
// ADS-B position times themselves come from the server clock, so what matters is local <-> server offset.

export const wallNow = () => performance.timeOrigin + performance.now(); // ms

export class ServerClock {
  constructor() { this.samples = []; this.lo = -Infinity; this.hi = Infinity; }

  /** sendMs/recvMs: wallNow() around the request. serverMs: JSON `now` (ms) or null. dateHeader: string|null. */
  add({ sendMs, recvMs, serverMs = null, dateHeader = null }) {
    const rtt = recvMs - sendMs;
    if (serverMs != null) this.samples.push({ rtt, off: serverMs - (sendMs + recvMs) / 2 });
    if (dateHeader) {
      const D = Date.parse(dateHeader);
      if (Number.isFinite(D)) { // server time at some moment in [send, recv] lies in [D, D+1000)
        this.lo = Math.max(this.lo, D - recvMs);
        this.hi = Math.min(this.hi, D + 1000 - sendMs);
      }
    }
    if (this.samples.length > 500) this.samples.shift();
  }

  /** Best estimate from JSON `now`: median offset of the 20% lowest-RTT samples. */
  estimate() {
    const s = this.samples.slice().sort((a, b) => a.rtt - b.rtt);
    const k = Math.max(1, Math.ceil(s.length * 0.2));
    const best = s.slice(0, k).map((x) => x.off).sort((a, b) => a - b);
    const off = best.length ? best[best.length >> 1] : null;
    return {
      offsetMs: off, minRttMs: s[0]?.rtt ?? null, n: s.length,
      dateBoundMs: Number.isFinite(this.lo) ? [this.lo, this.hi] : null, // Date-header interval for the offset
    };
  }
}
