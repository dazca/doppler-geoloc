# doppler-geoloc-data Worker (deployed: https://doppler-data.azemar.eu, see deploy/README.md)

Why: adsb.lol `globe_history` lives on GitHub release assets. Neither `github.com/.../releases/download/...`
(302) nor the signed `release-assets.githubusercontent.com` blob sends `Access-Control-Allow-Origin`, so a
browser cannot read them. Everything else the app needs already sends `ACAO: *` (AWS Terrarium DEM tiles,
raw.githubusercontent.com for tar1090-db / types). This Worker only proxies byte ranges of those tars, plus
serves pre-built index shards from R2.

Endpoints
- `GET /adsb/range?tag=<tag>&part=aa&start=<n>&end=<m>` -> 206 bytes of `<tag>.tar.<part>` (≤ 8 MiB), edge-cached 1 year.
- `GET /adsb/index/<tag>/<cell>.json` -> R2 object `<tag>/<cell>.json` (built by `ref/data/build_index.py`).
- `GET /adsb/tile/<YYYY-MM-DD>/<cell>.json` -> R2 `tiles/<date>/<cell>.json.gz` (built by `ref/data/build_tiles.py`), served gzip. **Fast path.**
- `GET /health`.

Index shards must be built offline (a Worker cannot stream+gunzip a 3.5 GB day within CPU limits):
`python ref/data/fetch_adsb.py ...` (first run on a day streams it and writes `.cache/adsb/<tag>.idx.json.gz`),
then `python ref/data/build_index.py .cache/adsb/<tag>.idx.json.gz --out .cache/shards [--bbox ...]`, then upload
with `npx wrangler r2 object put doppler-adsb-index/<tag>/<cell>.json --file .cache/shards/<tag>/<cell>.json`.
For production this would be a daily GitHub Action / cron box (see docs/DATA.md "Pipeline").

## Hardening (SECURITY_REVIEW M1)
- **Cache keys:** rebuilt from validated fields only (`src/lib.js parseRoute`), e.g.
  `https://cache.internal/adsb/range/<tag>/<part>/<start>-<end>`.
  - Extra or reordered query params cannot force a miss.
  - Responses carry `X-Cache: HIT|MISS`.
  - Cache writes use `ctx.waitUntil`.
  - R2 misses (tile/index "not built yet" 404) are cached 300 s (coverage manifest: 60 s) to save R2 reads.
  - On a hit the route's own `Cache-Control` is re-applied (the zone's 4 h Browser Cache TTL rewrites stored copies).
- **Errors:** a throwing upstream fetch / R2 read returns `502 {"error":"upstream error"}` with CORS and `Retry-After: 5`.
- **Rate-limit key:** IPv4; IPv6 by /64; IPv4-embedded IPv6 (`::ffff:a.b.c.d`, NAT64 `64:ff9b::a.b.c.d`) by the IPv4.
- **Licence headers:** R2-served data carries `Link: <https://opendatacommons.org/licenses/odbl/1-0/>; rel="license"`
  and `X-Source: adsb.lol` (both CORS-exposed).
- **Rate limits:** per IP and per route. `[[ratelimits]]` bindings run alongside an always-on in-isolate token
  bucket. Over budget → 429 with `Retry-After`.
- **CORS:** an explicit allow-list (`ALLOWED_ORIGINS`; wildcard subdomains are supported). The default is not `*`.
- **Custom domain:** the Cache API is a no-op on `*.workers.dev`, so production needs one (deploy/README.md §2).
- **Tests (offline):** `node --test worker/test/worker.test.mjs`.

- **Upstream retry (`/adsb/range`):** GitHub's release CDN intermittently answers 5xx/504 or resets. The Worker tries
  3 times (waits 200 ms, 600 ms) and only then returns `502` with `Retry-After: 5`. 404/416 are final.

