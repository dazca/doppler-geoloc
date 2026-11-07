// Doppler app shell (UI v3): drop a file -> automatic decode, spectrogram, pass detection, time & area -> one
// "Locate" press (fetch flights + search) -> verdict and map. Every automatic decision stays editable.
// Talks to the engine only through ./engine.js (contract: web/engine/geoloc-api.md). All strings: ./i18n.js.
import * as Engine from './engine.js';
import { createSpecPanel, stftOptions, ridgeOptions, budgetHop, PRESETS, DECODE_RATE } from './spec-panel.js';
import { createMapPanel, makeRegion, regionBBox, regionAreaKm2, regionPolygon, CAT_COLORS } from './map-panel.js';
import { decodeAudioFile, readMediaMeta, readAudioTrack } from '../engine/audio.js';
import * as T from './time-utils.js';
import * as X from './export.js';
import * as Store from './store.js';
import { cacheKey, putTracks, getTracks } from './track-cache.js';
import { scenarioDem, scenarioFromSource } from './scenario-dem.js';
import { createLivePanel, micUnavailableReason, LIVE_T_TOL_S } from './live-panel.js';
import { devFixtureFlights } from './dev-fixtures.js';
import { coverage, coverageVerdict, coverageBaseline, fetchDayStatus } from '../engine/adsb.js';
import { dateGate, fetchManifest, mergeManifest } from './coverage-gate.js';
import { createDem } from '../engine/dem.js';
import { detectCuts } from './segment.js';
import { detectPasses } from './autodetect.js';
import { PLACES, findPlace, nearestPlace } from './places.js';
import { t, lang, setLang, applyI18n, onLangChange, fmtDateTime, fmtDate } from './i18n.js';

const $ = (id) => document.getElementById(id);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
};
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const EV_COLORS = ['#5fd4ff', '#b6f36b', '#ff9d5c', '#ff7ad9', '#ffe066', '#c9b6ff', '#7cf2c8'];
const CLASSES = ['prop', 'heli', 'jet', 'unknown'];
const DEMO = { audio: new URL('demo/scenario1/audio.m4a', location.href), marks: new URL('demo/scenario1/events_measured.json', location.href),
  tStart: 1717243200, tz: 'America/New_York', center: [40.812, -72.87], radius: 12000 };
const CFG = globalThis.OVERHEAD_CONFIG || {};
const QS = new URLSearchParams(location.search);
const DATA_TZ = 'Europe/Madrid';
const MAX_R = CFG.maxRadius_m || 30000;

// ------------------------------------------------------------------ state
let P = Store.defaultProject();           // persisted project
P.time.tz = DATA_TZ;
const R = {                               // runtime only
  file: null, objUrl: null, samples: null, tracks: [], fetchAbort: null, runAbort: null, detectAbort: null,
  selEvent: null, mode: 'mark', sim: null, baseLevels: null, undo: null, decoding: false, detecting: false, editing: null,
};

/** Errors of a previous fetch/run are runtime-only; any new file, project or 'start over' must not inherit them. */
function clearRunErrors() { R.fetchError = null; R.demError = null; }

// ------------------------------------------------------------------ toast, banner, help popovers
let toastTimer = 0;
function toast(msg, { error = false, action = null, ms = 3200 } = {}) {
  const el = $('toast');
  el.replaceChildren(msg);
  if (action) {
    el.append(' ', h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => { el.classList.remove('is-on'); action.fn(); } }, action.label));
    el.style.pointerEvents = 'auto';
  } else el.style.pointerEvents = 'none';
  el.classList.toggle('toast--error', error);
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), action ? ms * 2 : ms);
}
function banner(nodes) {
  const el = $('banner');
  R.draftBanner = false;
  if (!nodes) { el.hidden = true; el.replaceChildren(); return; }
  el.replaceChildren(h('span', { class: 'banner-text' }, ...[nodes].flat()), h('button', { type: 'button', class: 'btn btn--icon btn--sm banner-x', 'aria-label': t('dismiss'), title: t('dismiss'), onclick: () => banner(null) }, '×'));
  el.hidden = false;
  return true;
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e?.name !== 'AbortError') toast(e?.message || String(e), { error: true, ms: 6000 }); } };

/** Place a popover next to its invoker (no CSS anchor positioning needed). */
function anchorPopover(pop, btn, align = 'start') {
  pop.addEventListener('toggle', (e) => {
    if (e.newState !== 'open') return;
    const r = btn.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const pw = Math.min(pop.offsetWidth, vw - 16), ph = pop.offsetHeight;
    let x = align === 'end' ? r.right - pw : r.left - 8;
    x = Math.max(8, Math.min(x, vw - pw - 8));
    let y = r.bottom + 6;
    if (y + ph > vh - 8 && r.top - ph - 6 > 8) y = r.top - ph - 6;
    pop.style.left = `${Math.round(x)}px`; pop.style.top = `${Math.round(y)}px`;
  });
}
/** Turn every [data-help=key] into a focusable (?) button with a popover; text from i18n "help.<key>". */
function mountHelp() {
  for (const host of document.querySelectorAll('[data-help]')) {
    const key = host.dataset.help, id = `help-${key}`;
    let btn = host.querySelector(':scope > .help-btn'), pop = document.getElementById(id);
    if (!btn) {
      pop = h('div', { id, class: 'help-pop', popover: 'auto', role: 'tooltip' });
      btn = h('button', { type: 'button', class: 'help-btn', popovertarget: id, 'aria-describedby': id }, '?');
      host.append(btn); document.body.append(pop);
      anchorPopover(pop, btn);
    }
    btn.setAttribute('aria-label', t('help.label', { topic: t(`help.${key}.topic`) }));
    btn.title = t('help.label', { topic: t(`help.${key}.topic`) });
    pop.textContent = t(`help.${key}`, covDates());
  }
}

// ------------------------------------------------------------------ panels
const spec = createSpecPanel($('spec-host'), {
  onPick: ({ t: tt, f, event }) => { if (R.mode === 'mark') pickAt(tt, f, !!event?.altKey); else if (R.mode === 'cut') addCut(tt); },
  onBox: ({ t0, t1 }) => { if (R.mode === 'silence') addSilence(t0, t1); },
  onView: () => { if (P.events.length) { clearTimeout(R.ovT); R.ovT = setTimeout(drawOverlays, 30); } },
  onHover: ({ t: tt, f, db }) => { $('spec-readout').textContent = `${T.fmtAudio(tt)} · ${f.toFixed(0)} Hz${Number.isFinite(db) ? ` · ${db.toFixed(0)} dB` : ''}`; },
});
const mapPanel = createMapPanel($('map'), {
  onRegionChange: (r) => { P.region = { ...r, auto: false }; R.gateAck = false; commit(); renderRegion(false); try { live.refresh(); } catch { /* not ready */ } },
  onCandidateSelect: (i) => selectCandidate(i, { fromMap: true }),
  onMapClick: (ll) => {
    if (P.run.results && !R.runAbort) return;                       // after a result, clicks inspect rather than move
    const rad = P.region?.radius_m || CFG.defaultRegion?.radius_m || 10000;
    setRegion({ ...makeRegion(live?.active ? 'circle' : currentShape(), ll, live?.active ? 6000 : rad), auto: false }, false);
    live?.refresh();
  },
});
let COV = CFG.coverage;   // replaced at boot by the data server's availability manifest (coverage-gate.js)
if (COV?.bbox) { mapPanel.setCoverage(COV.bbox); mapPanel.map.fitBounds([[COV.bbox[0], COV.bbox[1]], [COV.bbox[2], COV.bbox[3]]]); }
else mapPanel.map.setView([41.6, 1.6], 7);

function freshProject() {
  const d = Store.defaultProject();
  d.time.tz = DATA_TZ;
  d.run.settings.adsbWorker = P?.run?.settings?.adsbWorker || '';
  return d;
}

// ------------------------------------------------------------------ persistence
let saveTimer = 0;
function commit() {
  if (P.run.results && !R.runAbort && R.editsAfterRun) R.stale = true;
  R.editsAfterRun = false;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => Store.saveDraft(P), 600);
  renderFlow();
}

// ------------------------------------------------------------------ helpers
const soundSpeed = () => 331.3 * Math.sqrt(1 + (P.run.settings.tempC ?? 15) / 273.15);
const isGroundOps = (ev) => ev.fit?.flyover && ev.fit.flyover.ok === false;
const searchable = (ev) => !ev.off && (!isGroundOps(ev) || ev.useGround);
const validEvents = () => P.events.filter((e) => searchable(e) && Number.isFinite(e.t_cpa_audio) && Number.isFinite(e.F0) &&
  e.v_mps.every(Number.isFinite) && e.cpa_m.every(Number.isFinite) && e.v_mps[0] <= e.v_mps[1] && e.cpa_m[0] <= e.cpa_m[1]);
const sortedEvents = () => P.events.slice().sort((a, b) => (a.t_cpa_audio ?? a.seeds[0].t) - (b.t_cpa_audio ?? b.seeds[0].t));
const evLabel = (ev) => String.fromCharCode(65 + sortedEvents().indexOf(ev));
const montageOn = () => !!P.montage?.on;
function clipSpans() {
  const dur = P.media?.duration || 0, cuts = (P.montage?.cuts || []).map((c) => c.t).filter((x) => x > 0 && x < dur).sort((a, b) => a - b);
  const edges = [0, ...cuts, dur];
  return edges.slice(0, -1).map((t0, i) => ({ id: `clip${i + 1}`, n: i + 1, t0, t1: edges[i + 1] }));
}
function clipOf(x) { const sp = clipSpans(); return sp.find((c) => x >= c.t0 && x < c.t1) || sp[sp.length - 1] || null; }
const evTime = (ev) => ev.t_cpa_audio ?? ev.seeds[0].t;
function timeWindow() {
  const L = P.media?.live;
  if (L && Number.isFinite(L.tStartUnix)) return { t0: L.tStartUnix - (L.tolS ?? LIVE_T_TOL_S), t1: L.tStartUnix + (L.tolS ?? LIVE_T_TOL_S) };
  const t0 = T.localToUnix(P.time.start, P.time.tz), t1 = T.localToUnix(P.time.end, P.time.tz);
  return t0 != null && t1 != null && t1 > t0 ? { t0, t1 } : null;
}
function tzValid(tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }
const fmtLat = (x) => x.toFixed(5), fmtLon = (x) => x.toFixed(5);
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(t('copied', { text })); }
  catch { toast(t('copy.blocked', { text }), { ms: 8000 }); }
}
const isDemo = () => !!P.media?.demo;

// ------------------------------------------------------------------ data coverage gate (Catalonia + Andorra, since COV.from)
const inBox = ([lat, lon], b) => lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];
const covFrom = () => (COV?.from ? Date.parse(`${COV.from}T00:00:00Z`) / 1000 : null);
const covDates = () => ({ from: COV?.from ? fmtDate(covFrom()) : '—', to: COV?.to ? fmtDate(Date.parse(`${COV.to}T00:00:00Z`) / 1000) : '—' });
/** null when flight data can exist for the chosen area and time; else an i18n key explaining why not. */
function dataGate() {
  if (isDemo() || QS.has('nogate') || !COV) return null;
  if (P.region && COV.bbox && !inBox(P.region.center, COV.bbox)) return 'gate.area';
  // the search reads every UTC day the recording can touch: [start window, + duration]; live recordings bring their tracks
  return dateGate(timeWindow(), COV, { dur: P.media?.duration || 0, live: !!P.media?.live });
}

