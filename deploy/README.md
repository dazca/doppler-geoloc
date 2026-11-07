# Deploying Overhead (Cloudflare Pages + Worker + R2)

**Status (2026-11-07):** the data backend is **deployed** on the owner's Cloudflare account: Worker
`doppler-geoloc-data` at **https://doppler-data.azemar.eu** (custom domain, `workers_dev = false`) and R2 bucket
`doppler-adsb-index`, with data for **Catalonia + Andorra** (0.5° cells lat 40.0-43.0, lon 0.0-3.5 = 42 cells) for the
last ~30 UTC days. Pages is **not** deployed yet (§3-§4). The daily data job exists but is **not scheduled** (§1b).

There are three pieces:

| piece | source | what it does |
|---|---|---|
| **Pages** (static site) | `web/`, built into `deploy/dist/` | The whole app. Media never leaves the browser. |
| **Worker** | `worker/` (`worker/src/index.js`) | CORS and cache relay for adsb.lol. Historical routes: `/adsb/range`, `/adsb/index/…`, `/adsb/tile/…`. Live routes: `/v2/point/…` and `/data/traces/…`. Also `/health`. |
| **R2 bucket** `doppler-adsb-index` | built offline (`ref/data/build_index.py`, `build_tiles.py`) | Per-cell index shards and per-day non-jet track tiles for the historical search |

## 0. Prerequisites
* A Cloudflare account and Node 20+. Then run `npx wrangler login` once.
* **adsb.lol:** email them before production use. Their API terms ask production users to get in touch, and API keys are planned. Offer attribution, caching and a feeder (see docs/LANE_L_REPORT.md §4).
* **Map tiles:** choose a provider whose terms allow commercial use. The default Esri basemaps and OSM's own tile servers are fine for testing but not for a paid SaaS. To switch, change the URLs in `web/ui/map-panel.js` and `img-src` in `web/_headers`.

## 1. R2 bucket and data
```bash
npx wrangler r2 bucket create doppler-adsb-index          # done 2026-11-07
python ref/data/daily_job.py                              # builds + uploads every missing day of the last 30
```
`ref/data/daily_job.py` is the single, idempotent data job (region constants at its top: Catalonia + Andorra). Per
missing UTC day it streams the adsb.lol `prod` and `mlatonly` tars once (nothing big is written to disk), then uploads:

