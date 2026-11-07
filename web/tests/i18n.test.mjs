// UI v3 i18n: CA and EN carry the same keys, and every key the markup or UI code uses exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DICT, t } from '../ui/i18n.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('CA and EN dictionaries have the same keys', () => {
  const ca = Object.keys(DICT.ca).sort(), en = Object.keys(DICT.en).sort();
  assert.deepEqual(ca.filter((k) => !DICT.en[k]), [], 'missing in EN');
  assert.deepEqual(en.filter((k) => !DICT.ca[k]), [], 'missing in CA');
});

test('every static data-i18n / data-help key and literal t() key exists', () => {
  const html = read('../index.html');
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-aria|-title|-ph)?="([^"]+)"/g)) keys.add(m[1]);
  for (const m of html.matchAll(/data-help="([^"]+)"/g)) { keys.add(`help.${m[1]}`); keys.add(`help.${m[1]}.topic`); }
  for (const f of ['../ui/app.js', '../ui/live-panel.js', '../ui/map-panel.js']) {
    for (const m of read(f).matchAll(/\bt\('([a-z0-9_.-]+)'/gi)) keys.add(m[1]);
  }
  for (const k of ['need.file', 'need.detecting', 'need.passes', 'need.time', 'need.area', 'gate.area', 'gate.date', 'gate.future',
    'gate.area.sub', 'gate.date.sub', 'gate.future.sub', ...['prop', 'heli', 'jet', 'unknown'].map((c) => `cls.${c}`),
    ...['grid', 'cpa', 'filters', 'sim', 'score', 'refine'].map((s) => `stage.${s}`), 'pe.good', 'pe.moderate', 'pe.bad']) keys.add(k);
  const missing = [...keys].filter((k) => DICT.ca[k] == null);
  assert.deepEqual(missing, []);
});

test('interpolation and plural helpers', () => {
  assert.equal(t('ev.pass', { l: 'B' }), 'Passada B');
  assert.match(t('run.ready', { n: 1 }), /^1 passada /);
  assert.match(t('run.ready', { n: 2 }), /^2 passades /);
});