// ------------------------------------------------------------------ media
async function loadMedia(file, { demo = null, keepProject = false, forceRange = false, live = null } = {}) {
  if (R.decoding) return;
  if (R.draftBanner) banner(null);   // "reopen <file> to see the draft": the user just did (or chose another file)
  const same = P.media && P.media.name === file.name && P.media.size === file.size;
  const fromDemo = !!P.media?.demo && !demo;   // the demo's Long Island area/time must not leak into the user's own file
  if (!keepProject && !same && (P.events.length || P.silences.length || P.run.results || fromDemo)) {
    R.undo = structuredClone(P);
    const keep = fromDemo ? { spec: P.spec, defaultCls: P.defaultCls, filter: P.filter, run: { ...P.run, results: null, selected: null } }
      : { region: P.region, spec: P.spec, defaultCls: P.defaultCls, filter: P.filter, run: { ...P.run, results: null, selected: null } };
    P = { ...freshProject(), ...keep };
    R.sim = null; R.selEvent = null; R.tracks = []; clearRunErrors();
    renderAll();
  }
  R.decoding = true;
  try {
    busy(t('busy.read', { name: file.name }), null);
    const meta = await readMediaMeta(file).catch(() => null);
    let track = null;
    if (meta?.container === 'isobmff') track = await readAudioTrack(file).catch(() => null);
    // never trust mvhd alone: the sample table says how much audio a decode would really produce
    const trackDur = track?.n ? Math.max(track.duration,
      (track.dts[track.n - 1] - track.mediaTime) / track.timescale + track.delay + 1024 / track.sampleRate) : 0;
    const estDur = Math.max(meta?.durationSec || 0, trackDur) || await probeDuration(file);
    let crop = (same || keepProject) && P.media?.crop ? P.media.crop : null;
    // streamable = decodeAudioFile can stream it: an MP4/MOV only if its moov has an AAC sample table we can read
    // (LPCM / other codecs / fragmented MP4 are decoded whole, which the memory estimate must know)
    const streamable = meta?.container === 'isobmff' ? !!track : /\.wav$/i.test(file.name || '');
    track = null;                        // the sample table can be large; decodeAudioFile parses its own copy
    if (forceRange || (!crop && isLarge(file, estDur, streamable))) {
      busy(null);
      const choice = await askLargeFile(file, estDur, crop, streamable);
      if (!choice) { renderMedia(); return; }
      crop = choice.crop;
    }
    // only now (the large-file dialog was confirmed, or not needed) stop the previous recording's running work
    R.runAbort?.abort(); R.detectAbort?.abort();
    releaseMedia();                      // B4: the previous recording's buffers go before the new decode starts
    busy(t('busy.decode'), null);
    const t0 = performance.now();
    let dec;
    try {
      dec = await decodeAudioFile(file, { sampleRate: DECODE_RATE, readMeta: false, crop, onProgress: (p) => busy(t('busy.decode'), p),
        ...(QS.has('stream') ? { streamBytes: 0 } : {}) });
    } catch (e) {
      // the previous recording is already released: show the empty state rather than its stale name/duration
      // keep the media record (name, crop, duration) when the project's events still refer to it: reattach state
      R.file = null; if (!keepProject && !same) P.media = null; resetSpecUi();
      throw new Error(audioErrorText(e, file) || e?.message || String(e));
    }
    const decodeMs = performance.now() - t0;
    R.file = file;
    crop = dec.crop;
    R.samples = dec.samples;
    R.objUrl = URL.createObjectURL(file);
    spec.setSource(R.objUrl);
    P.media = { name: file.name, size: file.size, type: file.type || '', duration: dec.duration, sampleRate: dec.sampleRate,
      channels: dec.channels, creation: live ? { unix: live.tStartUnix, source: 'live' } : meta?.best || null,
      containerDuration: meta?.durationSec ?? null, demo, decodeMs, crop, live, decodePath: dec.path };
    if (!P.time.start && P.media.creation && !live) setTimeFromCreation();
    if (!P.region && !demo) applyDefaultRegion();
    renderAll();
    try { await computeSpec(); } catch (e) { if (e instanceof RangeError) throw new Error(t('audio.err.toolarge', { name: file.name, size: fmtBytes(file.size) })); throw e; }
    if (R.undo) toast(t('toast.newfile'), { action: { label: t('undo'), fn: undo } });
  } finally { R.decoding = false; busy(null); renderMedia(); renderFlow(); }
  if ($('opt-autodetect').checked && !P.events.length) await guard(autoDetect)();
}

/** B4: drop every per-recording buffer (samples, scoring spectrogram, worker copies, engine pool, object URL). */
function releaseMedia() {
  R.samples = null; R.refSpec = null;
  spec.setSource(null); spec.clear();
  if (R.objUrl) { URL.revokeObjectURL(R.objUrl); R.objUrl = null; }
  Engine.releaseEngine?.();
}
function resetSpecUi() {
  $('spec-status').textContent = '';
  for (const id of ['btn-play', 'scrub', 'btn-recompute']) $(id).disabled = true;
}
/** Translated text for decodeAudioFile's coded errors (B1), or null. */
function audioErrorText(e, file) {
  const v = { name: file.name, size: fmtBytes(file.size) };
  if (e?.code === 'too-large' || e instanceof RangeError) return t('audio.err.toolarge', v);
  if (e?.code === 'undecodable') return t('audio.err.undecodable', v);
  if (e?.code === 'bad-range') return t('audio.err.badrange', v);
  return null;
}

function applyDefaultRegion() {
  const d = CFG.defaultRegion;
  if (!d) return;
  P.region = { ...makeRegion('circle', d.center, d.radius_m), auto: true };
  mapPanel.setRegion(P.region, { fit: true });
}

// ------------------------------------------------------------------ large files
// B6: offer a range when the estimated peak memory exceeds a quarter of the device memory (navigator.deviceMemory,
// 2 GB when the browser does not say). ?largeMB= / ?largeMin= force the old size/duration thresholds (tests).
const LARGE_BYTES = (+QS.get('largeMB') || 1024) * 1e6, LARGE_S = (+QS.get('largeMin') || 60) * 60;
const memBudget = () => (navigator.deviceMemory ?? 2) * 1e9 * 0.25;
const isLarge = (file, dur, streamable) => (QS.has('largeMB') || QS.has('largeMin') ? file.size > LARGE_BYTES || (dur || 0) > LARGE_S
  : estimateMemory(dur || 0, null, { streamable, size: file.size }) > memBudget());
function probeDuration(file) {
  return new Promise((resolve) => {
    const a = document.createElement('audio'), url = URL.createObjectURL(file);
    let tm = 0;
    const done = (d) => { clearTimeout(tm); a.onloadedmetadata = a.onerror = null; a.removeAttribute('src'); URL.revokeObjectURL(url); resolve(Number.isFinite(d) && d > 0 ? d : null); };
    tm = setTimeout(() => done(null), 4000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(null);
    a.src = url;
  });
}
/** Peak memory (bytes) to analyse [crop] of a recording of `dur` s: decode + samples + display and scoring spectrograms. */
function estimateMemory(dur, crop = null, { streamable = true, size = 0 } = {}) {
  const kept = crop ? Math.max(0, Math.min(dur || crop[1], crop[1]) - crop[0]) : dur;
  const decode = streamable ? 16e6 : size + dur * 48000 * 2 * 4;   // streaming keeps only blocks; else file + decoded PCM
  const p = PRESETS[P.spec.preset] || PRESETS.standard, nF = Math.floor(2000 * p.nfft / DECODE_RATE) - Math.ceil(30 * p.nfft / DECODE_RATE) + 1;
  const display = (kept * DECODE_RATE / budgetHop(p, kept)) * nF * 4 * 2;       // main thread + track worker
  const scoring = (kept * DECODE_RATE / 1024) * 513 * 4 * 3;                      // raw + whitened + worker copy
  return decode + kept * DECODE_RATE * 4 * 2 + display + scoring;
}
const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const { parseClock } = T;
function askLargeFile(file, dur, crop, streamable) {
  return new Promise((resolve) => {
    const box = $('large-panel');
    const from = h('input', { id: 'crop-from', value: T.fmtAudio(crop?.[0] ?? 0, 0), 'aria-label': t('large.from'), spellcheck: 'false' });
    const to = h('input', { id: 'crop-to', value: T.fmtAudio(crop?.[1] ?? Math.min(dur || 1800, 1800), 0), 'aria-label': t('large.to'), spellcheck: 'false' });
    const est = h('p', { class: 'meta-line', 'aria-live': 'polite' });
    const durTxt = dur ? T.fmtAudio(dur, 0) : '';
    const upd = () => {
      const a = parseClock(from.value), b = parseClock(to.value), err = T.cropRangeError(a, b, dur);
      est.textContent = err ? t(err, { d: durTxt }) : `${T.fmtDuration(Math.min(b, dur || b) - a)} · ~${fmtBytes(estimateMemory(dur || b, [a, b], { streamable, size: file.size }))}`;
      est.classList.toggle('is-error', !!err);
      return err;
    };
    from.addEventListener('input', upd); to.addEventListener('input', upd);
    const finish = (v) => { box.hidden = true; box.replaceChildren(); resolve(v); };
    box.setAttribute('aria-label', t('large.h'));
    box.replaceChildren(
      h('p', { class: 'large-title' }, h('strong', {}, t('large.h')), ` · ${fmtBytes(file.size)}${dur ? ` · ${T.fmtDuration(dur)}` : ''}`),
      h('p', { class: 'hint' }, t('large.hint')),
      h('div', { class: 'field-row' }, h('label', { class: 'field' }, h('span', {}, t('large.from')), from), h('label', { class: 'field' }, h('span', {}, t('large.to')), to)),
      est,
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn--primary', id: 'btn-crop', onclick: () => {
          const a = parseClock(from.value), b = parseClock(to.value), err = upd();
          from.toggleAttribute('aria-invalid', err === 'large.past' || err === 'large.bad');
          to.toggleAttribute('aria-invalid', !!err);
          if (err) { (err === 'large.past' ? from : to).focus(); return; }
          finish({ crop: [a, dur ? Math.min(b, dur) : b] });
        } }, t('large.range')),
        h('button', { type: 'button', class: 'btn', id: 'btn-crop-all', onclick: () => finish({ crop: null }) }, t('large.all')),
        h('button', { type: 'button', class: 'btn btn--quiet', onclick: () => finish(null) }, t('cancel'))));
    upd();
    box.hidden = false;
    from.focus();
  });
}

async function computeSpec({ keepView = false } = {}) {
  if (!R.samples) return;
  const opts = stftOptions(P.spec, R.samples.length / DECODE_RATE);
  const prevView = keepView ? spec.view.getView() : null;
  busy(t('busy.spec'), 0);
  try {
    const s = await spec.compute(R.samples, opts, (p) => busy(t('busy.spec'), p), { tOffset: P.media.crop?.[0] || 0 });
    if (prevView) spec.view.setView(prevView); else defaultFreqView();
    spec.view.setColormap(P.spec.colormap);
    R.baseLevels = spec.view.getLevels();
    applyContrast();
    $('spec-status').textContent = `${P.media.crop ? `${T.fmtAudio(P.media.crop[0], 0)}–${T.fmtAudio(P.media.crop[1], 0)} / ` : ''}${T.fmtDuration(P.media.duration)} · ${s.df.toFixed(1)} Hz × ${(s.dt * 1000).toFixed(0)} ms`;
    $('spec-empty').hidden = true;
    for (const id of ['btn-play', 'scrub', 'btn-recompute']) $(id).disabled = false;
    $('scrub').max = String(P.media.duration);
    drawOverlays(); drawBands();
  } finally { busy(null); }
}

function busy(text, frac) {
  const el = $('spec-busy');
  if (text == null) { el.hidden = true; return; }
  el.hidden = false;
  $('spec-busy-text').textContent = text;
  const pr = el.querySelector('progress');
  if (!Number.isFinite(frac)) pr.removeAttribute('value'); else pr.value = Math.min(1, Math.max(0, frac));
}
function applyContrast() {
  if (!R.baseLevels) return;
  const k = +$('contrast').value, [lo, hi] = R.baseLevels;
  spec.view.setLevels(lo, lo + (hi - lo) / k);
}

async function fetchDemoFile() {
  const r = await fetch(DEMO.audio);
  if (!r.ok) throw new Error(t('demo.missing'));
  return new File([await r.blob()], 'demo_scenario1.m4a', { type: 'audio/mp4' });
}
async function loadDemo() {
  if (R.decoding) return;
  if (P.events.length || P.media) R.undo = structuredClone(P);
  P = freshProject();
  P.time = { tz: DEMO.tz, start: T.unixToLocalInput(DEMO.tStart - 2 * 3600, DEMO.tz), end: T.unixToLocalInput(DEMO.tStart + 2 * 3600, DEMO.tz),
    at: T.unixToLocalInput(DEMO.tStart, DEMO.tz), margin: '2', auto: true };
  P.region = makeRegion('rect', DEMO.center, DEMO.radius);
  R.tracks = []; R.sim = null; R.selEvent = null; clearRunErrors();
  renderAll();
  mapPanel.setRegion(P.region, { fit: true });
  busy(t('busy.demo'), null);
  const file = await fetchDemoFile();
  await loadMedia(file, { demo: 'scenario1', keepProject: true });
  if (!validEvents().length) await markDemo();          // detector unavailable or found nothing: use the measured passes
  R.selEvent = null; renderEvents(); drawOverlays();
  banner([h('strong', {}, t('demo.h')), ' ', t('demo.text')]);
  if (R.undo) toast(t('toast.demo'), { action: { label: t('undo'), fn: undo } });
  await locate();
}
async function markDemo() {
  const marks = await (await fetch(DEMO.marks)).json();
  for (const m of marks) {
    if (P.events.some((e) => Math.abs(evTime(e) - m.t_cpa_audio) < 30)) continue;
    await markAt(m.t_cpa_audio, m.F0, false, { quiet: true });
    const ev = P.events.find((e) => e.id === R.selEvent);
    if (ev?.status === 'ok') { ev.v_mps = [...m.v_mps]; ev.cpa_m = [...m.cpa_m]; ev.edited = true; }
  }
  renderEvents(); commit();
}

