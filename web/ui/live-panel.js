// "Record now" (live mode, E4): microphone recording with an exact start time, live discovery of nearby aircraft
// through the ADS-B proxy, then trace backfill. Reuses Lane L's modules in web/live/.
// The app supplies callbacks; this module only owns the live panel UI and the recording session.
import { startRecording, wavFromBlocks } from '../live/recorder.js';
import { startPolling, finishTracks } from '../live/session.js';
import { LiveTrackBuilder, bboxAround } from '../live/adsb-live.js';

export const LIVE_T_TOL_S = 3;   // Lane L: ADS-B stamp latency + audio anchor → ±3 s prior on T_start
export const LIVE_MAX_S = 45 * 60;   // B2: auto-stop (memory and ADS-B backfill both grow with the length)

/** 16-bit PCM mono WAV file from Float32 samples. */
export function wavFile(samples, fs, name) {
  const n = samples.length, pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 32767;
  return wavFromBlocks([pcm], n, fs, name);
}

export function micUnavailableReason() {
  if (!globalThis.isSecureContext) return 'The microphone only works on a secure (https) page.';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser cannot record from a microphone.';
  if (!globalThis.AudioWorkletNode) return 'This browser lacks AudioWorklet, which recording needs.';
  return null;
}

const micError = (t, e) => e?.name === 'NotAllowedError' ? t('live.err.blocked')
  : e?.name === 'NotFoundError' ? t('live.err.nomic')
    : e?.name === 'NotReadableError' ? t('live.err.busy')
      : t('live.err.start', { msg: e?.message || e });

/**
 * @param el     container (#live-panel)
 * @param ctx    {h, proxy(): string, region(): region|null, regionSummary(): string, useDeviceLocation(): Promise,
 *                onDone({file, tStartUnix, clock, tracks, info}): Promise, onCancel(), toast(msg, opts), typesUrl}
 */
