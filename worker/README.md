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