## Human sessions (Turnstile)
Goal: only people using the app (not scripts) get data. Code is deployed but **inert** until the steps below are done.
- `POST /session {"token": <Turnstile token>}` (allowed `Origin` only, 10/min per IP) → siteverify (`secret`, token,
  `remoteip`; `hostname` must equal the Origin's host and `action` must be `session`) → `{session, exp}`.
- Session token: `v1.<base64url {id, ip, exp}>.<HMAC-SHA256(SESSION_KEY)>`, valid 2 h, only from the same IPv4 or
  IPv6 /64. Stateless: nothing stored.
- `SESSION_MODE` (wrangler.toml var): `off` (header ignored) / `grace` (checked when sent, missing allowed) /
  `enforce` (every data route needs `X-Doppler-Session`, else `401 {"code":"session"}`). The check runs BEFORE the
  cache, so cached data is never served without a session. `enforce` without `SESSION_KEY` fails closed (503).
- Open in every mode: `/health`, `/adsb/index/meta/coverage.json` (public list of days; the app reads it on load and
  `.github/workflows/backfill.yml` reads it without credentials).
- Per-session budgets (same numbers as per IP, key `s:<id>`) apply on top of the per-IP ones.
- The browser side is `web/ui/data-session.js` (one invisible/managed Turnstile run per page session, renews before
  expiry and once on a 401). The data pipeline never uses the Worker for "day done" checks: it reads R2 directly.
- Trade-off: the custom header makes browsers send a CORS preflight; it is cached per URL (Chrome up to 2 h), so a
  first search costs up to ~2x Worker requests.

Turning it on (owner; needs the Cloudflare dashboard, the wrangler OAuth token has no Turnstile scope):
1. Dashboard → Turnstile → Add widget: name `doppler`, hostnames `doppler.azemar.eu` and `localhost`,
   widget mode **Managed**, pre-clearance off. Copy the site key and the secret key.
2. Store the secret without echoing it: `cd worker && npx wrangler secret put TURNSTILE_SECRET` (paste at the
   prompt). `SESSION_KEY` is already set (2026-11-08); rotate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put SESSION_KEY`
   (rotation logs everyone out once; the app renews automatically).
3. Build and deploy the app with the site key (it starts sending sessions; the Worker still ignores them):
   `node deploy/build.mjs https://doppler-data.azemar.eu <SITE_KEY>` then the Pages deploy (deploy/README.md §4).
4. Set `SESSION_MODE = "grace"`, `npx wrangler deploy`, use the app once (search + live); then `"enforce"` and deploy.
5. Check: `curl -s -o /dev/null -w "%{http_code}" https://doppler-data.azemar.eu/adsb/tile/2026-11-06/263364.json` → 401.
   Roll back at any time with `SESSION_MODE = "off"` + deploy.

## Local test plan
1. `cd worker && npx wrangler dev` (R2 is simulated locally; put a shard with
   `npx wrangler r2 object put doppler-adsb-index/<tag>/<cell>.json --file ... --local`).
2. Range proxy:
   `curl -s -D - -H "Origin: http://localhost:8000" "http://localhost:8787/adsb/range?tag=v2026.11.01-planes-readsb-prod-0&part=aa&start=2048&end=126155" -o m.gz`
   expect `200`, `Access-Control-Allow-Origin: http://localhost:8000` and `X-Cache: MISS`, then `HIT` when repeated with junk params, and `gzip -dc m.gz | head -c 200` shows `{"icao":"861f3c",...`
   (offsets from the tar header at 1536 seen in docs/DATA.md).
3. Validation: bad tag -> 400; `end-start` > 8 MiB -> 413; repeat request -> served from cache (check `cf-cache-status`/timing).
4. Index: `curl http://localhost:8787/adsb/index/<tag>/<cell>.json` -> JSON shard; unknown cell -> 404.
5. Fast path: upload tiles (`npx wrangler r2 object put doppler-adsb-index/tiles/<date>/<cell>.json.gz --file ... --local`), then
   `node web/tests/adsb_tiles.mjs http://127.0.0.1:8787` (measured: LELL 107 ms cold, Long Island 30 h 0.45 s).
6. End-to-end generic path: `node web/tests/adsb_worker.mjs http://localhost:8787` (calls `fetchTracks` from web/engine/adsb.js and
   compares with fixtures/real/lell_20261101/tracks.json).
7. Preflight: `curl -X OPTIONS -D - http://localhost:8787/adsb/range` -> 204 with CORS headers.

Limits to keep in mind (check current CF docs): free plan 100k requests/day, 50 subrequests per invocation
(we use 1-2), Cache API is per-colo. Abuse surface: only adsblol/globe_history_* tags are reachable, ranges capped.
