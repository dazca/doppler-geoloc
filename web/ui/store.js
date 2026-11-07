// Project state: defaults, localStorage draft autosave, JSON export/import.
import { browserTz } from './time-utils.js';

export const PROJECT_VERSION = 1;
const DRAFT_KEY = 'overhead.draft.v1';

export function defaultProject() {
  return {
    format: 'overhead-project', version: PROJECT_VERSION, savedAt: null,
    media: null,                 // {name, size, type, duration, sampleRate, channels, creation:{unix, source}|null, demo?}
    time: { tz: browserTz(), start: '', end: '' },   // window for the recording START, wall time in tz
    region: null,                // {shape:'circle'|'rect', center:[lat,lon], radius_m, bounds:[[s,w],[n,e]]}
    spec: { preset: 'standard', hum: true, impulse: true, colormap: 'magma' },
    defaultCls: 'prop',
    events: [],                  // see app.js newEvent()
    silences: [],                // {id, t0, t1}
    montage: { on: false, cuts: [] },   // edited video: cuts [{t, auto?, score?}] split it into clips
    flights: null,               // {source, attribution, counts, notes, query:{bbox,t0,t1}}
    filter: { prop: true, heli: true, jet: false, unknown: true },
    run: { settings: { grid_m: 200, tempC: 15, topN: 10, offsetTolS: 8, mode: 'robust', terrain: 'auto', adsbWorker: '' }, results: null, selected: null },
  };
}

/** Merge a loaded object onto defaults, dropping unknown keys. Throws on wrong format. */
export function normalizeProject(obj) {
  if (!obj || typeof obj !== 'object' || obj.format !== 'overhead-project') throw new Error('This is not an Overhead project file.');
  if (obj.version > PROJECT_VERSION) throw new Error(`Project version ${obj.version} is newer than this app supports.`);
  const d = defaultProject();
  const out = { ...d };
  for (const k of Object.keys(d)) if (obj[k] !== undefined) out[k] = obj[k];
  out.time = { ...d.time, ...obj.time };
  out.spec = { ...d.spec, ...obj.spec };
  out.filter = { ...d.filter, ...obj.filter };
  out.run = { ...d.run, ...obj.run, settings: { ...d.run.settings, ...obj.run?.settings } };
  out.events = Array.isArray(obj.events) ? obj.events : [];
  out.silences = Array.isArray(obj.silences) ? obj.silences : [];
  out.montage = { ...d.montage, ...obj.montage, cuts: Array.isArray(obj.montage?.cuts) ? obj.montage.cuts : [] };
  return out;
}

export function serialize(project) {
  return JSON.stringify({ ...project, savedAt: new Date().toISOString() });
}

export function saveDraft(project) {
  try { localStorage.setItem(DRAFT_KEY, serialize(project)); return true; }
  catch { return false; }       // private mode, quota, blocked storage: autosave is best-effort
}
export function loadDraft() {
  try { const s = localStorage.getItem(DRAFT_KEY); return s ? normalizeProject(JSON.parse(s)) : null; }
  catch { return null; }
}
export function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } }
