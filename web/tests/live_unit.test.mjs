// Lane L offline unit tests: node --test web/tests/live_unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveTrackBuilder, bboxAround } from '../live/adsb-live.js';
import { ServerClock } from '../live/clock.js';
import { geoidN } from '../live/geoid.js';
import { liveSearchInput } from '../live/session.js';

const types = { C172: ['prop', 'L1P', 'L'] };
const snap = (nowMs, seen, lat, lon) => ({ now: nowMs, ac: [{ hex: 'abc123', t: 'C172', r: 'EC-XYZ', flight: 'ECXYZ ', lat, lon, seen_pos: seen, alt_baro: 2000, alt_geom: 2200, gs: 100, track: 90 }] });

test('geoid grid matches EGM96 within ~1.5 m at known points', () => {
  assert.ok(Math.abs(geoidN(41.52, 2.10) - 49.81) < 1.5);
  assert.ok(Math.abs(geoidN(40.8, -73.0) - -32.1) < 1.5);
});

test('snapshots -> positions timed at now - seen_pos, duplicates dropped, MSL alt', () => {
  const b = new LiveTrackBuilder();
  const T = 1793772800;
  b.addSnapshot(snap(T * 1000, 0.5, 41.50, 2.10));
  b.addSnapshot(snap(T * 1000 + 300, 0.8, 41.50, 2.10)); // same position report (T - 0.5) -> dropped
  b.addSnapshot(snap((T + 2) * 1000, 0.2, 41.50, 2.11));
  const [tr] = b.toTracks({ bbox: bboxAround(41.5, 2.1, 20000), types });
  assert.equal(tr.points.length, 2);
  assert.equal(tr.points[0][0], T - 0.5);
  assert.equal(tr.points[1][0], T + 1.8);
  assert.equal(tr.category, 'prop');
  assert.ok(Math.abs(tr.points[0][3] - (2200 * 0.3048 - geoidN(41.5, 2.1))) < 0.2);
});

test('trace_full/recent merge with snapshots by time', () => {
  const b = new LiveTrackBuilder();
  const T = 1793772800;
  b.addTrace({ icao: 'abc123', t: 'C172', timestamp: T - 100, trace: [[0, 41.5, 2.0, 2000, 100, 90, 2, 0, null, 'adsb_icao', 2200], [50, 41.5, 2.05, 2000, 100, 90, 0, 0, null, 'adsb_icao', 2200]] });
  b.addSnapshot(snap(T * 1000, 0, 41.5, 2.1));
  const [tr] = b.toTracks({ bbox: bboxAround(41.5, 2.05, 20000), types });
  assert.deepEqual(tr.points.map((p) => p[0]), [T - 100, T - 50, T]);
});

test('server clock: min-RTT offset and Date-header bound', () => {
  const c = new ServerClock();
  c.add({ sendMs: 1000, recvMs: 1100, serverMs: 1250 });      // off 200, rtt 100
  c.add({ sendMs: 2000, recvMs: 2600, serverMs: 2600 });      // off 300, rtt 600 (ignored)
  c.add({ sendMs: 3000, recvMs: 3050, serverMs: 3225, dateHeader: new Date(3000).toUTCString() }); // off 200
  const e = c.estimate();
  assert.equal(e.offsetMs, 200);
  assert.deepEqual(e.dateBoundMs, [3000 - 3050, 4000 - 3000]);
});

test('live search input: T_start window +-3 s', () => {
  const inp = liveSearchInput({ events: [{}], tracks: [], center: [41.5, 2.1], tStartUnix: 1000, durationS: 60 });
  assert.deepEqual([inp.time.t0, inp.time.t1], [997, 1003]);
  assert.equal(inp.region.shape, 'circle');
});