| R2 key | Built from | Read by (web/engine/adsb.js) |
|---|---|---|
| `tiles/<date>/<cell>.json.gz` (42/day) | non-jet tracks per cell, contract format (same schema as `build_tiles.py`) | `fetchTracksFromTiles`, `coverageBaseline` (±1-4 weeks) |
| `<tag>/<cell>.json` (42 per feed/day) | `build_index.py --bbox` (byte offsets into the GitHub tar) | `fetchTracks` (the app's search path) + `/adsb/range` |
| `<tag>/day.json` (1 per feed/day) | `build_index.py` (`ok`/`partial`/`empty`/`missing`) | `fetchDayStatus` |
| `meta/coverage.json` (1) | availability manifest `{updated, bbox, days[], from, to}`, updated after each day's `day.json`; `--rebuild-manifest` rewrites it from the days whose two `day.json` the Worker serves (also run at the end of every GitHub run) | `web/ui/coverage-gate.js` (date gate, legal text); Worker route `/adsb/index/meta/coverage.json`, 60 s cache |

`day.json` is uploaded last and is the "day done" marker: the job asks the live Worker for both feeds' `day.json` and
skips days that have them, so re-running is cheap and a failed day is retried on the next run (catch-up). A day whose
`prod` release is not published yet is skipped; a missing `mlatonly` is published as `missing` only once the day is
more than 2 days old. Useful flags: `--date YYYY-MM-DD` (repeatable), `--force`, `--max-days N`, `--no-upload --keep-files`.
Local temp files go to `.cache/daily/<date>/` and are deleted after upload; the ~30 MB day index is deleted too
(`--keep-index` keeps it) and only `.cache/adsb/<tag>.counts.json` stays (reference for the partial-day check).
Requests outside the covered cells or days return 404, which the app reports as "not built".

### 1b. Scheduling the daily job (owner's decision; nothing is scheduled)
Run it once a day after adsb.lol has published the previous day (D+1 ~00:20-03:30 UTC), e.g. 06:30 UTC.

**Option A - Windows Task Scheduler on this PC** (needs the PC on and wrangler logged in for this user):
```bat
schtasks /Create /TN "doppler-adsb-daily" /SC DAILY /ST 08:30 /TR "cmd /c cd /d C:\Users\hamdd\Workspace\Experiments\doppler_geoloc && python ref\data\daily_job.py >> .cache\daily_job.log 2>&1"
```
(08:30 local = 06:30-07:30 UTC. If the PC was off, the next run catches up the last 30 days. Remove with
`schtasks /Delete /TN doppler-adsb-daily /F`.)

**Option B - GitHub Actions:** copy `deploy/github-daily.yml.example` to `.github/workflows/daily-adsb.yml` in a
repository holding this project and add the secrets `CLOUDFLARE_API_TOKEN` (R2 edit) and `CLOUDFLARE_ACCOUNT_ID`.

## 2. Worker

> **A custom domain is required in production.** On `*.workers.dev` the Workers Cache API is a silent no-op
> (`cache.put` does nothing). Every request would then go to GitHub or adsb.lol, and users in one area would not share
> live snapshots (docs/SECURITY_REVIEW.md M1). Use `workers.dev` only for a quick smoke test.

1. In `worker/wrangler.toml`:
   * `routes = [{ pattern = "doppler-data.azemar.eu", custom_domain = true }]` and `workers_dev = false` (set).
     The zone must be on this Cloudflare account.
   * Set `ALLOWED_ORIGINS` to your real page origins.
     * Deployed value: `https://doppler.azemar.eu` plus the localhost dev origins. It is never `*`.
     * You may drop the localhost entries in production.
     * An origin that is not listed gets no `Access-Control-Allow-Origin` header.
   * Rate limits are four `[[ratelimits]]` bindings, applied per client IP (`CF-Connecting-IP`):

     | Route | Budget |
     |---|---|
     | tiles + index | 240/min |
     | range | 600/min |
     | live point | 30/min |
     | traces | 60/min |

     * These are mirrored in `LIMITS` in `worker/src/lib.js`, which also runs an in-isolate token bucket on every
       request.
     * Over budget, the Worker returns `429` with `Retry-After`. `web/engine/adsb.js` honours it.
     * `namespace_id`s are 91301-91304 (unique on this account). A WAF rate-limiting rule on the custom domain is an optional
       extra layer.
2. Deploy and check:
```bash
cd worker
node --test test/worker.test.mjs       # offline: cache-key normalisation, CORS allow-list, limiter
npx wrangler deploy                    # serves https://doppler-data.azemar.eu (custom-domain route)
W=https://doppler-data.azemar.eu
curl -s $W/health                                                                               # ok
curl -s -D - -o /dev/null -H "Origin: https://doppler.azemar.eu" $W/v2/point/41.52/2.10/25     # 200, ACAO, X-Server-Time-Ms
curl -s -D - -o /dev/null "$W/adsb/tile/2026-11-01/263364.json?x=1" | grep -i x-cache
curl -s -D - -o /dev/null "$W/adsb/tile/2026-11-01/263364.json?x=2" | grep -i x-cache            # HIT (on workers.dev: always MISS)
for i in $(seq 40); do curl -s -o /dev/null -w "%{http_code} " $W/v2/point/41.52/2.10/25; done  # ends in 429s
```
3. Build the Pages bundle against the custom-domain Worker (§3): `node deploy/build.mjs https://doppler-data.azemar.eu`.

Behaviour of the live routes:
* Point snapshots are cached at the edge for 5 s per 0.05° cell, so users in one area share upstream requests.
* Full traces are cached for 60 s and recent traces for 10 s.
* Every live response carries `X-Server-Time-Ms`, the edge time when it was served. The browser syncs its recording clock to it, so cached snapshots do not bias T_start.

## 3. Build the static bundle
```bash
node deploy/build.mjs https://doppler-data.azemar.eu  # the custom-domain Worker (not workers.dev)
```
* The script copies `web/` into `deploy/dist/`.
  * It **excludes** `web/tests/`, `web/dev/`, `*.md` and dotfiles.
  * `fixtures/` and `ref/` live outside `web/` and are never included.
  * The demo uses only `web/demo/scenario1/`: audio as 32 kbps AAC `.m4a` (4.6 MB, Safari-safe), tracks, measured events and terrain parameters.
* It writes the Worker origin into `deploy/dist/config.js`, where it becomes the default ADS-B proxy and enables "Record now", and into the CSP `connect-src` in `deploy/dist/_headers`.
* Output from the last local run: 50 files, about 5.2 MB.

Check the bundle locally before deploying:
```bash
cd deploy/dist && python -m http.server 8080      # open http://127.0.0.1:8080/ → Try the demo → fetch → search
```
(`python -m http.server` ignores `_headers`. Use `npx wrangler pages dev deploy/dist` to apply them locally.)

## 4. Pages
```bash
npx wrangler pages project create overhead --production-branch main
npx wrangler pages deploy deploy/dist --project-name overhead
```
Then add a custom domain in the dashboard if wanted, and remember to add it to the Worker's `ALLOWED_ORIGINS`.
The deployed Worker allows only `https://doppler.azemar.eu` (+ localhost). If Pages is served from another origin (e.g. `<project>.pages.dev`), add it to `ALLOWED_ORIGINS` and redeploy the Worker.

### Post-deploy checklist
* `curl -sI https://<project>.pages.dev/` shows the CSP, `Permissions-Policy` and `Cache-Control` from `_headers`.
* The browser console is free of CSP violations on: page load, Try the demo, Fetch flights, Run search, and switching basemaps.
* "Record now" is enabled, the microphone prompt appears, and stopping backfills tracks. Pages serves https, which `getUserMedia` requires.
* The footer and the "Data, privacy & licences" dialog show the adsb.lol ODbL, tile and terrain attributions, the privacy statement and the probabilistic-results disclaimer.

**Rollback:** `npx wrangler pages deployment list --project-name overhead`, then promote a previous deployment in the dashboard. For the Worker, run `npx wrangler rollback`.

## Headers, CSP and SharedArrayBuffer
`web/_headers` sets the following (each choice is explained in comments in the file):
* **CSP:** scripts come from self, `blob:` (the AudioWorklet of the recorder) and unpkg (Leaflet 1.9.4 with SRI). Tile and DEM origins are allowed. There is no `unsafe-inline` or `unsafe-eval`.
* `Permissions-Policy`: the microphone and geolocation are allowed for self only.
* HSTS and `nosniff`.
* Short revalidating caches for code, because file names are not hashed, and long caches for `data/` and `demo/`.

**No COOP/COEP (cross-origin isolation) is set, on purpose:**
* The engine (`web/workers/geoloc-pool.js`) uses `SharedArrayBuffer` only *opportunistically*, to share the whitened spectrogram Z with its workers. Without isolation it copies Z to each worker and still works. Measured: about 2.5 s robust and 0.7 s faithful in Firefox with 16 workers, not isolated.
* `COEP: require-corp` would block the Esri/OSM map tiles, which send no `Cross-Origin-Resource-Policy`, and any no-cors subresource.
* `COEP: credentialless` (Chromium 96+, Firefox 119+, **not Safari**) would allow the tiles, at the cost of browser-dependent behaviour.
* The cost of not isolating is memory: about the size of Z per worker. A 20-minute clip uses about 9 MB per worker, so roughly 150 MB with 16 workers.
* If isolation is wanted later, add these lines under `/*`:
  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
  ```
  Then verify the tiles, unpkg (it already sends CORS, and the tags have `crossorigin`), the DEM fetches and the Worker calls in all target browsers.