function undo() {
  if (!R.undo) return;
  P = R.undo; R.undo = null; R.sim = null;
  renderAll(); mapPanel.setRegion(P.region, { fit: !!P.region }); commit(); restoreTracks();
  toast(t('toast.restored'));
}

// ------------------------------------------------------------------ events
function newEvent(seed) {
  const used = new Set(P.events.map((e) => e.color));
  return { id: 'e' + Math.random().toString(36).slice(2, 8), cls: P.defaultCls, harmonic: 1, seeds: [seed], ridge: null, fit: null,
    t_cpa_audio: null, F0: null, v_mps: [null, null], cpa_m: [null, null], edited: false, status: 'tracking', error: null,
    color: EV_COLORS.find((c) => !used.has(c)) || EV_COLORS[P.events.length % EV_COLORS.length] };
}

/** Spectrogram click: select the pass under the pointer (turning a suggestion on), else add a new pass there. */
function pickAt(tt, f, extend) {
  if (!extend) {
    const hit = sortedEvents().find((ev) => (ev.ridge || []).some(([rt, rf]) => Math.abs(rt - tt) < 1.5 &&
      [1, 2, 3, 4].some((m) => Math.abs(rf * m - f) < Math.max(4, f * 0.03))));
    if (hit) {
      if (hit.off) { hit.off = false; R.editsAfterRun = true; toast(t('toast.passon', { l: evLabel(hit) })); commit(); drawOverlays(); }
      selectEvent(hit.id); return;
    }
  }
  guard(markAt)(tt, f, extend);
}

async function markAt(tt, f, extend = false, { quiet = false } = {}) {
  if (!spec.spec) { toast(t('toast.loadfirst')); return; }
  let ev = extend ? P.events.find((e) => e.id === R.selEvent) : null;
  R.editsAfterRun = true;
  if (ev) ev.seeds.push({ t: tt, f });
  else { ev = newEvent({ t: tt, f }); P.events.push(ev); }
  R.selEvent = ev.id;
  renderEvents();
  await trackEvent(ev);
  if (!quiet && ev.status === 'ok') toast(t('toast.passadded', { l: evLabel(ev) }));
}

async function trackEvent(ev) {
  ev.status = 'tracking'; ev.error = null; renderEvents();
  try {
    const n = ev.harmonic || 1, frames = new Map(), dt = spec.spec.dt;
    for (const s of ev.seeds) {
      const r = await spec.ridge({ t: s.t, f: s.f }, ridgeOptions(P.spec, ev.cls, n, s.f));
      for (const p of r.points) {
        const k = Math.round(p.t / dt), cur = frames.get(k);
        frames.set(k, cur ? [p.t, (cur[1] * cur[2] + p.f / n) / (cur[2] + 1), cur[2] + 1] : [p.t, p.f / n, 1]);
      }
    }
    const pts = [...frames.values()].sort((a, b) => a[0] - b[0]).map(([x, f]) => [+x.toFixed(3), +f.toFixed(3)]);
    if (pts.length < 8) throw new Error(t('ev.nocurve'));
    ev.ridge = pts;
    const fit = await Engine.fitEvent(pts, { c: soundSpeed(), cls: ev.cls });
    ev.fit = { ...fit, curve: fit.curve?.map(([x, f]) => [+x.toFixed(2), +f.toFixed(3)]) };
    if (!ev.edited) Object.assign(ev, { t_cpa_audio: fit.t_cpa_audio, F0: fit.F0, v_mps: [...fit.v_mps], cpa_m: [...fit.cpa_m] });
    ev.status = 'ok';
  } catch (e) {
    ev.status = 'error'; ev.error = e?.message || String(e);
    if (!ev.ridge) ev.t_cpa_audio ??= ev.seeds[0].t;
  }
  renderEvents(); drawOverlays(); commit();
}

/** Automatic pass detection (docs/AUTODETECT.md). Confident passes are on; suggestions are dimmed and off. */
async function autoDetect() {
  if (!spec.spec || R.detecting) return;
  R.detecting = true; renderEvents();
  const ac = R.detectAbort = new AbortController();
  try {
    const found = await detectPasses(spec.spec, { cls: P.defaultCls, c: soundSpeed(), impulse: !!P.spec.impulse,
      exclude: P.events.filter((e) => Number.isFinite(e.t_cpa_audio)).map((e) => ({ t_cpa_audio: e.t_cpa_audio })) },
    { signal: ac.signal, onProgress: (p) => { R.detectFrac = p?.frac; }, run: spec.detect });
    for (const d of found || []) {
      if (!d?.fit || !d.points?.length) continue;
      const ev = newEvent(d.seed);
      Object.assign(ev, { harmonic: d.harmonic || 1, ridge: d.points, fit: { ...d.fit, flyover: d.flyover ?? d.fit.flyover,
        curve: d.fit.curve?.map(([x, f]) => [+x.toFixed(2), +f.toFixed(3)]) },
      t_cpa_audio: d.fit.t_cpa_audio, F0: d.fit.F0, v_mps: [...d.fit.v_mps], cpa_m: [...d.fit.cpa_m], status: 'ok',
      auto: true, score: d.score, label: d.label, reasons: d.reasons || [], off: d.label !== 'confident' });
      P.events.push(ev);
    }
    P.detected = { at: Date.now(), n: (found || []).length };
    const on = P.events.filter((e) => e.auto && !e.off).length, sug = P.events.filter((e) => e.auto && e.off).length;
    if (found?.length) toast(t('toast.detected', { n: on, s: sug }));
  } finally {
    R.detecting = false; R.detectAbort = null;
    renderEvents(); drawOverlays(); commit();
  }
}

function deleteEvent(id) {
  const i = P.events.findIndex((e) => e.id === id);
  if (i < 0) return;
  const [ev] = P.events.splice(i, 1);
  R.editsAfterRun = true;
  if (R.selEvent === id) R.selEvent = null;
  renderEvents(); drawOverlays(); commit();
  toast(t('toast.deleted'), { action: { label: t('undo'), fn: () => { P.events.splice(i, 0, ev); renderEvents(); drawOverlays(); commit(); } } });
}
function toggleEvent(ev) { R.editsAfterRun = true; ev.off = !ev.off; renderEvents(); drawOverlays(); commit(); }

function selectEvent(id, { zoom = false } = {}) {
  R.selEvent = R.selEvent === id && !zoom ? null : id;
  renderEvents(); drawOverlays();
  const ev = P.events.find((e) => e.id === id);
  if (zoom && ev && spec.spec) {
    const tc = evTime(ev), f = (ev.F0 ?? ev.seeds[0].f) * (ev.harmonic || 1);
    spec.zoomTo(tc - 60, tc + 60, Math.max(30, f * 0.55), f * 2.6);
  }
}

function addSilence(t0, t1) {
  if (t1 - t0 < 0.5) return;
  P.silences.push({ id: 's' + Math.random().toString(36).slice(2, 8), t0: +t0.toFixed(2), t1: +t1.toFixed(2) });
  P.silences.sort((a, b) => a.t0 - b.t0);
  const merged = [];
  for (const s of P.silences) {
    const last = merged[merged.length - 1];
    if (last && s.t0 <= last.t1) last.t1 = Math.max(last.t1, s.t1); else merged.push({ ...s });
  }
  P.silences = merged;
  renderSilences(); drawBands(); commit();
}

function addCut(x, extra = {}) {
  if (!P.media) return;
  P.montage ||= { on: true, cuts: [] };
  if (P.montage.cuts.some((c) => Math.abs(c.t - x) < 1)) return;
  P.montage.cuts.push({ t: +x.toFixed(2), ...extra });
  P.montage.cuts.sort((a, b) => a.t - b.t);
  renderMontage(); renderEvents(); drawOverlays(); commit();
}
function renderMontage() {
  const on = montageOn();
  $('opt-montage').checked = on;
  $('montage-panel').hidden = !on;
  $('opt-chrono').checked = !!P.montage?.chrono;
  document.querySelector('[data-mode=cut]').hidden = !on;
  if (!on && R.mode === 'cut') setMode('mark');
  const cuts = P.montage?.cuts || [];
  $('cut-list').replaceChildren(...cuts.map((c, i) => h('li', { class: `chip-item${c.auto && c.score < 12 ? ' is-weak' : ''}` },
    `${t('cut')} ${T.fmtAudio(c.t)}${c.auto && c.score < 12 ? ' ?' : ''}`,
    h('button', { type: 'button', 'aria-label': t('cut.remove', { at: T.fmtAudio(c.t) }), onclick: () => { P.montage.cuts.splice(i, 1); renderMontage(); renderEvents(); drawOverlays(); commit(); } }, '×'))));
  const spans = clipSpans();
  $('clip-summary').textContent = on && cuts.length ? spans.map((c) => `${c.n}: ${T.fmtAudio(c.t0, 0)}–${T.fmtAudio(c.t1, 0)}`).join(' · ') : '';
}
async function detectAndAddCuts() {
  if (!R.samples) { toast(t('toast.loadfirst')); return; }
  const btn = $('btn-detect-cuts'); btn.disabled = true;
  await new Promise((r) => setTimeout(r, 30));
  try {
    const found = detectCuts(R.samples, DECODE_RATE, { tOffset: P.media.crop?.[0] || 0 });
    P.montage.cuts = (P.montage.cuts || []).filter((c) => !c.auto);
    for (const c of found) if (!P.montage.cuts.some((x) => Math.abs(x.t - c.t) < 1)) P.montage.cuts.push({ t: c.t, auto: true, score: c.score });
    P.montage.cuts.sort((a, b) => a.t - b.t);
    renderMontage(); renderEvents(); drawOverlays(); commit();
    toast(t('toast.cuts', { n: found.length }));
  } finally { btn.disabled = false; }
}

function drawBands() {
  spec.setBands(P.silences.map((x) => ({ t0: x.t0, t1: x.t1, fill: 'rgba(141,180,255,0.16)', stroke: 'rgba(141,180,255,0.7)', label: t('silence') })));
}

function drawOverlays() {
  const ov = new Map();
  if (!spec.spec) { spec.setLines(ov); return; }
  const ext = spec.view.getView();
  for (const ev of sortedEvents()) {
    const sel = ev.id === R.selEvent, n = ev.harmonic || 1, lab = evLabel(ev), dim = ev.off;
    const col = dim ? '#9aa3b2' : ev.color;
    if (ev.fit?.curve && !dim) for (const m of sel ? [1, 2, 3, 4] : [n]) {
      ov.set(`fit-${ev.id}-${m}`, { points: ev.fit.curve.map(([x, f]) => [x, f * m]), color: col + (sel ? 'aa' : '66'), width: 1, dash: [5, 4] });
    }
    if (ev.ridge) ov.set(`ridge-${ev.id}`, { points: ev.ridge.map(([x, f]) => [x, f * n]), color: col + (dim ? '88' : ''), width: sel ? 2.5 : dim ? 1 : 1.5, dash: dim ? [3, 3] : undefined });
    if (!ev.auto) for (const [k, x] of ev.seeds.entries()) ov.set(`seed-${ev.id}-${k}`, { points: [[x.t, x.f]], color: col, markers: true, line: false, markerSize: 3.5 });
    if (Number.isFinite(ev.t_cpa_audio)) ov.set(`cpa-${ev.id}`, { points: [[ev.t_cpa_audio, ext.f1 - (ext.f1 - ext.f0) * 0.06], [ev.t_cpa_audio, ext.f0]],
      color: col + (sel ? 'ee' : dim ? '55' : '99'), width: 1, dash: [2, 4], label: `${lab}${dim ? ' ?' : ''}` });
  }
  if (montageOn()) for (const [k, c] of (P.montage.cuts || []).entries()) ov.set(`cut-${k}`, { points: [[c.t, ext.f1 - (ext.f1 - ext.f0) * 0.02], [c.t, ext.f0]],
    color: '#f2b544', width: 1.5, dash: c.auto && c.score < 12 ? [3, 4] : [], label: `${t('clip')} ${k + 2} ▸` });
  for (const [k, c] of (R.sim || []).entries()) {
    ov.set(`sim-${k}`, { points: c.points, color: c.harmonic === 1 ? '#ffffffee' : '#ffffff99', width: c.harmonic === 1 ? 1.75 : 1.25, dash: [7, 4],
      label: c.harmonic === 1 ? c.label : null });
  }
  spec.setLines(ov);
}

