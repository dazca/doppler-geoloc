// Date gate driven by the availability manifest (web/ui/coverage-gate.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { utcDays, mergeManifest, dateGate, fetchManifest } from '../ui/coverage-gate.js';

const U = (iso) => Date.parse(iso) / 1000;
const CFG = { bbox: [40.45, 0.10, 42.95, 3.40], from: '2026-10-08' };
const M = { days: ['2026-10-20', '2026-10-18', '2026-10-22', '2026-10-23'], from: '2026-10-18', to: '2026-10-23' };
const COV = mergeManifest(CFG, M);
const NOW = U('2026-11-07T12:00:00Z');
const win = (a, b) => ({ t0: U(a), t1: U(b) });

test('utcDays lists every UTC day touched', () => {
  assert.deepEqual(utcDays(U('2026-10-20T23:00:00Z'), U('2026-10-21T00:30:00Z')), ['2026-10-20', '2026-10-21']);
  assert.deepEqual(utcDays(U('2026-10-20T01:00:00Z'), U('2026-10-20T02:00:00Z')), ['2026-10-20']);
});

test('mergeManifest: from/to/days from the manifest (sorted), bbox kept; bad or empty manifest -> config', () => {
  assert.deepEqual(COV, { ...CFG, from: '2026-10-18', to: '2026-10-23', days: ['2026-10-18', '2026-10-20', '2026-10-22', '2026-10-23'] });
  assert.equal(mergeManifest(CFG, null), CFG);
  assert.equal(mergeManifest(CFG, { days: [] }), CFG);
  assert.equal(mergeManifest(CFG, { days: 'x' }), CFG);
});

test('before the first manifest day -> gate.date; available day -> ok', () => {
  assert.equal(dateGate(win('2026-10-12T10:00:00Z', '2026-10-12T11:00:00Z'), COV, { now: NOW }), 'gate.date');
  assert.equal(dateGate(win('2026-10-20T10:00:00Z', '2026-10-20T11:00:00Z'), COV, { now: NOW }), null);
});

test('a missing day inside the range, or after the last day -> gate.missing', () => {
  assert.equal(dateGate(win('2026-10-19T10:00:00Z', '2026-10-19T11:00:00Z'), COV, { now: NOW }), 'gate.missing');
  assert.equal(dateGate(win('2026-11-06T10:00:00Z', '2026-11-06T11:00:00Z'), COV, { now: NOW }), 'gate.missing');
});

test('a window spanning midnight needs both days (start window + duration)', () => {
  // 22 + 23 both present
  assert.equal(dateGate(win('2026-10-22T23:00:00Z', '2026-10-22T23:30:00Z'), COV, { now: NOW, dur: 3600 }), null);
  // 20 present, 21 missing: the recording runs into the 21st
  assert.equal(dateGate(win('2026-10-20T23:00:00Z', '2026-10-20T23:30:00Z'), COV, { now: NOW, dur: 3600 }), 'gate.missing');
  assert.equal(dateGate(win('2026-10-20T23:00:00Z', '2026-10-20T23:30:00Z'), COV, { now: NOW, dur: 60 }), null);
  // straddling the first day: the day before `from` is not required (only fully-before windows are blocked)
  assert.equal(dateGate(win('2026-10-17T23:30:00Z', '2026-10-18T00:30:00Z'), COV, { now: NOW }), null);
});

test('future and live recordings; config fallback (no days) only checks from', () => {
  assert.equal(dateGate(win('2026-11-09T10:00:00Z', '2026-11-09T11:00:00Z'), COV, { now: NOW }), 'gate.future');
  assert.equal(dateGate(win('2026-11-07T11:00:00Z', '2026-11-07T11:01:00Z'), COV, { now: NOW, live: true }), null);
  assert.equal(dateGate(win('2026-10-19T10:00:00Z', '2026-10-19T11:00:00Z'), CFG, { now: NOW }), null);
  assert.equal(dateGate(win('2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z'), CFG, { now: NOW }), 'gate.date');
  assert.equal(dateGate(null, COV, { now: NOW }), null);
});

test('fetchManifest: URL, JSON on 200, null on error / HTTP failure / no worker', async () => {
  let url;
  const ok = async (u) => { url = u; return { ok: true, json: async () => M }; };
  assert.deepEqual(await fetchManifest('https://d.example/', { fetch: ok }), M);
  assert.equal(url, 'https://d.example/adsb/index/meta/coverage.json');
  assert.equal(await fetchManifest('https://d.example', { fetch: async () => ({ ok: false }) }), null);
  assert.equal(await fetchManifest('https://d.example', { fetch: async () => { throw new TypeError('Failed to fetch'); } }), null);
  assert.equal(await fetchManifest('', { fetch: ok }), null);
});
