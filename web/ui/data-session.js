// Human session for the data server (worker/src/index.js POST /session, header X-Doppler-Session).
// Once per page session the app runs an invisible/managed Cloudflare Turnstile check, trades the token for a 2 h
// signed session and sends it on every data request to the configured Worker origin. Active only when config.js has
// turnstileSiteKey (deploy/build.mjs); other origins (a self-hosted proxy set in Advanced) never get the header.
// The coverage manifest and /health are open on the Worker, so they are fetched without a session.

export const SESSION_HEADER = 'X-Doppler-Session';
const OPEN_PATHS = new Set(['/health', '/session', '/adsb/index/meta/coverage.json']);
const RENEW_BEFORE_S = 120;

export class SessionError extends Error {
  constructor(msg) { super(msg); this.name = 'SessionError'; this.code = 'session'; }
}

/**
 * @param origin    Worker origin (https://host)
 * @param getToken  () => Promise<string>: a fresh Turnstile token
 * @param fetch     underlying fetch
 * @param onState   ('ok'|'failed', err?) => void: UI hook (shows/hides the "verification failed" message)
 */
export function createDataSession({ origin, getToken, fetch: f, onState = () => {}, now = () => Date.now() }) {
  let sess = null, inflight = null, failed = null;

  async function issue() {
    const token = await getToken();
    const r = await f(`${origin}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    if (!r.ok) throw new SessionError(`session HTTP ${r.status}`);
    const d = await r.json();
    if (!d?.session || !Number.isFinite(d.exp)) throw new SessionError('session: bad answer');
    return { token: d.session, exp: d.exp };
  }

  /** Current session token, renewing it when it is missing or about to expire. After a failure, rejects at once until retry(). */
  async function ensure() {
    if (failed) throw failed;
    if (sess && sess.exp - RENEW_BEFORE_S > now() / 1000) return sess.token;
    inflight ||= issue().then((s) => { sess = s; onState('ok'); return s.token; }, (e) => {
      failed = e instanceof SessionError ? e : new SessionError(`verification failed: ${e?.message || e}`);
      onState('failed', failed);
      throw failed;
    }).finally(() => { inflight = null; });
    return inflight;
  }

  const gated = (url) => url.origin === origin && !OPEN_PATHS.has(url.pathname);

  /** fetch() that adds the session to gated requests; on a 401 "session" answer it renews once and retries. */
  async function sessionFetch(input, init = {}) {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, globalThis.location?.href); } catch { return f(input, init); }
    if (!gated(url)) return f(input, init);
    const go = async () => {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      headers.set(SESSION_HEADER, await ensure());
      return f(input, { ...init, headers });
    };
    const r = await go();
    if (r.status !== 401) return r;
    const body = await r.clone().json().catch(() => null);
    if (body?.code !== 'session') return r;
    sess = null; // expired, IP changed (network switch) or the key was rotated: one renewal
    return go();
  }

  return {
    fetch: sessionFetch,
    ensure,
    /** Clear a failure and verify again (the "retry" button). */
    retry() { failed = null; sess = null; return ensure(); },
    get state() { return failed ? 'failed' : sess ? 'ok' : 'none'; },
  };
}

// ------------------------------------------------------------------ Turnstile (browser only)
const TURNSTILE_JS = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/**
 * () => Promise<token> backed by one explicit-render Turnstile widget (action "session"). appearance
 * "interaction-only": nothing is shown unless Cloudflare needs a click, then the widget appears bottom-right.
 */
export function turnstileTokenGetter(siteKey, { doc = globalThis.document, timeoutMs = 60000 } = {}) {
  let loaded = null, widget = null, box = null, waiter = null;
  const load = () => loaded ||= new Promise((resolve, reject) => {
    if (globalThis.turnstile) return resolve(globalThis.turnstile);
    const s = doc.createElement('script');
    s.src = TURNSTILE_JS; s.async = true;
    s.onload = () => (globalThis.turnstile ? resolve(globalThis.turnstile) : reject(new Error('turnstile did not load')));
    s.onerror = () => { loaded = null; reject(new Error('turnstile blocked or offline')); };
    doc.head.append(s);
  });
  const settle = (fn, v) => { const w = waiter; waiter = null; if (w) { clearTimeout(w.timer); w[fn](v); } };
  return async function getToken() {
    const ts = await load();
    return new Promise((resolve, reject) => {
      settle('reject', new Error('superseded'));
      waiter = { resolve, reject, timer: setTimeout(() => settle('reject', new Error('turnstile timeout')), timeoutMs) };
      if (widget === null) {
        box = doc.createElement('div');
        box.className = 'turnstile-box';
        doc.body.append(box);
        widget = ts.render(box, {
          sitekey: siteKey, action: 'session', appearance: 'interaction-only', execution: 'execute',
          callback: (tok) => settle('resolve', tok),
          'error-callback': (code) => { settle('reject', new Error(`turnstile error ${code}`)); return true; },
          'expired-callback': () => {}, 'timeout-callback': () => settle('reject', new Error('turnstile timeout')),
        });
      } else ts.reset(widget);
      ts.execute(widget);
    });
  };
}

/**
 * Install the session-aware fetch as globalThis.fetch (every data call site uses the global fetch at call time).
 * Returns the session object, or null when sessions are not configured.
 */
export function installDataSession(cfg, { onState, win = globalThis } = {}) {
  if (!cfg?.turnstileSiteKey || !cfg.adsbWorker) return null;
  let origin;
  try { origin = new URL(cfg.adsbWorker).origin; } catch { return null; }
  const base = win.fetch.bind(win);
  const s = createDataSession({ origin, getToken: turnstileTokenGetter(cfg.turnstileSiteKey), fetch: base, onState });
  win.fetch = s.fetch;
  return s;
}