function defaultFreqView() {
  if (!spec.spec) return;
  const fund = P.events.filter((e) => !e.off).flatMap((e) => (e.ridge || []).map(([, f]) => f));
  let f0 = 30, f1 = 700;
  if (fund.length) {
    let lo = Infinity, hi = -Infinity;
    for (const f of fund) { if (f < lo) lo = f; if (f > hi) hi = f; }
    f0 = Math.max(30, lo * 0.7); f1 = Math.min(2000, Math.max(f0 + 100, hi * 3.4));
  }
  spec.view.setView({ f0, f1 });
}
async function retrackAuto() {
  const evs = P.events.filter((e) => e.seeds?.length && !e.edited && !e.auto);
  for (const ev of evs) await trackEvent(ev);
}

// ------------------------------------------------------------------ region & time
const currentShape = () => document.querySelector('[data-shape][aria-checked=true]')?.dataset.shape || 'circle';
function setRegion(r, fit = true) {
  if (r && r.radius_m > MAX_R) r = { ...makeRegion(r.shape, r.center, MAX_R), auto: r.auto };
  P.region = r; R.gateAck = false; R.fetchError = null; R.editsAfterRun = true; mapPanel.setRegion(r, { fit }); renderRegion(); commit();
  try { live.refresh(); } catch { /* live panel not created yet */ }
}
const marginHours = (m) => (m === 'day' ? 'day' : +m || 1);
/** Window for the recording start from a wall-clock time and a margin. Creation time may be the start or the end. */
function windowAround(c, margin, { creation = false } = {}) {
  const tz = P.time.tz, dur = P.media?.duration || 0, mh = marginHours(margin);
  if (mh === 'day') {
    const day = T.unixToLocalInput(c, tz).slice(0, 10);
    return [T.localToUnix(`${day}T00:00`, tz), T.localToUnix(`${day}T23:59`, tz)];
  }
  return [c - (creation ? dur : 0) - mh * 3600, c + mh * 3600];
}
function setTime(c, margin, { creation = false, auto = false } = {}) {
  const [t0, t1] = windowAround(c, margin, { creation });
  P.time.start = T.unixToLocalInput(t0, P.time.tz); P.time.end = T.unixToLocalInput(t1, P.time.tz);
  P.time.at = T.unixToLocalInput(c, P.time.tz); P.time.margin = String(margin); P.time.auto = auto; P.time.creation = creation;
  R.gateAck = false; R.editsAfterRun = true; R.fetchError = null;
  renderTime(); renderFlights(); commit();
}
function setTimeFromCreation() { setTime(P.media.creation.unix, '1', { creation: true, auto: true }); }

// ------------------------------------------------------------------ flights
const workerUrl = () => (P.run.settings.adsbWorker || '').trim() || CFG.adsbWorker || '';
function fetchStale() {
  const q = P.flights?.query, w = timeWindow(), bb = regionBBox(P.region);
  if (!R.tracks.length && !(P.flights && P.flights.counts && !Object.values(P.flights.counts).some((n) => n > 0))) return true;
  if (!q || !w || !bb) return true;
  return q.t0 !== w.t0 || q.t1 !== w.t1 || q.bbox.some((x, i) => Math.abs(x - bb[i]) > 1e-6);
}
async function doFetch(progress) {
  const w = timeWindow();
  const ac = R.fetchAbort = new AbortController();
  R.fetchError = null;
  try {
    const bbox = regionBBox(P.region);
    // the demo is a synthetic scenario with bundled tracks: never ask the live data server for it ('' = no proxy, stub data)
    const worker = isDemo() ? '' : (workerUrl() || undefined);
    const q = { bbox, t0: w.t0, t1: w.t1, duration_s: P.media?.duration || 0, worker };
    const res = (!worker && await devFixtureFlights(q, { signal: ac.signal })) || await Engine.fetchFlights(q, {
      signal: ac.signal, onProgress: (p) => progress(t('stage.flights'), p.frac ?? null),
    });
    R.tracks = res.tracks;
    const key = cacheKey(res.source, { bbox, t0: w.t0, t1: w.t1 });
    P.flights = { source: res.source, attribution: res.attribution, counts: res.counts, notes: (res.notes || []).filter((n) => !(isDemo() && /No ADS-B proxy/.test(n))), query: { bbox, t0: w.t0, t1: w.t1 }, at: Date.now(), cacheKey: key };
    putTracks(key, res.tracks);
    P.flights.coverage = /^fixture:scenario|synthetic/i.test(res.source || '') ? null : assessCoverage(res.tracks, { days: res.days || [] });
    R.sim = null; drawOverlays();
    if (worker && P.flights.coverage) refineCoverage(worker, bbox, w, key);
    renderFlights(); commit();
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    console.error('flight fetch failed', e);
    // 'unreachable' only for a real network failure of the data server (engine sets e.code; a bare fetch() rejection is a
    // TypeError with a browser-specific message). Any other error, including TypeErrors from our own code, is shown as is.
    const net = e?.code === 'unreachable' || e?.code === 'network'
      || (e instanceof TypeError && /^(Failed to fetch|NetworkError when attempting to fetch|Load failed|Network request failed)/i.test(e.message || ''));
    R.fetchError = net && workerUrl() ? t('fetch.unreachable') : t('fetch.failed', { msg: e?.message || e });
    renderFlights();
    throw new Error(R.fetchError);
  } finally { R.fetchAbort = null; }
}
const usableTracks = () => R.tracks.filter((x) => P.filter[x.category] !== false);

const COVERAGE_RADIUS_KM = 5;
function coverageWindow() { const w = timeWindow(); return w && { t0: w.t0, t1: w.t1 + (P.media?.duration || 0) }; }
function assessCoverage(tracks, { days = [], baseline = [] } = {}) {
  const win = coverageWindow();
  if (!win || !P.region) return null;
  const cov = coverage(tracks, { ...win, center: P.region.center, radiusKm: COVERAGE_RADIUS_KM, maxAltM: 1500 });
  const v = coverageVerdict(cov, { days, baseline });
  return { level: v.level, messages: v.messages, n_aircraft: cov.n_aircraft, n_tracks: cov.n_tracks, tracks_per_h: cov.tracks_per_h,
    radius_km: COVERAGE_RADIUS_KM, hours: (win.t1 - win.t0) / 3600, days, baselineDays: baseline.length, ack: false };
}
async function refineCoverage(worker, bbox, w, key) {
  const win = coverageWindow();
  const withTimeout = (pr, ms) => Promise.race([pr, new Promise((res) => setTimeout(() => res(null), ms))]);
  try {
    const [days, baseline] = await Promise.all([
      withTimeout(fetchDayStatus({ worker, t0: win.t0, t1: win.t1 }).catch(() => null), 15000),
      withTimeout(coverageBaseline({ worker, bbox, t0: win.t0, t1: win.t1, center: P.region.center, radiusKm: COVERAGE_RADIUS_KM }).catch(() => null), 20000)]);
    if (P.flights?.cacheKey !== key) return;
    const ack = P.flights.coverage?.ack;
    P.flights.coverage = assessCoverage(R.tracks, { days: days || [], baseline: baseline || [] });
    if (P.flights.coverage) P.flights.coverage.ack = ack && P.flights.coverage.level !== 'poor' ? ack : false;
    renderFlights(); commit();
  } catch { /* best-effort */ }
}
function renderCoverage() {
  const box = $('coverage-note'), c = P.flights?.coverage;
  if (!c || !R.tracks.length || c.level === 'ok' || (P.run.results && c.level === 'weak')) { box.hidden = true; return; }
  box.hidden = false;
  box.className = `state-note coverage coverage--${c.level}`;
  const details = h('details', {}, h('summary', {}, t('details')),
    h('p', {}, t('cov.counts', { n: c.n_aircraft, km: c.radius_km, ph: c.tracks_per_h })), h('ul', {}, ...c.messages.map((m) => h('li', {}, m))));
  if (c.level === 'weak') box.replaceChildren(h('strong', {}, t('cov.weak')), details);
  else box.replaceChildren(h('strong', {}, t('cov.poor')), h('span', {}, t('cov.poor.sub')), details,
    c.ack ? null : h('div', { class: 'btn-row btn-row--tight' },
      h('button', { type: 'button', class: 'btn btn--sm', id: 'btn-cov-ack', onclick: guard(async () => { c.ack = true; commit(); await locate(); }) }, t('cov.anyway'))));
}
async function restoreTracks() {
  if (R.tracks.length || !P.flights?.cacheKey) return;
  const key = P.flights.cacheKey;
  const tracks = await getTracks(key);
  if (!tracks || P.flights?.cacheKey !== key || R.tracks.length) return;
  R.tracks = tracks;
  renderFlights();
  if (P.run.results && P.run.selected != null) await selectCandidate(P.run.selected, { fromMap: true });
}

// ------------------------------------------------------------------ locate = fetch (if needed) + search
/** Missing inputs, as short i18n keys (first one is shown under the button). */
function runBlockers() {
  const out = [];
  if (!P.media) out.push('need.file');
  if (R.detecting) out.push('need.detecting');
  else if (!validEvents().length) out.push('need.passes');
  if (!timeWindow()) out.push('need.time');
  if (!P.region) out.push('need.area');
  return out;
}
async function locate() {
  if (R.runAbort) return;
  const b = runBlockers();
  if (b.length) throw new Error(t(b[0]));
  const gate = dataGate();
  if (gate) { renderGate(); throw new Error(t(gate)); }
  const ac = R.runAbort = new AbortController();
  R.stale = false;
  if (P.run.results) { P.run.results = null; P.run.selected = null; R.sim = null; renderResults(); drawOverlays(); }
  $('btn-run').hidden = true; $('btn-cancel').hidden = false;
  const prog = $('run-progress'); prog.hidden = false;
  const progress = (label, frac) => {
    $('run-stage').textContent = label;
    const pr = prog.querySelector('progress');
    if (!Number.isFinite(frac)) pr.removeAttribute('value'); else pr.value = Math.min(1, Math.max(0, frac));
  };
  try {
    if (fetchStale()) {
      progress(t('stage.flights'), null);
      ac.signal.addEventListener('abort', () => R.fetchAbort?.abort(), { once: true });
      await doFetch(progress);
    }
    if (!R.tracks.length) { renderFlights(); return; }
    if (!usableTracks().length) throw new Error(t('need.types'));
    if (P.flights?.coverage?.level === 'poor' && !P.flights.coverage.ack) { renderFlights(); return; }
    await doRun(ac, progress);
  } catch (e) {
    if (e?.name === 'AbortError') toast(t('toast.cancelled'));
    else throw e;
  } finally {
    R.runAbort = null; prog.hidden = true;
    $('btn-run').hidden = false; $('btn-cancel').hidden = true; renderFlow();
  }
}

/** Reference spectrogram (and its whitened copy) for scoring, computed once per recording in the DSP worker (B11). */
async function scoringSpectrogram() {
  if (!Engine.referenceSpectrogram || !R.samples) return { spec: spec.spec, whitened: null };
  if (R.refSpec?.samples !== R.samples) {
    const samples = R.samples;
    let z, w = null;
    try { ({ spec: z, whitened: w } = await spec.reference(samples, DECODE_RATE)); }
    catch (e) { if (e?.name === 'AbortError') throw e; z = await Engine.referenceSpectrogram(samples, DECODE_RATE); }
    if (samples !== R.samples) throw new DOMException('Recording changed', 'AbortError');
    const off = P.media?.crop?.[0] || 0;
    if (off) { z.t0 += off; if (w) w.t0 += off; }
    R.refSpec = { samples, spec: z, whitened: w };
  }
  return R.refSpec;
}
function currentTerrain() {
  const x = P.run.settings.terrain || 'auto';
  return x === 'auto' ? (scenarioFromSource(P.flights?.source) || 'terrarium') : x;
}

