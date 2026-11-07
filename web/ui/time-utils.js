// Time-zone helpers built on Intl only (no dependencies).

const dtfCache = new Map();
function dtf(tz) {
  if (!dtfCache.has(tz)) dtfCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  return dtfCache.get(tz);
}
function parts(tz, ms) {
  const o = {};
  for (const p of dtf(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}
/** Offset of `tz` from UTC in minutes at instant `ms`. */
export function tzOffsetMin(tz, ms) {
  const p = parts(tz, ms);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}
/** 'YYYY-MM-DDTHH:mm' wall time in tz -> unix seconds. */
export function localToUnix(str, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(str || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let t = guess - tzOffsetMin(tz, guess) * 60000;
  const off2 = tzOffsetMin(tz, t);
  t = guess - off2 * 60000;
  return t / 1000;
}
/** unix seconds -> 'YYYY-MM-DDTHH:mm' wall time in tz (for datetime-local inputs). */
export function unixToLocalInput(unix, tz) {
  const p = parts(tz, unix * 1000);
  return `${p.year}-${p.month}-${p.day}T${String(+p.hour % 24).padStart(2, '0')}:${p.minute}`;
}
export function fmtOffset(min) {
  const s = min < 0 ? '−' : '+', a = Math.abs(min);
  return `UTC${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
/** Human date-time in tz, e.g. '2024-06-01 08:00:00 (UTC−04:00)'. */
export function fmtInTz(unix, tz, { seconds = true, offset = true } = {}) {
  if (unix == null || !Number.isFinite(unix)) return '—';
  const p = parts(tz, unix * 1000);
  const s = `${p.year}-${p.month}-${p.day} ${String(+p.hour % 24).padStart(2, '0')}:${p.minute}${seconds ? ':' + p.second : ''}`;
  return offset ? `${s} (${fmtOffset(tzOffsetMin(tz, unix * 1000))})` : s;
}
export const fmtUtc = (unix) => (unix == null ? '—' : new Date(unix * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z'));
export function timeZones() {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC', 'Europe/London', 'Europe/Madrid', 'America/New_York', 'America/Los_Angeles']; }
}
export const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Audio time in seconds -> 'm:ss.s' (or h:mm:ss for long files). */
export function fmtAudio(t, digits = 1) {
  if (t == null || !Number.isFinite(t)) return '—';
  const sign = t < 0 ? '−' : '', a = Math.abs(t);
  const h = Math.floor(a / 3600), m = Math.floor((a % 3600) / 60), s = a % 60;
  const ss = s.toFixed(digits).padStart(digits ? 3 + digits : 2, '0');
  return h ? `${sign}${h}:${String(m).padStart(2, '0')}:${ss}` : `${sign}${m}:${ss}`;
}
export function fmtDuration(s) {
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return `${s.toFixed(1)} s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = Math.round(s % 60);
  return h ? `${h} h ${m} min` : `${m} min ${r} s`;
}

/** 'h:mm:ss' | 'm:ss' | 's' (decimals allowed) -> seconds, or null. */
export function parseClock(str) {
  const m = /^\s*(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?(?::(\d+(?:\.\d+)?))?\s*$/.exec(str || '');
  if (!m) return null;
  return [m[1], m[2], m[3]].filter((x) => x != null).map(Number).reduce((acc, x) => acc * 60 + x, 0);
}
/** B10: why [a, b] is not a usable analysis range of a recording of `dur` s (null/0 = unknown): an i18n key, or null. */
export function cropRangeError(a, b, dur) {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return 'large.bad';
  if (dur > 0 && a >= dur) return 'large.past';
  if (!(b > a)) return 'large.order';
  if (dur > 0 && Math.min(b, dur) - a < 1) return 'large.order';
  return null;
}
