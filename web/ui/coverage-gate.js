// Flight-archive availability: which UTC days the data server has (manifest meta/coverage.json written by
// ref/data/daily_job.py, served by the Worker at /adsb/index/meta/coverage.json) and the date part of the search gate.
// Pure functions, unit-tested in web/tests/coverage-gate.test.mjs.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MANIFEST_PATH = '/adsb/index/meta/coverage.json';

/** UTC days ('YYYY-MM-DD') touched by [t0, t1] (unix s). */
export function utcDays(t0, t1) {
  const out = [];
  for (let d = Math.floor(t0 / 86400); d <= Math.floor(t1 / 86400); d++) out.push(new Date(d * 86400000).toISOString().slice(0, 10));
  return out;
}

/** Config coverage + manifest -> coverage {bbox, from, to?, days?}; the config is kept for anything the manifest lacks. */
export function mergeManifest(cfg, m) {
  const days = Array.isArray(m?.days) ? m.days.filter((d) => typeof d === 'string' && DAY_RE.test(d)).sort() : null;
  if (!days?.length) return cfg;
  return { ...cfg, from: days[0], to: days[days.length - 1], days };
}

/** Fetch the manifest from the Worker; null on any failure (callers keep the config values). */
export async function fetchManifest(worker, { fetch: f = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (!worker) return null;
  try {
    const r = await f(`${worker.replace(/\/+$/, '')}${MANIFEST_PATH}`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/**
 * Date gate. win = {t0, t1} (start window), dur = recording length (s): the search needs every UTC day in
 * [t0, t1 + dur]. Returns null or an i18n key: 'gate.date' (all before the first day), 'gate.future',
 * 'gate.missing' (a needed day from `from` on is not in cov.days). Without cov.days only `from` is checked.
 * live: a live recording brings its own tracks, so archive days are not required.
 */
export function dateGate(win, cov, { dur = 0, now = Date.now() / 1000, live = false } = {}) {
  if (!win || !cov) return null;
  const from = cov.from ? Date.parse(`${cov.from}T00:00:00Z`) / 1000 : null;
  if (from != null && win.t1 < from) return 'gate.date';
  if (win.t0 > now + 3600) return 'gate.future';
  if (live || !Array.isArray(cov.days)) return null;
  const have = new Set(cov.days);
  const need = utcDays(win.t0, win.t1 + dur).filter((d) => !cov.from || d >= cov.from);
  return need.some((d) => !have.has(d)) ? 'gate.missing' : null;
}