async function doRun(ac, progress) {
  const evs = sortedEvents().filter((e) => validEvents().includes(e));
  const input = {
    events: evs.map((e) => ({ t_cpa_audio: e.t_cpa_audio, F0: e.F0, v_mps: [...e.v_mps], cpa_m: [...e.cpa_m], cls: e.cls, ridge: e.ridge,
      locked: !!e.locked, ...(Number.isFinite(e.fit?.t_sigma_s) ? { t_sigma_s: e.fit.t_sigma_s } : {}),
      ...(montageOn() && clipSpans().length > 1 ? { clip: clipOf(evTime(e)).id } : {}), ...(e.reg ? { reg: e.reg } : {}) })),
    ...(montageOn() && clipSpans().length > 1 ? { clips: clipSpans().map(({ id, t0, t1 }) => ({ id, t0, t1 })) } : {}),
    silences: P.silences.map(({ t0, t1 }) => ({ t0, t1 })),
    region: { shape: P.region.shape, center: P.region.center, radius_m: P.region.shape === 'circle' ? P.region.radius_m : undefined, bbox: regionBBox(P.region) },
    time: timeWindow(), duration_s: P.media?.duration || 0,
    tracks: usableTracks(), ...await scoringSpectrogram().then((r) => ({ spec: r.spec, ...(r.whitened ? { whitened: r.whitened } : {}) })),
    settings: { grid_m: P.run.settings.grid_m, c: soundSpeed(), topN: P.run.settings.topN, offsetTolS: P.run.settings.offsetTolS, refine: true,
      mode: P.run.settings.mode || 'robust', keepGroundOps: evs.some((e) => isGroundOps(e) && e.useGround),
      ...(montageOn() && P.montage.chrono && clipSpans().length > 1 ? { config: { montage_chrono: true } } : {}) },
  };
  R.searchLabels = evs.map((e) => evLabel(e));
  const terrain = currentTerrain();
  if (terrain !== 'terrarium') input.dem = await scenarioDem(terrain);
  else input.dem = R.flatTerrain ? createDem({ zoom: 12, retries: 1, retryBaseMs: 200, fallbackElevation: 0 }) : createDem({ zoom: 12, retries: 3 });
  R.demError = null; renderDemNote();
  const t0 = performance.now(), stageT = new Map();
  try {
    const res = await Engine.runSearch(input, {
      signal: ac.signal,
      onProgress: (p) => {
        if (!stageT.has(p.stage)) stageT.set(p.stage, performance.now());
        progress(t(`stage.${p.stage}`), p.frac ?? null);
      },
    });
    let cands = res.candidates;
    const ru = res.confidence?.runnerUp;
    let runnerIdx = ru ? cands.findIndex((c) => Math.abs(c.lat - ru.lat) < 1e-6 && Math.abs(c.lon - ru.lon) < 1e-6) : -1;
    if (ru && runnerIdx < 0) { cands = [...cands, { ...ru, runnerUp: true }]; runnerIdx = cands.length - 1; }
    P.run.results = { candidates: cands, confidence: res.confidence ? { margin: res.confidence.margin, ambiguous: !!res.confidence.ambiguous, message: res.confidence.message, runnerIdx,
        absolute: res.confidence.absolute || null } : null, labels: R.searchLabels, excluded: res.excluded_events || [], showAnyway: false,
      wallMs: performance.now() - t0, field: res.field ? { ...res.field, values: Array.from(res.field.values, (x) => (Number.isFinite(x) ? +x.toFixed(4) : null)) } : null,
      stats: res.stats, at: Date.now(), engine: `${Engine.ENGINE_INFO.name} ${Engine.ENGINE_INFO.version}`, input: { events: input.events.map(({ ridge, ...e }) => e), time: input.time } };
    P.run.selected = null;
    P.run.results.flatTerrain = !!(R.flatTerrain && terrain === 'terrarium');
    renderResults(); commit();
    if (res.candidates.length && P.run.results.confidence?.absolute?.verdict !== 'no plausible match') await selectCandidate(0, { fit: true });
    $('results').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
  } catch (e) {
    if (e?.name !== 'AbortError' && /DEM tile|terrain/i.test(e?.message || '')) { R.demError = e.message; renderDemNote(); return; }
    throw e;
  }
}