export function createLivePanel(el, ctx) {
  const { h } = ctx;
  const t = ctx.t || ((k) => k);
  let session = null, types = null, timer = 0;

  async function loadTypes() {
    if (types) return types;
    try { const r = await fetch(ctx.typesUrl); types = r.ok ? await r.json() : null; } catch { types = null; }
    return types;
  }

  function show(state, data = {}) {
    el.hidden = false;
    el.dataset.state = state;
    if (state === 'setup') {
      const region = ctx.region();
      el.replaceChildren(
        h('p', { class: 'live-title' }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), h('strong', {}, t('live.h'))),
        h('p', { class: 'hint' }, t('live.hint')),
        h('p', { class: 'meta-line' }, region ? ctx.regionSummary() : t('live.noarea')),
        h('div', { class: 'btn-row btn-row--tight' },
          h('button', { type: 'button', class: 'btn btn--sm', id: 'btn-live-geo', onclick: async () => {
            try { await ctx.useDeviceLocation(); lastArea = areaKey(); show('setup'); } catch (e) { ctx.toast(e?.message || t('geo.none'), { error: true }); }
          } }, t('live.geo'))),
        h('p', { class: 'hint' }, t('live.tip')),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn btn--primary', id: 'btn-live-start', disabled: !region, onclick: start }, t('live.start')),
          h('button', { type: 'button', class: 'btn btn--quiet', onclick: cancel }, t('cancel'))));
    } else if (state === 'asking') {
      el.replaceChildren(h('p', { class: 'live-title' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', t('live.asking')));
    } else if (state === 'recording') {
      el.replaceChildren(
        h('p', { class: 'live-title' }, h('span', { class: 'live-dot is-on', 'aria-hidden': 'true' }), h('strong', {}, t('live.rec')), h('output', { class: 'live-time mono', id: 'live-time' }, '0:00')),
        h('div', { class: 'live-meter', 'aria-hidden': 'true' }, h('i', { id: 'live-level' })),
        h('p', { class: 'meta-line', id: 'live-stats', 'aria-live': 'polite' }, t('live.polling')),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn btn--danger', id: 'btn-live-stop', onclick: stop }, t('live.stop')),
          h('button', { type: 'button', class: 'btn btn--quiet', onclick: cancel }, t('live.discard'))));
    } else if (state === 'finishing') {
      el.replaceChildren(h('p', { class: 'live-title' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', data.text || t('live.finishing')),
        h('progress', { max: 1, value: data.frac ?? 0, id: 'live-progress' }));
    }
  }

  async function start() {
    const proxy = ctx.proxy(), region = ctx.region();
    if (!proxy || !region) return;
    show('asking');
    const builder = new LiveTrackBuilder();
    let last = null;
    const [lat, lon] = region.center;
    try {
      const rec = await startRecording({ onLevel: (rms) => {
        const lv = el.querySelector('#live-level');
        if (lv) lv.style.width = `${Math.max(2, Math.min(100, (20 * Math.log10(rms + 1e-9) + 60) / 60 * 100))}%`;
      } });
      const poll = startPolling({ base: proxy, lat, lon, nm: 25, everyS: 15, builder,
        onSnapshot: ({ stats, clock, aircraft }) => { last = { stats, clock, aircraft }; } });
      session = { rec, poll, builder, region: structuredClone(region), t0: performance.now() };
      show('recording');
      timer = setInterval(() => {
        const s = session?.rec.seconds ?? 0, tm = el.querySelector('#live-time'), st = el.querySelector('#live-stats');
        if (s >= LIVE_MAX_S && session && !session.stopping) { ctx.toast(t('live.autostop', { min: Math.round(LIVE_MAX_S / 60) }), { ms: 8000 }); stop(); return; }
        if (tm) tm.textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
        const ps = session?.poll.stats;
        if (st && ps && ps.polls === 0 && ps.errors >= 2) {
          st.textContent = t('live.unreachable');
          st.classList.add('live-error');
        } else if (st && last) st.classList.remove('live-error');
        if (st && last) st.textContent = t('live.stats', { n: last.aircraft }) +
          (last.clock?.offsetMs != null ? ` · ±${Math.max(50, Math.round((last.clock.minRttMs || 0) / 2))} ms` : '');
      }, 500);
    } catch (e) {
      session?.poll?.stop(); session = null;
      show('setup');
      ctx.toast(micError(t, e), { error: true, ms: 8000 });
    }
  }

  async function stop() {
    if (!session || session.stopping) return;
    session.stopping = true;
    clearInterval(timer);
    const { rec, poll, builder, region } = session;
    show('finishing', { text: t('live.saving') });
    const a = await rec.stop();
    poll.stop();
    const clock = poll.clock.estimate();
    const tStartUnix = ((a.tStartLocalMs ?? (performance.timeOrigin + session.t0)) + (clock.offsetMs ?? 0)) / 1000;
    const durationS = a.n / a.fs;
    session = null;
    if (durationS < 5) { show('setup'); ctx.toast(t('live.short'), { error: true }); return; }
    const iso = new Date(tStartUnix * 1000).toISOString().replace(/[:]/g, '-').replace(/\..+/, '');
    const file = wavFromBlocks(a.blocks, a.n, a.fs, `live_${iso}.wav`);
    a.blocks = null;   // the File owns the PCM now: drop our copy before the backfill and the analysis
    const radiusM = Math.max(15000, region.radius_m || 0);
    show('finishing', { text: t('live.tracks'), frac: 0 });
    let ft;
    try {
      ft = await finishTracks({ builder, base: ctx.proxy(), center: region.center, radiusM, tStartUnix, durationS, types: await loadTypes(),
        onProgress: (p) => show('finishing', { text: `${t('live.tracks')} ${p.done}/${p.total}`, frac: p.done / Math.max(1, p.total) }) });
    } catch (e) {
      ft = { tracks: [], hexes: [], backfill: { ok: 0, failed: 0 } };
      ctx.toast(t('live.tracksfail', { msg: e?.message || e }), { error: true });
    }
    el.hidden = true; el.replaceChildren();
    await ctx.onDone({ file, tStartUnix, clock, durationS, fs: a.fs, anchor: a.anchor,
      tracks: ft.tracks, info: { hexes: ft.hexes.length, backfill: ft.backfill, polls: poll.stats, aircraftSeen: builder.ac.size,
        bbox: bboxAround(region.center[0], region.center[1], radiusM) } });
  }

  async function cancel() {
    clearInterval(timer);
    if (session) { try { session.poll.stop(); await session.rec.stop(); } catch { /* ignore */ } session = null; }
    el.hidden = true; el.replaceChildren();
    ctx.onCancel?.();
  }

  const areaKey = () => { const r = ctx.region(); return r ? ctx.regionSummary() : ''; };
  let lastArea = null;
  return {
    open: () => { lastArea = areaKey(); show('setup'); },
    // re-render the setup step only when the area really changed (a blur-triggered change event must not swallow a click)
    refresh: () => { if (el.dataset.state === 'setup' && !el.hidden && areaKey() !== lastArea) { lastArea = areaKey(); show('setup'); } },
    get active() { return !el.hidden; },
  };
}