async function selectCandidate(i, { fromMap = false, fit = false } = {}) {
  const res = P.run.results; if (!res) return;
  const c = res.candidates[i]; if (!c) return;
  P.run.selected = i;
  renderCandidates();
  mapPanel.setResults(res, i);
  mapPanel.setFlights(R.tracks, P.filter, c.flights);
  if (fit) mapPanel.map.fitBounds([[res.field?.bbox?.[0] ?? c.lat - 0.05, res.field?.bbox?.[1] ?? c.lon - 0.05], [res.field?.bbox?.[2] ?? c.lat + 0.05, res.field?.bbox?.[3] ?? c.lon + 0.05]], { padding: [20, 20] });
  else if (!fromMap) mapPanel.focusCandidate(c);
  if (fromMap) document.querySelector(`.cand[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  R.sim = null;
  if (R.tracks.length && res.input?.events) {
    try {
      const curves = await Engine.simulateCurves(c, { events: res.input.events, tracks: R.tracks, c: soundSpeed(), harmonics: [1, 2, 3] });
      const byId = new Map(R.tracks.map((x) => [x.id, x]));
      R.sim = curves.map((k) => ({ ...k, label: byId.get(k.flight)?.callsign?.trim() || k.flight }));
    } catch (e) { toast(t('toast.simfail', { msg: e?.message || e }), { error: true }); }
  }
  drawOverlays(); commit();
}

// ------------------------------------------------------------------ rendering
function renderFlow() {
  const has = !!P.media;
  $('flow').hidden = !has;
  document.body.classList.toggle('has-media', has);
  document.body.classList.toggle('has-results', !!P.run.results);
  const b = runBlockers(), gate = dataGate(), busyRun = !!R.runAbort;
  $('btn-run').disabled = busyRun || b.length > 0 || !!gate;
  $('btn-run').textContent = P.run.results ? t('run.again') : t('run.go');
  $('btn-run').classList.toggle('btn--primary', !P.run.results || !!R.stale);
  $('run-hint').textContent = busyRun ? '' : b.length ? t(b[0]) : gate ? '' : P.run.results ? (R.stale ? t('run.stale') : '') : t('run.ready', { n: validEvents().length });
  $('events-state').textContent = P.events.length ? `${validEvents().length}/${P.events.length}` : '';
  renderGate();
}
function renderGate() {
  const box = $('gate-note'), g = dataGate();
  box.hidden = !g;
  if (!g) return;
  box.className = 'state-note state-note--warn';
  box.replaceChildren(h('strong', {}, t(g)), h('span', {}, t(`${g}.sub`, covDates())));
}

function renderMedia() {
  const info = $('media-info'), has = !!P.media;
  $('media-empty').hidden = has || !!live?.active;
  info.hidden = !has;
  $('btn-range').hidden = !(has && R.samples);
  if (has) {
    const m = P.media;
    const attached = !!R.samples;
    fill(info,
      svgIcon('M3.5 1.5h6l3 3v10h-9z'),
      h('span', { class: 'file-name', title: m.name }, m.name),
      h('span', { class: 'file-meta mono' }, attached || R.decoding ? T.fmtDuration(m.duration) : t('media.detached')),
      !attached && !R.decoding ? h('button', { type: 'button', class: 'btn btn--sm btn--primary', onclick: m.demo ? guard(reattachDemo) : () => $('file-media').click() }, t('media.reattach')) : null,
      h('button', { type: 'button', class: 'btn btn--icon btn--sm', id: 'btn-replace', 'aria-label': t('media.replace'), title: t('media.replace'), onclick: () => $('file-media').click() },
        svgIcon('M2.5 7a5.5 5.5 0 0 1 9.8-3M13.5 9a5.5 5.5 0 0 1-9.8 3M12.5 1.5V4H10M3.5 14.5V12H6')),
    );
  }
  $('spec-empty').hidden = !!spec.spec;
}
function svgIcon(d) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.5'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
  s.append(p); return s;
}
async function reattachDemo() { await loadMedia(await fetchDemoFile(), { demo: 'scenario1', keepProject: true }); }

function renderTime() {
  const tz = $('tz');
  if (document.activeElement !== tz) tz.value = P.time.tz;
  $('t-start').value = P.time.start || ''; $('t-end').value = P.time.end || '';
  const w = timeWindow(), L = P.media?.live;
  for (const id of ['t-start', 't-end', 't-at', 't-margin']) $(id).disabled = !!L;
  const auto = $('when-auto'), form = $('when-form');
  const at = P.time.at ? T.localToUnix(P.time.at, P.time.tz) : w ? (w.t0 + w.t1) / 2 : null;
  if (document.activeElement !== $('t-at')) $('t-at').value = P.time.at || '';
  $('t-margin').value = ['0.25', '1', '3', 'day'].includes(P.time.margin) ? P.time.margin : '1';
  const known = !!w, summary = known && (P.time.auto || !!L || !P.time.at) && R.editing !== 'when';
  auto.hidden = !summary;
  form.hidden = summary;
  $('btn-when-edit').setAttribute('aria-expanded', String(!form.hidden));
  if (known) {
    const mh = marginHours(P.time.margin);
    const span = L ? `±${L.tolS ?? LIVE_T_TOL_S} s` : !P.time.at ? `${fmtDateTime(w.t0, P.time.tz)} → ${fmtDateTime(w.t1, P.time.tz)}`
      : mh === 'day' ? t('when.day') : `±${mh < 1 ? `${Math.round(mh * 60)} min` : `${mh} h`}`;
    $('when-text').textContent = P.time.at && !L ? `${mh === 'day' ? fmtDate(at, P.time.tz) : fmtDateTime(at, P.time.tz)} ${mh === 'day' ? '' : span}` : L ? `${fmtDateTime(L.tStartUnix, P.time.tz)} ${span}` : span;
  }
  $('when-state').textContent = L ? t('when.src.live') : P.time.auto && P.media?.creation && !isDemo() ? t('when.src.file') : '';
  $('when-hint').textContent = known ? '' : P.media && !P.media.creation ? t('when.ask') : '';
  $('time-utc').textContent = w ? `UTC ${T.fmtUtc(w.t0)} → ${T.fmtUtc(w.t1)}` : P.time.start && P.time.end ? t('when.order') : '';
  $('t-end').setAttribute('aria-invalid', String(!!(P.time.start && P.time.end && !w)));
  renderFlow();
}

function renderRegion(syncMap = true) {
  const r = P.region;
  for (const b of document.querySelectorAll('[data-shape]')) b.setAttribute('aria-checked', String((r?.shape || currentShape()) === b.dataset.shape));
  $('r-size-label').textContent = (r?.shape || currentShape()) === 'rect' ? t('adv.halfside') : t('adv.radius');
  const act = document.activeElement;
  if (r) {
    const half = r.shape === 'rect' ? ((r.bounds[1][0] - r.bounds[0][0]) * 110540 / 2) : r.radius_m;
    if (act !== $('r-lat')) $('r-lat').value = r.center[0].toFixed(4);
    if (act !== $('r-lon')) $('r-lon').value = r.center[1].toFixed(4);
    if (act !== $('r-size')) $('r-size').value = (half / 1000).toFixed(1);
    const a = regionAreaKm2(r);
    $('region-summary').textContent = `${a.toFixed(a < 10 ? 1 : 0)} km² · ~${Math.round(a * 1e6 / (P.run.settings.grid_m ** 2)).toLocaleString()} ${t('adv.points')}`;
    const near = nearestPlace(r.center), rk = r.shape === 'circle' ? `${+(r.radius_m / 1000).toFixed(1)} km` : `${a.toFixed(0)} km²`;
    $('where-state').textContent = r.auto ? t('where.default') : '';
    if (act !== $('place')) $('place').value = '';
    $('place').placeholder = near && near.km < 15 && !isDemo() ? `${near.name} · ${rk}` : `${r.center[0].toFixed(3)}, ${r.center[1].toFixed(3)} · ${rk}`;
  } else {
    for (const id of ['r-lat', 'r-lon', 'r-size']) if (act !== $(id)) $(id).value = '';
    $('region-summary').textContent = ''; $('where-state').textContent = ''; $('place').placeholder = t('where.ph');
  }
  for (const b of document.querySelectorAll('[data-radius]')) b.setAttribute('aria-pressed', String(!!r && r.shape === 'circle' && Math.abs(r.radius_m - +b.dataset.radius) < 1));
  $('where-hint').textContent = r?.auto ? t('where.hint.default') : t('where.hint');
  if (syncMap) mapPanel.setRegion(r);
  renderFlow();
}

function renderEvents() {
  const list = $('event-list'), evs = sortedEvents();
  list.replaceChildren(...evs.map((ev) => passChip(ev)));
  $('events-hint').textContent = R.detecting ? t('ev.detecting') : !P.media ? '' : evs.length ? t('ev.hint.edit') : t('ev.hint.empty');
  $('events-hint').classList.toggle('is-busy', R.detecting);
  renderEditor();
  renderFlow();
}

function passChip(ev) {
  const lab = evLabel(ev), sel = ev.id === R.selEvent;
  const state = ev.status === 'tracking' ? t('ev.tracking') : ev.status === 'error' ? t('ev.error') : null;
  const conf = ev.auto ? (ev.label === 'confident' ? t('ev.auto') : t('ev.suggestion')) : t('ev.manual');
  const desc = [t('ev.pass', { l: lab }), Number.isFinite(ev.t_cpa_audio) ? T.fmtAudio(ev.t_cpa_audio, 0) : '', t(`cls.${ev.cls}`), conf, ev.off ? t('ev.off') : '', state].filter(Boolean).join(', ');
  return h('li', { class: `pass${sel ? ' is-selected' : ''}${ev.off ? ' is-off' : ''}${ev.auto && ev.label !== 'confident' ? ' is-suggestion' : ''}${ev.status === 'error' ? ' is-error' : ''}${isGroundOps(ev) && !ev.useGround ? ' is-excluded' : ''}`, style: `--ev-color:${ev.color}` },
    h('button', { type: 'button', class: 'pass-main', 'aria-pressed': String(sel), 'aria-label': desc, title: desc, onclick: () => selectEvent(ev.id, { zoom: !sel }) },
      h('span', { class: 'pass-letter', 'aria-hidden': 'true' }, lab),
      h('span', { class: 'pass-time mono', 'aria-hidden': 'true' }, Number.isFinite(ev.t_cpa_audio) ? T.fmtAudio(ev.t_cpa_audio, 0) : '…'),
      ev.status === 'error' ? h('span', { class: 'pass-flag', 'aria-hidden': 'true' }, '!') : ev.auto && ev.label !== 'confident' ? h('span', { class: 'pass-flag', 'aria-hidden': 'true' }, '?') : null),
    h('button', { type: 'button', class: 'pass-toggle', role: 'switch', 'aria-checked': String(!ev.off), 'aria-label': t(ev.off ? 'ev.turnon' : 'ev.turnoff', { l: lab }), title: t(ev.off ? 'ev.turnon' : 'ev.turnoff', { l: lab }), onclick: () => toggleEvent(ev) },
      h('span', { 'aria-hidden': 'true' })),
  );
}

function numInput(value, onchange, { step = 'any', label, min } = {}) {
  return h('input', { type: 'number', step, min, value: Number.isFinite(value) ? String(+(+value).toFixed(2)) : '', 'aria-label': label,
    onchange: (e) => onchange(e.target.value === '' ? null : +e.target.value) });
}
/** Editor for the selected pass: type and harmonic up front, measured ranges behind "Valors". */
function renderEditor() {
  const box = $('event-editor'), ev = P.events.find((e) => e.id === R.selEvent);
  if (!ev) { box.replaceChildren(); box.hidden = true; return; }
  box.hidden = false;
  const lab = evLabel(ev);
  const upd = (fn) => (v) => { fn(v); ev.edited = true; R.editsAfterRun = true; renderEvents(); drawOverlays(); commit(); };
  const cls = h('select', { 'aria-label': t('ev.type', { l: lab }), onchange: (e) => { ev.cls = e.target.value; P.defaultCls = ev.cls; renderSpecControls(); retrack(ev); } },
    ...CLASSES.map((k) => h('option', { value: k, selected: ev.cls === k }, t(`cls.${k}`))));
  const harm = h('select', { 'aria-label': t('ev.harm', { l: lab }), onchange: (e) => { ev.harmonic = +e.target.value; ev.edited = false; retrack(ev); } },
    ...[1, 2, 3, 4, 5, 6].map((n) => h('option', { value: n, selected: (ev.harmonic || 1) === n }, n === 1 ? t('ev.fund') : `×${n}`)));
  const notes = [];
  if (ev.status === 'error') notes.push(h('p', { class: 'ev-note ev-note--error' }, ev.error));
  if (ev.status === 'ok' && ev.fit?.poorly_constrained) notes.push(h('p', { class: 'ev-note' }, t('ev.partial')));
  if (ev.auto && ev.label !== 'confident') notes.push(h('p', { class: 'ev-note' }, t('ev.lowconf')));
  if (ev.status === 'ok' && isGroundOps(ev)) notes.push(h('label', { class: 'check ev-note' }, h('input', { type: 'checkbox', checked: !!ev.useGround,
    onchange: (e) => { ev.useGround = e.target.checked; renderEvents(); commit(); } }), t('ev.ground')));
  box.replaceChildren(
    h('div', { class: 'ed-head' },
      h('span', { class: 'ed-title', style: `--ev-color:${ev.color}` }, h('i', { 'aria-hidden': 'true' }), t('ev.pass', { l: lab })),
      h('label', { class: 'field field--inline' }, h('span', { class: 'sr-only' }, t('ev.type', { l: lab })), cls),
      h('button', { type: 'button', class: 'btn btn--icon btn--sm', 'aria-label': t('ev.zoom', { l: lab }), title: `${t('ev.zoom', { l: lab })} (Z)`, onclick: () => selectEvent(ev.id, { zoom: true }) },
        svgIcon('M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM11 11l3.5 3.5M5 7h4M7 5v4')),
      h('button', { type: 'button', class: 'btn btn--icon btn--sm', 'aria-label': t('ev.delete', { l: lab }), title: `${t('ev.delete', { l: lab })} (Del)`, onclick: () => deleteEvent(ev.id) },
        svgIcon('M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9'))),
    ...notes,
    h('details', { class: 'ed-values', ...(R.valuesOpen ? { open: true } : {}), ontoggle: (e) => { R.valuesOpen = e.target.open; } },
      h('summary', {}, t('ev.values')),
      h('div', { class: 'ev-grid' },
        h('label', { class: 'field' }, h('span', {}, t('ev.f.time')), numInput(ev.t_cpa_audio, upd((v) => { ev.t_cpa_audio = v; }), { label: t('ev.f.time') })),
        h('label', { class: 'field' }, h('span', {}, t('ev.f.f0')), numInput(ev.F0, upd((v) => { ev.F0 = v; }), { label: t('ev.f.f0') })),
        h('div', { class: 'field' }, h('span', {}, t('ev.f.speed')), h('div', { class: 'range-pair' },
          numInput(ev.v_mps[0], upd((v) => { ev.v_mps[0] = v; }), { label: `${t('ev.f.speed')} min`, min: 0 }), h('span', { 'aria-hidden': 'true' }, '–'),
          numInput(ev.v_mps[1], upd((v) => { ev.v_mps[1] = v; }), { label: `${t('ev.f.speed')} max`, min: 0 }))),
        h('div', { class: 'field' }, h('span', {}, t('ev.f.dist')), h('div', { class: 'range-pair' },
          numInput(ev.cpa_m[0], upd((v) => { ev.cpa_m[0] = v; }), { label: `${t('ev.f.dist')} min`, step: 10, min: 0 }), h('span', { 'aria-hidden': 'true' }, '–'),
          numInput(ev.cpa_m[1], upd((v) => { ev.cpa_m[1] = v; }), { label: `${t('ev.f.dist')} max`, step: 10, min: 0 }))),
        h('label', { class: 'field' }, h('span', {}, t('ev.f.harm')), harm),
        h('label', { class: 'field' }, h('span', {}, t('ev.f.reg')),
          h('input', { type: 'text', value: ev.reg || '', placeholder: 'EC-ABC', maxlength: 10, spellcheck: 'false', autocomplete: 'off',
            onchange: (e) => { ev.reg = e.target.value.trim().toUpperCase().replace(/\s+/g, '') || null; e.target.value = ev.reg || ''; commit(); } }))),
      h('div', { class: 'btn-row btn-row--tight' },
        h('label', { class: 'check', title: t('ev.lock.t') }, h('input', { type: 'checkbox', checked: !!ev.locked, onchange: (e) => { ev.locked = e.target.checked; commit(); } }), t('ev.lock')),
        ev.edited && ev.fit ? h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => {
          ev.edited = false; Object.assign(ev, { t_cpa_audio: ev.fit.t_cpa_audio, F0: ev.fit.F0, v_mps: [...ev.fit.v_mps], cpa_m: [...ev.fit.cpa_m] }); renderEvents(); drawOverlays(); commit(); } }, t('ev.usefit')) : null)),
  );
}
/** Re-track a pass after its type or harmonic changed (detected passes re-track from their seed). */
function retrack(ev) { if (ev.auto) { ev.auto = false; } trackEvent(ev); }

function renderSilences() {
  $('silence-list').replaceChildren(...P.silences.map((s) => h('li', { class: 'chip-item' }, `${t('silence')} ${T.fmtAudio(s.t0, 0)}–${T.fmtAudio(s.t1, 0)}`,
    h('button', { type: 'button', 'aria-label': t('silence.remove', { a: T.fmtAudio(s.t0, 0), b: T.fmtAudio(s.t1, 0) }),
      onclick: () => { P.silences = P.silences.filter((x) => x.id !== s.id); renderSilences(); drawBands(); commit(); } }, '×'))));
}

function renderFlights() {
  const box = $('flight-counts'), c = P.flights?.counts;
  box.replaceChildren(...CLASSES.map((k) => h('button', { type: 'button', class: 'cat-toggle', style: `--cat:${CAT_COLORS[k]}`,
    'aria-pressed': String(P.filter[k] !== false), onclick: () => { P.filter[k] = P.filter[k] === false; renderFlights(); commit(); } },
  h('span', { class: 'dot', 'aria-hidden': 'true' }), t(`cls.${k}`), c ? h('span', { class: 'n' }, (c[k] || 0).toLocaleString()) : null)));
  const note = $('flight-state');
  const none = P.flights && R.tracks.length === 0 && P.flights.counts && !Object.values(P.flights.counts).some((n) => n > 0);
  if (R.fetchError) note.replaceChildren(h('strong', {}, t('fetch.err.h')), h('span', {}, R.fetchError));
  else if (none) note.replaceChildren(h('strong', {}, t('fetch.none')), h('span', {}, t('fetch.none.sub')));
  note.className = `state-note ${R.fetchError ? 'state-note--error' : 'state-note--warn'}`;
  note.hidden = !(R.fetchError || none) || !!P.run.results;
  $('flight-source').textContent = P.flights ? [P.flights.source, ...(P.flights.notes || [])].filter(Boolean).join(' · ') : '';
  const sel = P.run.results?.candidates?.[P.run.selected];
  mapPanel.setFlights(R.tracks, P.filter, sel ? sel.flights : []);
  renderCoverage(); renderLegend(); renderFlow();
}

function renderLegend() {
  const parts = [];
  if (R.tracks.length) for (const k of CLASSES) if (P.filter[k] !== false && P.flights?.counts?.[k]) parts.push(h('span', {}, h('i', { style: `background:${CAT_COLORS[k]}` }), t(`cls.${k}`)));
  if (P.run.results?.field) parts.push(h('span', {}, t('map.score'), ' ', h('i', { class: 'ramp' })));
  $('map-legend').replaceChildren(...parts);
}

function renderResults() {
  const res = P.run.results;
  $('results').hidden = !res;
  const hideMap = res?.confidence?.absolute?.verdict === 'no plausible match' && !res.showAnyway;
  mapPanel.setResults(hideMap ? null : res, P.run.selected);
  renderVerdict();
  if (res) renderCandidates();
  renderLegend(); renderFlights(); renderFlow();
}

function candActions(c) {
  const coord = `${fmtLat(c.lat)}, ${fmtLon(c.lon)}`;
  const stop = (e) => e.stopPropagation();
  return h('div', { class: 'cand-actions' },
    h('button', { type: 'button', class: 'btn btn--sm', onclick: (e) => { stop(e); copy(coord); } }, t('res.copy')),
    h('a', { class: 'btn btn--sm', href: X.mapsUrl(c.lat, c.lon), target: '_blank', rel: 'noopener', onclick: stop }, 'Google Maps'),
    h('a', { class: 'btn btn--sm', href: X.streetViewUrl(c.lat, c.lon), target: '_blank', rel: 'noopener', onclick: stop }, 'Street View'));
}
function candItem(c, i, byId) {
  const sel = i === P.run.selected, coord = `${fmtLat(c.lat)}, ${fmtLon(c.lon)}`, tz = P.time.tz;
  const flights = c.flights.map((id) => { const x = byId.get(id); return x ? `${x.reg || x.callsign?.trim() || x.icao24 || id}${x.type ? ` (${x.type})` : ''}` : id; }).join(', ');
  const multi = c.t_start_by_clip && Object.keys(c.t_start_by_clip).length > 1;
  return h('li', { class: `cand${sel ? ' is-selected' : ''}`, dataset: { i }, tabindex: 0, 'aria-current': sel ? 'true' : null,
    'aria-label': t('res.cand', { n: c.runnerUp ? 'R' : i + 1, coord }), onclick: () => selectCandidate(i), onkeydown: (e) => { if (e.key === 'Enter' && e.currentTarget === e.target) selectCandidate(i); } },
  h('span', { class: 'cand-rank', 'aria-hidden': 'true' }, c.runnerUp ? 'R' : i + 1),
  h('span', { class: 'cand-coord' }, coord),
  h('span', { class: 'cand-score', title: t('res.score') }, i > 0 && Number.isFinite(c.margin) ? `−${(100 * c.margin).toFixed(0)} %` : ''),
  h('span', { class: 'cand-meta' },
    multi ? Object.entries(c.t_start_by_clip).flatMap(([id, ts], k) => {
      const sp = clipSpans().find((x) => x.id === id);
      return [k ? h('br') : null, `${t('clip')} ${id.replace('clip', '')}: ${fmtDateTime(ts + (sp?.t0 || 0), tz, true)}`];
    }) : [t('res.start'), ' ', h('b', {}, fmtDateTime(c.t_start_unix, tz, true))],
    flights ? [h('br'), t('res.flights'), ' ', h('b', {}, flights)] : null),
  sel ? candActions(c) : null);
}
function renderCandidates() {
  const res = P.run.results, byId = new Map(R.tracks.map((x) => [x.id, x]));
  const items = res.candidates.map((c, i) => candItem(c, i, byId));
  const list = $('cand-list');
  const show = Math.max(1, P.run.selected != null ? P.run.selected + 1 : 1);
  const head = items.slice(0, 1), rest = items.slice(1);
  list.replaceChildren(...head);
  if (rest.length) {
    const d = h('details', { class: 'cand-more', ...(R.moreOpen || show > 1 ? { open: true } : {}), ontoggle: (e) => { R.moreOpen = e.target.open; } },
      h('summary', {}, t('res.more', { n: rest.length })), h('ol', { class: 'cand-list', start: 2 }, ...rest));
    list.append(h('li', { class: 'cand-more-li' }, d));
  }
  if (Engine.ENGINE_INFO.fake) list.append(h('li', { class: 'meta-line' }, t('res.stub')));
  renderConfidence();
}

function renderDemNote() {
  const box = $('dem-note');
  if (!R.demError) { box.hidden = true; return; }
  box.hidden = false; box.className = 'state-note state-note--error';
  box.replaceChildren(h('strong', {}, t('dem.h')),
    h('div', { class: 'btn-row btn-row--tight' },
      h('button', { type: 'button', class: 'btn btn--sm', id: 'btn-flat', onclick: guard(async () => { R.flatTerrain = true; R.demError = null; renderDemNote(); await locate(); }) }, t('dem.flat')),
      h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: guard(async () => { R.demError = null; renderDemNote(); await locate(); }) }, t('dem.retry'))));
}

function renderVerdict() {
  const res = P.run.results, box = $('verdict'), wrap = $('cand-wrap');
  const abs = res?.confidence?.absolute;
  if (!res) { box.hidden = true; return; }
  const labels = res.labels || [];
  const v = abs?.verdict || (res.candidates.length ? 'weak' : 'no plausible match');
  const perEvent = (abs?.events || []).map((r, i) => {
    const who = t('ev.pass', { l: labels[i] || i + 1 });
    if (r.unexplained) return `${who}: ${t('pe.unexplained')}`;
    if (r.ridge_uncovered) return `${who}: ${t('pe.uncovered')}`;
    if (r.audible === false) return `${who}: ${t('pe.far')}`;
    const fl = r.flight ? R.tracks.find((x) => x.id === r.flight) : null;
    return `${who}: ${t(`pe.${r.status}`) || r.status}${fl ? ` (${fl.reg || fl.callsign?.trim() || r.flight})` : ''}`;
  });
  const details = (perEvent.length || abs?.reasons?.length) ? h('details', {}, h('summary', {}, t('details')),
    perEvent.length ? h('ul', {}, ...perEvent.map((x) => h('li', {}, x))) : null,
    abs?.reasons?.length ? h('ul', { class: 'tech' }, ...abs.reasons.map((x) => h('li', {}, x))) : null) : null;
  box.hidden = false;
  const icon = (k) => h('span', { class: 'verdict-ic', 'aria-hidden': 'true' }, k);
  if (v === 'match') {
    box.className = 'verdict verdict--match';
    fill(box, h('h3', {}, icon('✓'), t('v.match')), h('p', {}, t('v.match.sub')), details);
    wrap.hidden = false;
  } else if (v === 'weak') {
    box.className = 'verdict verdict--weak';
    fill(box, h('h3', {}, icon('~'), t('v.weak')), h('p', {}, t('v.weak.sub')), details);
    wrap.hidden = !res.candidates.length;
  } else {
    box.className = 'verdict verdict--none';
    const show = !!res.showAnyway;
    // detection keeps low-score passes off; on real circuit/stepped curves the true passes are often among them
    const nSug = P.events.filter((e) => e.auto && e.off && e.status === 'ok').length;
    fill(box, h('h3', {}, icon('×'), t('v.none')), h('p', {}, t('v.none.sub')), nSug ? h('p', { class: 'verdict-hint' }, t('v.sugg', { n: nSug })) : null, details,
      res.candidates.length ? h('button', { type: 'button', class: 'btn btn--quiet btn--sm', id: 'btn-show-anyway', 'aria-expanded': String(show),
        onclick: () => { res.showAnyway = !res.showAnyway; renderVerdict(); mapPanel.setResults(res.showAnyway ? res : null, P.run.selected); commit(); } },
      show ? t('v.hide') : t('v.show', { n: res.candidates.length })) : null);
    wrap.hidden = !show;
  }
}

function renderConfidence() {
  const res = P.run.results, box = $('confidence');
  const conf = res?.confidence;
  box.hidden = !conf || !res.candidates.length || !conf.ambiguous || conf.runnerIdx < 0;
  if (box.hidden) return;
  const best = res.candidates[0], ru = res.candidates[conf.runnerIdx];
  const kx = 111320 * Math.cos(best.lat * Math.PI / 180);
  const km = Math.hypot((ru.lat - best.lat) * 110950, (ru.lon - best.lon) * kx) / 1000;
  box.className = 'confidence confidence--ambiguous';
  box.replaceChildren(h('strong', {}, t('conf.tie')), h('span', {}, t('conf.tie.sub', { km: km.toFixed(1) })),
    h('div', { class: 'btn-row btn-row--tight' },
      h('button', { type: 'button', class: 'btn btn--sm', onclick: () => selectCandidate(0) }, '#1'),
      h('button', { type: 'button', class: 'btn btn--sm', onclick: () => selectCandidate(conf.runnerIdx) }, t('conf.runner'))));
}

function renderSettings() {
  const s = P.run.settings;
  $('set-grid').value = s.grid_m; $('set-temp').value = s.tempC; $('set-tol').value = s.offsetTolS; $('set-topn').value = s.topN;
  $('set-c').textContent = t('adv.c', { c: soundSpeed().toFixed(1) });
  for (const b of document.querySelectorAll('[data-runmode]')) b.setAttribute('aria-checked', String((s.mode || 'robust') === b.dataset.runmode));
  $('set-terrain').value = s.terrain || 'auto';
  if (document.activeElement !== $('set-adsb')) $('set-adsb').value = s.adsbWorker || '';
  $('set-adsb').placeholder = CFG.adsbWorker || t('adv.proxy.ph');
}
function renderSpecControls() {
  $('opt-hum').checked = P.spec.hum; $('opt-impulse').checked = P.spec.impulse;
  $('preset').replaceChildren(...Object.keys(PRESETS).map((k) => h('option', { value: k }, t(`preset.${k}`))));
  $('preset').value = P.spec.preset; $('colormap').value = P.spec.colormap;
  $('default-cls').replaceChildren(...CLASSES.map((k) => h('option', { value: k }, t(`cls.${k}`))));
  $('default-cls').value = P.defaultCls;
}
function renderAll() {
  renderMedia(); renderTime(); renderRegion(); renderEvents(); renderSilences(); renderFlights(); renderResults(); renderSettings(); renderSpecControls();
  renderMontage(); drawOverlays(); drawBands(); renderFlow(); renderRecord();
}

function setMode(m) {
  R.mode = m; spec.setMode(m);
  for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === m));
}

// ------------------------------------------------------------------ language
function renderLang() {
  applyI18n(document);
  document.documentElement.lang = lang();
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang()));
  const canvas = $('spec-host').querySelector('canvas');
  if (canvas) { canvas.setAttribute('aria-label', t('spec.canvas')); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-roledescription', t('spec.aria')); }
  $('legal-cov').textContent = t('legal.cov', covDates());
  const eb = $('engine-badge');
  eb.textContent = Engine.ENGINE_INFO.fake ? t('engine.stub') : `${t('engine')} ${Engine.ENGINE_INFO.version}`;
  mountHelp();
  renderAll();
}

// ------------------------------------------------------------------ wiring
function wire() {
  for (const b of document.querySelectorAll('[data-lang]')) b.addEventListener('click', () => setLang(b.dataset.lang));
  onLangChange(renderLang);
  anchorPopover($('menu'), $('btn-menu'), 'end');
  anchorPopover($('view-opts'), $('btn-view-opts'), 'end');
  const closeMenu = () => { try { $('menu').hidePopover(); } catch { /* not open */ } };

  $('btn-choose').addEventListener('click', () => $('file-media').click());
  $('file-media').addEventListener('change', guard(async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await loadMedia(f); }));
  $('btn-demo').addEventListener('click', guard(loadDemo));
  $('btn-import').addEventListener('click', () => { closeMenu(); $('file-project').click(); });
  $('file-project').addEventListener('change', guard(async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await importProject(f); }));
  $('btn-export-project').addEventListener('click', () => { closeMenu(); exportProject(); });
  $('btn-new').addEventListener('click', () => {
    closeMenu();
    R.undo = structuredClone(P);
    R.detectAbort?.abort(); R.runAbort?.abort(); R.fetchAbort?.abort();
    P = freshProject(); clearRunErrors(); R.tracks = []; R.sim = null; R.selEvent = null; R.file = null;
    releaseMedia(); resetSpecUi();
    banner(null); renderAll(); commit();
    if (COV?.bbox) mapPanel.map.fitBounds([[COV.bbox[0], COV.bbox[1]], [COV.bbox[2], COV.bbox[3]]]);
    toast(t('toast.new'), { action: { label: t('undo'), fn: undo } });
  });
  $('btn-help').addEventListener('click', () => { closeMenu(); $('dlg-help').showModal(); });
  $('btn-legal').addEventListener('click', () => { closeMenu(); $('dlg-legal').showModal(); });
  $('btn-legal-2').addEventListener('click', () => $('dlg-legal').showModal());
  $('btn-how').addEventListener('click', () => $('dlg-how').showModal());

  // drag & drop anywhere
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
  window.addEventListener('drop', guard(async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true;
    const f = e.dataTransfer.files[0]; if (!f) return;
    if (/\.json$/i.test(f.name)) await importProject(f); else await loadMedia(f);
  }));

  // when
  $('btn-when-edit').addEventListener('click', () => { R.editing = R.editing === 'when' ? null : 'when'; renderTime(); if (R.editing) $('t-at').focus(); });
  const fromCompact = () => {
    const at = T.localToUnix($('t-at').value, P.time.tz);
    if (at == null) return;
    setTime(at, $('t-margin').value, { creation: false, auto: false });
  };
  $('t-at').addEventListener('change', fromCompact);
  $('t-margin').addEventListener('change', () => {
    if ($('t-at').value) fromCompact();
    else if (P.time.at) setTime(T.localToUnix(P.time.at, P.time.tz), $('t-margin').value, { creation: !!P.time.creation, auto: P.time.auto });
  });
  const tzl = $('tz-list');
  tzl.replaceChildren(...T.timeZones().map((z) => h('option', { value: z })));
  $('tz').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (!tzValid(v)) { e.target.setAttribute('aria-invalid', 'true'); toast(t('tz.bad', { v }), { error: true }); return; }
    e.target.removeAttribute('aria-invalid'); P.time.tz = v; renderTime(); if (P.run.results) renderCandidates(); commit();
  });
  $('t-start').addEventListener('change', (e) => { P.time.start = e.target.value; P.time.at = ''; renderTime(); commit(); });
  $('t-end').addEventListener('change', (e) => { P.time.end = e.target.value; P.time.at = ''; renderTime(); commit(); });

  // where
  $('place-list').replaceChildren(...PLACES.map(([n]) => h('option', { value: n })));
  $('place').addEventListener('change', (e) => {
    const p = findPlace(e.target.value);
    if (!p) { if (e.target.value.trim()) toast(t('where.notfound'), { error: true }); return; }
    const rad = P.region?.shape === 'circle' && !P.region.auto ? P.region.radius_m : 5000;
    setRegion({ ...makeRegion('circle', [p[1], p[2]], rad), auto: false });
    e.target.value = ''; e.target.blur();
  });
  $('btn-near').addEventListener('click', () => {
    if (!navigator.geolocation) { toast(t('geo.none'), { error: true }); return; }
    navigator.geolocation.getCurrentPosition((pos) => setRegion({ ...makeRegion('circle', [pos.coords.latitude, pos.coords.longitude], 5000), auto: false }),
      () => toast(t('geo.denied'), { error: true }), { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  });
  for (const b of document.querySelectorAll('[data-radius]')) b.addEventListener('click', () => {
    const c = P.region?.center || [mapPanel.map.getCenter().lat, mapPanel.map.getCenter().lng];
    setRegion({ ...makeRegion('circle', c, +b.dataset.radius), auto: false });
  });
  for (const b of document.querySelectorAll('[data-shape]')) b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('[data-shape]')) x.setAttribute('aria-checked', String(x === b));
    if (P.region && P.region.shape !== b.dataset.shape) {
      const half = P.region.shape === 'rect' ? (P.region.bounds[1][0] - P.region.bounds[0][0]) * 110540 / 2 : P.region.radius_m;
      setRegion({ ...makeRegion(b.dataset.shape, P.region.center, half), auto: false }, false);
    } else renderRegion(false);
  });
  const fromInputs = () => {
    const lat = +$('r-lat').value, lon = +$('r-lon').value, km = +$('r-size').value;
    if (!$('r-lat').value || !$('r-lon').value || !(km > 0) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return;
    setRegion({ ...makeRegion(currentShape(), [lat, lon], km * 1000), auto: false });
  };
  for (const id of ['r-lat', 'r-lon', 'r-size']) $(id).addEventListener('change', fromInputs);

  // passes
  $('default-cls').addEventListener('change', (e) => { P.defaultCls = e.target.value; commit(); });
  $('opt-montage').addEventListener('change', (e) => { P.montage = { ...(P.montage || { cuts: [] }), on: e.target.checked }; renderMontage(); renderEvents(); drawOverlays(); commit(); });
  $('btn-detect-cuts').addEventListener('click', guard(detectAndAddCuts));
  $('opt-chrono').addEventListener('change', (e) => { P.montage.chrono = e.target.checked; commit(); });
  $('btn-clear-cuts').addEventListener('click', () => { P.montage.cuts = []; renderMontage(); renderEvents(); drawOverlays(); commit(); });
  $('btn-range').addEventListener('click', guard(() => loadMedia(R.file, { keepProject: true, forceRange: true, demo: P.media.demo })));

  // run
  $('btn-run').addEventListener('click', guard(locate));
  $('btn-cancel').addEventListener('click', () => { R.runAbort?.abort(); R.fetchAbort?.abort(); });
  const setNum = (id, key, min) => $(id).addEventListener('change', (e) => {
    const v = +e.target.value; if (!(v >= min)) { renderSettings(); return; }
    P.run.settings[key] = v; renderSettings(); renderRegion(false); commit();
  });
  for (const b of document.querySelectorAll('[data-runmode]')) b.addEventListener('click', () => { P.run.settings.mode = b.dataset.runmode; renderSettings(); commit(); });
  $('set-terrain').addEventListener('change', (e) => { P.run.settings.terrain = e.target.value; renderSettings(); commit(); });
  $('set-adsb').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (v && !/^https?:\/\//i.test(v)) { e.target.setAttribute('aria-invalid', 'true'); toast(t('proxy.bad'), { error: true }); return; }
    e.target.removeAttribute('aria-invalid'); P.run.settings.adsbWorker = v; renderSettings(); renderRecord(); commit();
  });
  setNum('set-grid', 'grid_m', 10); setNum('set-temp', 'tempC', -60); setNum('set-tol', 'offsetTolS', 0.5); setNum('set-topn', 'topN', 1);
  $('btn-geojson').addEventListener('click', () => {
    const res = P.run.results; if (!res) return;
    X.download(`${baseName()}_candidates.geojson`, X.candidatesToGeoJSON(res.candidates, { tracks: R.tracks, region: { polygon: regionPolygon(P.region) }, media: P.media, engine: res.engine }), 'application/geo+json');
  });
  $('btn-csv').addEventListener('click', () => {
    const res = P.run.results; if (!res) return;
    X.download(`${baseName()}_candidates.csv`, X.candidatesToCSV(res.candidates, { tracks: R.tracks }), 'text/csv');
  });

  // spectrogram toolbar
  for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
  $('preset').addEventListener('change', guard(async (e) => { P.spec.preset = e.target.value; commit(); await computeSpec({ keepView: true }); await retrackAuto(); }));
  $('opt-hum').addEventListener('change', guard(async (e) => { P.spec.hum = e.target.checked; commit(); await computeSpec({ keepView: true }); await retrackAuto(); }));
  $('opt-impulse').addEventListener('change', guard(async (e) => { P.spec.impulse = e.target.checked; commit(); await computeSpec({ keepView: true }); await retrackAuto(); }));
  $('btn-recompute').addEventListener('click', guard(() => computeSpec({ keepView: true })));
  $('colormap').addEventListener('change', (e) => { P.spec.colormap = e.target.value; spec.view.setColormap(e.target.value); commit(); });
  $('contrast').addEventListener('input', applyContrast);
  $('btn-reset-view').addEventListener('click', () => { spec.view.resetView(); defaultFreqView(); });
  $('btn-play').addEventListener('click', () => spec.togglePlay());
  $('scrub').addEventListener('input', (e) => spec.seek(+e.target.value));
  $('follow').addEventListener('change', (e) => spec.setFollow(e.target.checked));
  spec.onTime = (x, paused) => {
    $('play-time').textContent = T.fmtAudio(x, 0);
    if (document.activeElement !== $('scrub')) $('scrub').value = String(x);
    $('btn-play').dataset.playing = String(!paused);
    $('btn-play').setAttribute('aria-label', paused ? t('spec.play') : t('spec.pause'));
  };

  // keyboard
  document.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName, typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target?.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); exportProject(); return; }
    if (typing || e.ctrlKey || e.metaKey || document.querySelector('dialog[open]')) return;
    const sel = P.events.find((x) => x.id === R.selEvent), evs = sortedEvents();
    switch (e.key) {
      case 'v': case 'V': case 'm': case 'M': case 'Escape': setMode('mark'); break;
      case 's': case 'S': setMode('silence'); break;
      case 'c': case 'C': if (montageOn()) setMode('cut'); break;
      case ' ': if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return; e.preventDefault(); spec.togglePlay(); break;
      case 'ArrowLeft': case 'ArrowRight': {
        if (!spec.audio.src || tag === 'BUTTON' && e.target.getAttribute('role') === 'radio') return;
        e.preventDefault(); spec.seek(spec.audio.currentTime + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 30 : 5)); break;
      }
      case 'Enter': {
        const hv = spec.hover;
        if (R.mode !== 'mark' || !hv || !(e.target === document.body || e.target?.tagName === 'CANVAS')) return;
        e.preventDefault(); pickAt(hv.t, hv.f, e.altKey); break;
      }
      case '[': case ']': {
        if (!evs.length) return;
        const i = evs.findIndex((x) => x.id === R.selEvent), j = e.key === '[' ? Math.max(0, i - 1) : Math.min(evs.length - 1, i + 1);
        selectEvent(evs[i < 0 ? 0 : j].id, { zoom: true }); break;
      }
      case '1': case '2': case '3': case '4': if (sel) { sel.cls = CLASSES[+e.key - 1]; retrack(sel); } break;
      case 't': case 'T': if (sel) toggleEvent(sel); break;
      case 'z': case 'Z': if (sel) selectEvent(sel.id, { zoom: true }); break;
      case 'Delete': case 'Backspace': if (sel) { e.preventDefault(); deleteEvent(sel.id); } break;
      case '?': $('dlg-help').showModal(); break;
      default: return;
    }
  });
  window.addEventListener('beforeunload', () => Store.saveDraft(P));
}

const baseName = () => (P.media?.name || 'doppler').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
function exportProject() {
  const out = structuredClone(P);
  delete out.run.settings.adsbWorker;   // L1: environment setting, not project data
  X.download(`${baseName()}.overhead.json`, JSON.stringify({ ...out, savedAt: new Date().toISOString() }, null, 1));
  toast(t('toast.saved'));
}
async function importProject(file) {
  const obj = Store.normalizeProject(JSON.parse(await file.text()));
  obj.run.settings.adsbWorker = P.run.settings.adsbWorker || '';   // L1: never take the proxy URL from a file
  R.undo = structuredClone(P);
  const keepMedia = R.samples && obj.media && obj.media.name === P.media?.name && obj.media.size === P.media?.size;
  P = obj; R.tracks = []; R.sim = null; R.selEvent = null; clearRunErrors();
  if (!keepMedia) { R.file = null; releaseMedia(); resetSpecUi(); }
  renderAll(); mapPanel.setRegion(P.region, { fit: !!P.region }); commit(); restoreTracks();
  toast(t('toast.opened', { name: file.name }), { action: { label: t('undo'), fn: undo } });
}

// ------------------------------------------------------------------ live mode (Record now)
const liveProxy = () => workerUrl().replace(/\/+$/, '');
const live = createLivePanel($('live-panel'), {
  h, t, typesUrl: new URL('../data/types.json', import.meta.url),
  proxy: liveProxy,
  region: () => P.region,
  regionSummary: () => `${P.region.center[0].toFixed(3)}, ${P.region.center[1].toFixed(3)}`,
  useDeviceLocation: () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error(t('geo.none')));
    navigator.geolocation.getCurrentPosition((pos) => { setRegion({ ...makeRegion('circle', [pos.coords.latitude, pos.coords.longitude], 6000), auto: false }); resolve(); },
      () => reject(new Error(t('geo.denied'))), { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  }),
  toast: (m, o) => toast(m, o),
  onCancel: () => { renderRecord(); renderMedia(); },
  onDone: async ({ file, tStartUnix, clock, durationS, tracks, info }) => {
    await loadMedia(file, { live: { tStartUnix, tolS: LIVE_T_TOL_S, offsetMs: clock.offsetMs, minRttMs: clock.minRttMs, clockSamples: clock.n } });
    R.tracks = tracks;
    const counts = { prop: 0, jet: 0, heli: 0, unknown: 0 };
    for (const x of tracks) counts[counts[x.category] != null ? x.category : 'unknown']++;
    const w = timeWindow(), src = 'adsb.lol live (via proxy)', key = cacheKey(src, { bbox: info.bbox, t0: w.t0, t1: w.t1 });
    P.flights = { source: src, attribution: 'ADS-B data © adsb.lol contributors, ODbL 1.0', counts, query: { bbox: regionBBox(P.region), t0: w.t0, t1: w.t1 }, at: Date.now(), cacheKey: key,
      notes: [`${info.aircraftSeen} / ${info.hexes}`] };
    putTracks(key, tracks);
    renderFlights(); renderTime(); renderRecord(); commit();
    toast(t('live.ready', { n: tracks.length, d: T.fmtDuration(durationS) }));
  },
});
function renderRecord() {
  const why = !liveProxy() ? 'proxy' : micUnavailableReason();
  $('btn-record').hidden = !!why;
  $('btn-record').disabled = !!live?.active;
}
$('btn-record').addEventListener('click', () => {
  if (R.decoding) return;
  live.open(); renderRecord(); renderMedia();
});

// ------------------------------------------------------------------ boot
wire();
const draft = Store.loadDraft();
const QS_PROXY = QS.get('proxy');
if (QS_PROXY && QS_PROXY !== P.run.settings.adsbWorker) setTimeout(() => {
  let host = QS_PROXY;
  try { const u = new URL(QS_PROXY); if (!/^https?:$/.test(u.protocol)) throw new Error('bad'); host = u.origin; }
  catch { toast(t('proxy.linkbad'), { error: true }); return; }
  banner([h('strong', {}, t('proxy.link')), ' ', h('code', {}, host), ' ', t('proxy.link.sub'), ' ',
    h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: 'btn-proxy-accept', onclick: () => {
      P.run.settings.adsbWorker = host; renderSettings(); renderRecord(); commit(); banner(null); toast(t('proxy.using', { host }));
    } }, t('proxy.accept')),
    ' ', h('button', { type: 'button', class: 'btn btn--quiet btn--sm', id: 'btn-proxy-ignore', onclick: () => banner(null) }, t('proxy.ignore'))]);
}, 0);
if (draft && (draft.media || draft.events.length)) {
  P = draft;
  for (const ev of P.events) if (ev.status === 'tracking') ev.status = ev.fit ? 'ok' : 'error';
  if (draft.media && !draft.media.demo) R.draftBanner = banner([h('strong', {}, t('draft.h')), ' ', t('draft.sub', { name: draft.media.name }),
    ' ', h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => { $('btn-new').click(); banner(null); } }, t('draft.over'))]);
}
setMode('mark');
renderLang();
if (P.region) mapPanel.setRegion(P.region, { fit: true });
restoreTracks();
if (draft?.media?.demo) guard(reattachDemo)();
// which days the archive really has (falls back to config.js coverage if the manifest cannot be read)
fetchManifest(workerUrl()).then((m) => { const c = mergeManifest(COV, m); if (c !== COV) { COV = c; renderLang(); } });
