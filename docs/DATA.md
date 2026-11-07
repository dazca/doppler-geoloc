# DATA.md — data sources (Lane B)

Everything below comes from real requests made on 2026-11-03 (curl / Python / Node, from a home line in Spain)
unless it is marked *(docs)*. "CORS" means the `Access-Control-Allow-Origin` header on a real response to a
request sent with `Origin: https://example.pages.dev`.

## TL;DR

| Need | Choice | How the browser gets it |
|---|---|---|
| Historical ADS-B tracks | **adsb.lol `globe_history`** daily dumps on GitHub Releases. ODbL 1.0, no account, from 2023-02-16 to yesterday | **fast path**: pre-extracted per-cell/day non-jet track tiles in R2 behind a tiny **Cloudflare Worker** (`/adsb/tile`), loaded by `web/engine/adsb.js fetchTracksFromTiles` (0.1-0.6 s). **Generic path**: index shards plus Range proxy (`fetchTracks`, 1-100 s) |
| Aircraft type -> prop/jet/heli | The ICAO type designator is **inside every adsb.lol trace** (`"t":"C172"`). Designator -> category comes from **tar1090-db `icao_aircraft_types2.js`** (ICAO Doc 8643 description codes) and is written to `web/data/types.json` (72 KB, 10 KB gzipped) | a static file |
| DEM | **AWS Terrain Tiles, Terrarium PNG v1** at z12 (`s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`) | fetched directly (`ACAO: *`) by `web/engine/dem.js` |
| Geoid (ellipsoid -> MSL) | EGM96 through PROJ (`us_nga_egm96_15.tif`, fetched by PROJ_NETWORK) in Python. The browser gets one N per 0.5° cell, stored in each index shard | inside the shard JSON |

FlightRadar24 scraping is **for dev/test only and not allowed for the production SaaS** (it breaks FR24's ToS). It
also turned out to be useless here; see below.

## 1. Historical ADS-B: comparison (from real requests)

| Source | History | Time resolution | Auth | CORS (real header) | Licence / ToS for a SaaS | Verdict |
|---|---|---|---|---|---|---|
| **adsb.lol globe_history** (GitHub releases `adsblol/globe_history_<YYYY>`) | Daily from **2023-02-16** (first release `v2023.02.16-planes-readsb-test-0`). The day D release appears on D+1 around 00:20-03:30 UTC. 2023: 852 releases, 2024: 980, 2025: 946 | readsb `trace_full`: **median 2.0 s, p10 0.5 s, p90 7 s, p99 19 s** between points (LELL, measured). Prop/heli: median 2.7 s, p90 10 s | none. The GitHub API allows 60 req/h unauthenticated, but download URLs are predictable so no API call is needed | **none**, on both the `github.com` 302 and the signed `release-assets.githubusercontent.com` blob. Range requests work (`206`, `Accept-Ranges: bytes`) | **ODbL 1.0**: free, commercial use OK, requires attribution "adsb.lol contributors, ODbL" and share-alike for a *derived database* that is distributed | **CHOSEN** |
| adsb.lol live API `api.adsb.lol/v2/point/lat/lon/nm` | live only | ~1 s snapshot | none (adsb.lol is moving to API keys *(docs)*) | **none** (GET with Origin returns no ACAO; OPTIONS returns 405) | ODbL | live only, not useful |
| OpenSky REST | anonymous: **live only** (`/states/all?time=<2h ago>` -> `403 "Authenticate to get historical data"`; `/flights/all` -> `403 "You cannot access historical flights"`; `/tracks/all?time=<1 day ago>` -> `403 "You cannot access historical tracks"`). Authenticated (OAuth2 client credentials): states up to **1 h** back, tracks ≤ 30 days, flights batch-updated nightly *(docs)* | states 5-10 s; `/tracks` is waypoints only (coarse, "experimental") | account. 400 credits/day anonymous, 4000 registered | `Access-Control-Allow-Origin: https://opensky-network.org` (**not usable cross-origin**) | non-commercial / research. The historical Trino DB is for approved research only *(docs)* | no: needs an account, is non-commercial, and has no deep history over REST |
| OpenSky Trino / Impala | 2013 to now, full state vectors | 1 s state vectors | research account on application | n/a (SQL) | research only | dev only, if the owner gets access. This is the only free route for **pre-2023** (e.g. the LFMD 2022-07-17 case) |
| ADS-B Exchange | full history for subscribers only ("Historical backfills ... subscription customers only", no prices) *(docs)*. **Free samples: the 1st of every month only**: `samples.adsbexchange.com/readsb-hist/YYYY/MM/01/HHMMSSZ.json.gz` (worldwide snapshot every 5 s, 5-7 MB each, about 17,280 per day = ~100 GB/day) and `samples.adsbexchange.com/traces/YYYY/MM/01/<xx>/trace_full_<icao>.json` (same readsb format). Tested 200 for 2026-11-01 and 2026-10-01 | 5 s (hist), readsb trace | none for samples. `globe.adsbexchange.com/globe_history/...` returns `403 "Direct access to globe history data is not permitted."` | **none** | samples have no stated licence. Community API is "personal and non-commercial" | no, except as a 1st-of-month cross-check |
| airplanes.live | live only | 1 s | `403 "Please contact us at contact@airplanes.live ..."` on `/v2/point` (blocked without agreement) | none seen (403) | non-commercial; contact them | no |
| adsb.fi opendata `opendata.adsb.fi/api/v2/lat/../lon/../dist/..` | live only | 1 s | none, 1 req/s | **none** | "personal, non-commercial use only" *(repo README)* | no |
| FlightRadar24 (`nlevi-dev/FlightRadarScraper`) | see below | | needs a paid-account `accessToken` + browser UA. Cloudflare challenge on playback | live feed `ACAO: https://www.flightradar24.com` | **ToS forbids scraping. Dev/test only, never production** | no |
| FlightAware AeroAPI | history from 2011, per flight *(docs)* | ~ per minute | paid API key | n/a | commercial licence, pay per query | possible paid fallback |

### FlightRadarScraper evaluation (owner request)
I cloned it into an empty temp dir and read it all (249 lines). I did **not** run it: it needs a `config.json` holding a
FR24 `accessToken`, and it would scrape. What it does: `/api/v1/airport-history/<airportId>?date=&eventType=takeoff|landed`
-> flight numbers -> HTML-scrapes `/data/flights/<flightNumber>` -> **schedule/actual times per airport**. It has **no
positions or tracks at all**, so it cannot answer "region + historical day". My own probes: FR24's live zone feed
(`data-cloud.flightradar24.com/zones/fcgi/feed.js?bounds=...`) answers anonymously, but **live only** (17,808 aircraft,
`ACAO: https://www.flightradar24.com`). `api.flightradar24.com/common/v1/flight-playback.json` -> **403 Cloudflare
"Just a moment..."**. Region playback is a paid FR24 feature. Conclusion: adsb.lol is better on every axis.

### Related projects checked (read only, nothing run)
`amintt2/flyover-locator` and `mojomast/hermes-aircraft-doppler-geolocation` both stream the whole adsb.lol day
(~3-4 GB) for every new day, through `tarfile` and with no byte index. They use the geometric altitude **without** a geoid
correction (flyover has a manual `geoid_offset_m`), i.e. a ~30-50 m bias. Our pipeline adds a reusable byte-offset index
(any later bbox costs a few MB) and an EGM96 correction.

## 2. adsb.lol globe_history: exact layout

- Release tag: `v<YYYY>.<MM>.<DD>-planes-readsb-<feed>-0`. Feeds: `prod` (main, MLAT positions included as `"mlat"`
  source), `mlatonly` (a second instance, mostly MLAT/other aircraft: 28,763 traces on 2026-11-01), `staging`
  (fallback if prod is short; `prod-1` also exists per the docs).
- Assets: one plain (uncompressed) **POSIX ustar** tar, split at exactly **2,000,000,000 bytes**:
  `<tag>.tar.aa`, `<tag>.tar.ab` (prod), or a single `<tag>.tar` (mlatonly).
  Sizes: prod 2026-11-01 = 3.12 GB, 2026-09-08 = 3.87 GB, 2026-09-09 = 4.00 GB. mlatonly 0.3-1.0 GB.
- Members: `./traces/<last 2 hex>/trace_full_<icao>.json`. Each one is a **gzip-compressed JSON**, typically 5-150 KB
  (airliners ~100 KB, GA 10-40 KB), in filesystem order (not sorted). At the end there are `./heatmap/<n>.bin.ttf`
  (48 half-hour global position heatmaps) and `./acas/acas.{csv,json}.gz`.
  2026-11-01 prod: **56,670 traces**. 2026-09-08 prod: **79,049**.
- Example: the first member header sits at byte 1536 and its data starts at 2048 (`trace_full_861f3c.json`, 124,108 B).
- Trace JSON: `{"icao","r"(reg),"t"(ICAO type),"desc","dbFlags","timestamp"(= 00:00 UTC of the day),"version","trace":[...]}`
  Each point is `[dt_s, lat, lon, alt_baro_ft|"ground"|null, gs_kt, track_deg, flags, vrate_fpm, extra|null, source,
  alt_geom_ft, geom_rate_fpm, ias_kt, roll_deg]`.
  - `t = timestamp + dt_s`. Flags: `&1` stale (no position in the previous 20 s), `&2` start of a new leg,
    `&4` vrate is geometric, `&8` the altitude field is geometric.
  - `extra` (sometimes present) = the aircraft.json-style object (`flight` callsign, `squawk`, `category` A1..A7,
    `nic`, `nac_p`, `alt_geom`, ...).
  - `source`: `adsb_icao`, `mlat`, `tisb_*`, `adsr_*`, `mode_s`, `other` ...
  - **`alt_geom` is GNSS height referenced to the WGS84 ellipsoid** (readsb README-json). Barometric altitude is
    pressure altitude (1013.25 hPa reference).
- Partial download: HTTP Range works on the blob (`206`, e.g. `Content-Range: bytes 0-2047/2000000000`). There is **no
  member index** in a tar, so the **first** access to a day has to stream it all once (16-23 MB/s here -> ~4 min/day
  with 8 parse workers). That pass writes a byte-offset + spatial index. After that, **any bbox costs only the selected
  members** via Range.

### Altitude -> MSL (the contract's `alt_m_msl`)
1. If geometric altitude is present (most ADS-B v2 aircraft): `alt_msl = alt_geom_ft*0.3048 - N_EGM96(lat,lon)`.
   N is about **+49-50 m around Barcelona** and **about -32 m on Long Island**, so skipping the geoid correction would
   bias heights by that much. Remaining error: GNSS vertical ~5-15 m. Note that some older transponders report
   "geometric" altitude as MSL: undetectable, ±N.
2. Baro-only points (MLAT, old Mode S): `alt_msl = alt_baro_ft*0.3048 + median(geom_msl - baro)` over all points in
   the bbox that carry both, within ±30 min (a local, time-varying QNH/temperature correction). LELL 2026-11-01:
   88k calibration pairs, median offset **+57 m** (so raw pressure altitude would have been ~57 m too low). Residual
   error: tens of metres (depends on altitude because of temperature). If there are fewer than 5 pairs the raw pressure
   altitude is used (error ≈ 8.3 m per hPa of QNH deviation, up to ±250 m) and this is counted in `tracks.info.json`.
   Calibration pairs come only from points below 10,000 ft baro, because the geom-baro offset grows with height
   (temperature). Medians measured: LELL +57 m, Long Island +94 m (2026-09-08) / +101 m (2025-09-08), Santa Monica +4 m.
3. **TIS-B** positions (`tisb_*`, radar targets rebroadcast, non-ICAO `~xxxxxx` addresses): their "geometric"
   altitude is garbage (e.g. geom 4075 ft vs baro 1700 ft at the same instant), so baro + calibration is used instead.
   Points with duplicate or out-of-order timestamps (also seen with TIS-B) are dropped. A handful of TIS-B/ADS-R
   tracks still sit at negative MSL (min -506 m at KSMO); filter on `sources` if that matters.
4. Ground points (`"ground"`) are dropped. Points with no altitude at all are dropped.

The JS port uses one N per bbox (the average of the shard values) instead of N per point. Measured difference vs.
Python on identical track sets: LELL **max 1.3 m** over 89,030 points. KSMO/colsto with `skipJets` show **≤ 37 m**, only
on baro-calibrated (MLAT/TIS-B) points, because JS calibrates from the traces it downloaded (no jets) while Python used
all of them.

## 3. Pipeline (chosen): two browser paths

**A. Fast path (recommended for the product): pre-extracted cell tiles.** `ref/data/build_tiles.py` writes, per UTC day
and per 0.5° cell, all **non-jet** tracks (prop/heli/unknown, any altitude) already in contract format (MSL), gzip JSON,
to R2 `tiles/<date>/<cell>.json.gz`. The Worker serves them at `/adsb/tile/<date>/<cell>.json` (`Content-Encoding: gzip`,
CORS). `web/engine/adsb.js fetchTracksFromTiles({worker,bbox,t0,t1})` fetches the 4-6 cells of a bbox per day in
parallel, clips to bbox/window, merges an aircraft's pieces across cells and re-splits at gaps > 300 s.
`out.missing` lists cell-days that are not built yet.
Measured through `wrangler dev` (local R2), `node web/tests/adsb_tiles.mjs`:

| Case | Tiles | Size (gz) | Result | Latency cold / warm |
|---|---|---|---|---|
| LELL 8 h, 6 cells × 1 day | 6 | 376 KB/day | 73 tracks / 17,828 pts (Python non-jet: 70 / 17,602) | **107 ms / 48 ms** |
| Long Island 30 h, 4 cells × 2 days | 8 | 9.5 MB (5.3 + 4.2) | 1,351 tracks / 206,171 pts (Python: 1,487 / 206,178; 496 vs 497 aircraft) | **0.45 s / 0.59 s** (local; deployed adds transfer time for 9.5 MB) |

(Track counts differ slightly because of how cross-cell pieces are re-joined. Point counts match within 1%.)
Tile size scales with GA traffic: ~60 KB per quiet European cell-day, ~1-2.3 MB per NY-metro cell-day. Hourly tiles
would cut a 1-3 h query 8-20×. That is the obvious next step and was not done here. Building currently reuses
`fetch_adsb.py` per cell (15-50 s per cell from the cached index). A production builder would emit the tiles directly
inside the single stream pass (same 4-5 min/day, worldwide).

**B. Generic path (any type, any altitude): index shards + Range.** This is the diagram below. Use it for jets or
when tiles are missing.

```
 [daily, offline: owner's PC / GitHub Action / small VM]                 [browser]
 adsb.lol tar (3-4 GB) --stream once--> fetch_adsb.py STREAM               web/engine/adsb.js fetchTracks()
   -> .cache/adsb/<tag>.idx.json.gz (byte offsets + per 0.5° cell             1. GET worker/adsb/index/<tag>/<cell>.json  (6 cells for a 75 km bbox)
      [tmin,tmax,minAltFt] per trace; 25-35 MB/day gz)                       2. choose traces in window, low enough, optionally not jets
   -> build_index.py -> per-cell shards -> R2 (worker binding INDEX)       3. GET worker/adsb/range?tag&part&start&end  (one gzip member each)
                                                                           4. gunzip (DecompressionStream) -> contract tracks (+baro cal, geoid N)
 Cloudflare Worker (worker/src/index.js): CORS + 1-year edge cache, only the adsblol/globe_history_* tags, ranges ≤ 8 MiB
```

Sizes and latencies (measured):
- Index for one day: prod 56-79k traces -> **24-27 MB gz** (single file). mlatonly 7.7-9.6 MB. As per-cell shards:
  **25,951 shards, 158 MB raw JSON** per prod day worldwide (≈ 30-40 MB gzipped). One bbox of ~75×65 km = **6 shards ≈
  250 KB (prod) + 100 KB (mlatonly)**.
- LELL bbox, 8 h window: 319 prod + 110 mlatonly traces selected (≤ 20,000 ft) = **38.8 MB** in 429 range requests:
  **2.8 s + 0.8 s from Python directly, 11.3 s through the local Worker** (`wrangler dev`, cold cache). With
  `skipJets: true` (the shard carries the type) it drops to **60 traces / 1.3 MB**. With no altitude limit and all
  types: 999 traces / 85 MB.
- Worker range call: 0.61 s cold, **0.02 s** from cache (local `wrangler dev`).
- Path B end-to-end in JS through the local Worker (`node web/tests/adsb_worker.mjs http://127.0.0.1:8787`, same tracks
  as Python): LELL all types 429 fetches **6.4-11 s**. LELL `skipJets` 60 fetches **1.2 s cold / 0.5 s warm**. Long Island
  30 h `skipJets` 1,304 fetches **31 s cold / 13 s warm**. KSMO 13 h `skipJets` 1,935 fetches **24-99 s** (it varies with
  GitHub). So path B is fine for small/quiet cases but too slow for busy US areas, hence path A.
- First access to a new day (no index yet): 3-4 GB, ~4 min prod + ~1 min mlatonly on a 20 MB/s line with 8 cores,
  peak RAM ~1-2 GB. This cannot run in a Worker (CPU limits), so it has to happen offline. It is the main
  operational cost.

Cost to cover all history: ~1,000 days × ~5 GB ≈ **5 TB of download** in total (5 GB/day), about 3-4 days
of continuous streaming. Storage is ~35 MB gz of shards per day ≈ 35 GB for 1,000 days (R2 free tier = 10 GB, then
$0.015/GB-month ≈ $0.50/month). A cheaper option is lazy building: index a day the first time a user asks for it
(the user waits ~5 min) through a queue job on a small VM. Cloudflare Containers might also work (not tested).

## 4. Real-case results

All produced with `ref/data/fetch_adsb.py`, feeds prod+mlatonly, **all altitudes and types** (`--max-alt-ft 99999`,
except LELL: 20,000 ft). Sampling = time between consecutive points in a track.

| Case | Window (UTC) | Tracks / aircraft | Categories | Tracks <1500 m: prop (aircraft) / heli | dt p10/50/90/99 (s) all; low-prop | Fetch time |
|---|---|---|---|---|---|---|
| `lell_20261101` (Sabadell, bbox 41.2,1.7–41.9,2.5) | 2026-11-01 07–15 | 754 / 279 | jet 684, prop 47, heli 11, unk 12 | 40 (20) / 11 | 0.5/2.0/7.3/18.8; 0.5/2.7/9.6/19.3 | first stream 12.6 min (single-threaded v0; ~5 min now with 8 workers); then 17-26 s (index) |
| `colsto_longisland/tracks_2026.json` | 2026-09-08 00 → 09-09 06 | 5,410 / 2,278 | jet 3923, prop 1081, heli 226, unk 180 | 993 (287) / 226 | 0.5/2.0/7.8/19.8; 0.8/2.9/9.7/19.8 | 10 min stream (2 days); 76 s (index) |
| `colsto_longisland/tracks_2025.json` | 2025-09-08 00 → 09-09 06 | 6,057 / 2,329 | jet 4615, prop 1183, heli 160, unk 99 | 1091 (273) / 160 | 0.5/1.9/7.5/19.8; 0.9/3.1/10.5/19.9 | 14 min stream; 81 s (index) |
| `ksmo_2024-07-09` (Santa Monica) | 2024-07-09 14 → 07-10 03 | 3,956 / 1,754 | jet 2107, prop 1262, heli 236, unk 351 | 1122 (295) / 236 | 1.5/3.5/9.9/19.8; 1.5/4.0/11.3/19.9 | ~10 min stream; 44 s (index) |

Ground truth check: **all 25 tail numbers listed in the KSMO video description** (N796SP C172, N201XQ Mooney, N67CM
C310, N355JS S-76, N36PJ PC-12, ...) are present in `ksmo_2024-07-09/tracks.json` (field `reg`).
Top low prop types: Long Island P28A/C172/PC12/SR22/C152, KSMO C172/SLG4/P28A/C72R/SR20, LELL P208/SIRA/PIVI/C208.
2024 traces are sampled more coarsely (median 3.5 s vs 2.0 s in 2025-26).
Not fetched: `lfmd_2022-07-17` (adsb.lol starts 2023-02-16) and `sunderland_heli` (50-day window, unknown date: ~250 GB to
stream once; the index then makes any sub-window cheap).
Each `tracks*.info.json` holds the alt-source counts (`geom` / `baro_cal` / `baro_raw`), the calibration offset and timings.

## 5. Aircraft type database

- `ref/data/aircraft_types.py` -> `web/data/types.json`: **2,788 designators**, `{"C172":["prop","L1P","L"], ...}`
  (category, ICAO Doc 8643 description code, wake category). **71.8 KB, 10.2 KB gzipped.** Counts: prop 2141, jet 450,
  heli 181, unknown 16 (gliders, balloons).
  Rule: kind `H`/`T`(tiltrotor) -> heli. Engine `J` -> jet. Engine `P`(piston)/`T`(turboprop)/`E`(electric) -> prop. Anything else -> unknown.
  The code's 3rd character separates piston from turboprop (useful as an F0 prior).
- Source: `raw.githubusercontent.com/wiedehopf/tar1090-db/master/db/icao_aircraft_types2.js` (gzip JSON despite the
  `.js` name; `ACAO: *`, so the browser could fetch it live too).
- icao24 -> type is **not needed** for adsb.lol data (each trace has `t`, `r`, `desc` from the same tar1090-db).
  If needed anyway: `tar1090-db` branch `csv` `aircraft.csv.gz` (8.2 MB, 623,847 rows, `icao;reg;type;flags;desc;...`).
  The compact `{icao:type}` map is 495k entries = **7.8 MB, 1.9 MB gz**. That belongs in a Worker/KV, not the page.
  tar1090 also serves per-prefix shards (`db/<prefix>.js`, ~20-200 KB) with CORS.
- Fallback when the type is unknown: ADS-B emitter category `A7` (rotorcraft) -> heli (LELL 2026-11-01: 2 of the 11 heli
  tracks had no type and were classified by this rule).
- Licence: tar1090-db has no LICENSE file. Its data comes from the Mictronics aircraft database. **Check its terms
  before redistributing** the per-icao map. The designator table is ICAO Doc 8643 factual data.

## 6. DEM

| Source | Tested | CORS | Notes |
|---|---|---|---|
| **AWS Terrain Tiles Terrarium v1** `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` (also `elevation-tiles-prod.s3.amazonaws.com/...`) | yes | **`*`** | 256² 8-bit RGB PNG, z0-15, ~40-130 KB/tile. `elev = R*256 + G + B/256 - 32768`. **CHOSEN** (z12: ~29 m px at 41°N) |
| Terrarium **v2** (`.../v2/terrarium/...`) | yes | `*` | smaller files, but **worse**: -234 m at sea off Barcelona (bathymetry), -8 m at Tibidabo. Not used |
| AWS GeoTIFF tiles (`.../geotiff/{z}/{x}/{y}.tif`) | header only | `*` | would need a TIFF decoder; no gain |
| **Copernicus GLO-30 COG** `copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N41_00_E001_00_DEM/...tif` | yes (rasterio /vsicurl, 0.3-3 s/point cold) | **none** | best quality (DSM). Needs the Worker to reach it from a browser plus a COG reader. Used here as the **validation reference** |
| OpenTopography API | not tested | n/a | needs an API key. Not needed |

`web/engine/dem.js` (no dependencies, browser + Node 22): fetch tile -> own tiny PNG decoder (`DecompressionStream`,
which also avoids canvas colour-management corruption) -> Float32 grid -> bilinear on global Web-Mercator pixel
centres (seamless across tiles) -> LRU tile cache (512). API: `createDem({zoom}).elevations([[lat,lon],...])`,
`.grid(lat0,lon0,lat1,lon1,nLat,nLon)`, `.elevation(lat,lon)`.

Validation (`node --test web/tests/dem.test.mjs`: 4 offline tests on saved tiles in `fixtures/dem/` pass, plus 2 live tests with `DEM_NETWORK=1`, also passing):

| Point | Published | Terrarium z12 | z13 | Copernicus GLO-30 |
|---|---|---|---|---|
| Tibidabo 41.42194, 2.11861 | 512 | 509.3 | 509.9 | 509.5 |
| Montserrat Sant Jeroni 41.6050, 1.8119 | 1236 | 1201.9 | 1201.2 | 1200.2 |
| Aneto 42.63111, 0.65667 | 3404 | 3381.1 | 3382.3 | 3363.4 |
| Sabadell LELL 41.5209, 2.1050 | 148 (AIP ARP) | 140.2 | 140.1 | 142.0 |
| Sea 41.30, 2.40 | 0 | 0.0 | 0.0 | 0.0 |

Terrarium agrees with Copernicus to within **~2 m** on non-summit points. Sharp summits are smoothed by 20-35 m at
30 m resolution (the coordinates are also approximate). Performance: a 50×50 km, 101×101 grid needs 64 z12 tiles,
**0.9 s cold, 27 ms cached**.

## 7. Recipes

```bash
# tracks for any bbox/window (first call on a day streams + indexes it; later calls use Range requests)
python ref/data/fetch_adsb.py --bbox 41.2,1.7,41.9,2.5 --start 2026-11-01T07:00Z --end 2026-11-01T15:00Z \
       --out fixtures/real/lell_20261101/tracks.json [--feeds prod,mlatonly] [--max-alt-ft 20000] [--max-alt-m 3000]
python ref/data/fetch_adsb.py --meta fixtures/real/<case>/meta.json --max-alt-ft 99999   # bbox+date_utc_window from meta
# -> tracks.json (contract; extra keys reg/desc/sources) + tracks.info.json (alt-source counts, baro offset, dt stats)

python ref/data/aircraft_types.py                       # -> web/data/types.json
python ref/data/build_index.py .cache/adsb/<tag>.idx.json.gz --out .cache/shards [--bbox ...]
python ref/data/build_tiles.py --bbox <bbox> --date 2026-11-01 [--date ...] --out .cache/tiles   # fast-path tiles
# upload: npx wrangler r2 object put doppler-adsb-index/tiles/<date>/<cell>.json.gz --file .cache/tiles/<date>/<cell>.json.gz
node --test web/tests/dem.test.mjs                       # DEM validation, offline fixtures; DEM_NETWORK=1 adds live tests
node web/tests/adsb_worker.mjs [http://127.0.0.1:8787]   # JS fetchTracks vs Python (mock worker or wrangler dev); env CASE, TRACKS, SKIP_JETS, MAX_ALT_FT
node web/tests/adsb_tiles.mjs http://127.0.0.1:8787      # fast path latency (needs tiles in local R2)
python -m pytest ref/tests/test_data_adsb.py             # offline trace-conversion tests
```
Raw access without our code: `curl -L -r <start>-<end> https://github.com/adsblol/globe_history_2026/releases/download/<tag>/<tag>.tar.aa | gzip -dc`.

## 8. ToS / open decisions for the owner
1. **adsb.lol ODbL**: show "ADS-B data © adsb.lol contributors, ODbL 1.0" in the UI. If we publish our derived index we
   must publish it under ODbL too (fine). Being polite: a descriptive User-Agent, caching, and no re-download of days.
   It is worth telling adsb.lol about the use (they offer API keys and may want the index).
2. **Index hosting**: something has to stream each day once (3-4 GB). Options: (a) the owner's PC on demand, (b) a daily
   GitHub Action (7 GB disk / free minutes are OK for ~5 min/day; nothing stored in GitHub except the R2 upload), (c) a
   small VM. R2 bucket `doppler-adsb-index` needs creating. Free tier: 10 GB = ~300 days of gz shards.
3. **Pre-2023 dates** (e.g. `lfmd_2022-07-17`): there is no free source. Options: an OpenSky research account (Trino,
   non-commercial), the ADSBx paid backfill, or FlightAware AeroAPI (paid).
4. **GA coverage caveat**: in Europe many GA aircraft have no ADS-B out. They appear only via MLAT (baro altitude, ~5-10 s,
   needs ≥4 receivers) or not at all. LELL 2026-11-01 08-16 local: only 26 prop/heli aircraft were seen in a 75 km box.
5. FR24 scraping: dev/test only. Not used anyway.

## 9. Robustness and coverage check (B2, after the Lane K report)

- **Missing release** (e.g. no `mlatonly` before ~2024-03, or a day not published yet) now produces a warning, not a
  fatal error: `MissingRelease` → `stats.days[] status "missing"`. For days older than D-2 a
  `.cache/adsb/<tag>.missing` marker is written so GitHub is not asked again. In JS, a 404 shard/tile means "not
  indexed" and is skipped.
- **Partial days**: `day_status()` compares the day's trace count with the median of cached days of the same feed
  within ±200 days. With none cached it falls back to a table of measured complete days. `partial` means below 65 %
  (prod) or below 20 % (mlatonly, which varies a lot); `empty` means 0 traces. Result: 2026-06-11 prod is **partial**
  (42,314 vs ~71,600, ratio 0.59) and mlatonly is **empty**. 2023-12-17 prod is ok (41,515) and its mlatonly is
  **missing**. The statuses go to `tracks.info.json` (`days`, `warnings`). `build_index.py` also publishes
  `<tag>/day.json` so the browser can read it (`fetchDayStatus`, Worker route `/adsb/index/<tag>/day.json`).
- **Memory**: stream parsing is now back-pressured: at most 2×workers batches of 64 members are in flight.
  Previously `Pool.imap` could queue the whole tar when parsing lagged the download. Workers are capped by free RAM
  (~0.25 GB each + 1.5 GB). Unreadable or `MemoryError` members are counted (`n_bad_members`) and do not abort. The
  index is written cell by cell, and index-mode traces are parsed as they arrive. This is bounded by design but was not
  stress-tested under real RAM pressure.
- **Coverage check** (Python `coverage_report` / `coverage_from_tracks` / `coverage_from_index` /
  `coverage_baseline` / `coverage_verdict`; JS `coverage` / `coverageBaseline` / `coverageVerdict`):
  - It counts non-jet tracks and aircraft with ≥ 1 point below 1500 m MSL within `radius_km` (default 5) of the site,
    per hour.
  - Python adds a coarse baseline from cached indexes: non-jets below 5000 ft in the bbox cells at the same UTC time
    on up to 12 other cached days, with no download. JS takes its baseline from the fast-path tiles of ±1-4 weeks.
  - `level: ok | weak | poor` plus ready-to-show messages. The level comes from the **rate** of low non-jet tracks
    within 5 km and below 1500 m, computed over the recording's plausible window only: **< 1/h poor, 1–3/h weak,
    > 3/h ok**. This changed in B4: Egelsbach 2023-09-12, 4 aircraft in 4.5 h = 0.9/h, used to be reported as ok.
    Poor and weak messages also say that aircraft without ADS-B (many GA in the circuit) cannot be matched, so the user
    should mark only flyovers likely to be transponder-equipped. Baseline and partial-day checks still apply on top.
  - Measured around LELL (5 km):

    | Window | Low light aircraft near site | Coarse count today | Baseline median | Verdict |
    |---|---|---|---|---|
    | 2026-11-01 07-15 | **47 tracks / 21 aircraft** (5.9/h, matches Lane K) | 28 | 18 | ok |
    | 2023-12-17 09-13 | 0 | 1 | 16 | poor |
    | 2026-06-11 14-16:30 | 0 | 4 | 11 | poor; also partial prod and empty mlatonly |

  - `fetch_adsb.py` prints `WARNING coverage: ...` and stores everything under `coverage` in `tracks.info.json`.
    `--site lat,lon --site-radius-km 5`.
- **DEM retries**: `createDem({retries=4, retryBaseMs=250, fallbackElevation})` retries network errors, 429 and 5xx with
  exponential backoff. If `fallbackElevation` is a number, a tile that still fails becomes flat (listed in
  `stats.failedTiles`) instead of aborting the search. The default still throws after the retries. `adsb.js` uses the
  same `fetchRetry`. A failed trace or tile is recorded in `out.failed` / `out.missing`, not thrown.
- Offline tests: `python -m pytest ref/tests/test_data_adsb.py` (8 pass), `node --test web/tests/adsb.test.mjs
  web/tests/dem.test.mjs` (10 pass, 2 live tests skipped unless `DEM_NETWORK=1`).


## Reported velocity (`vel`, optional, D15)
Tracks from `ref/data/fetch_adsb.py` / `web/engine/adsb.js` now carry an optional per-track array `vel`, aligned with
`points`: `[gs_mps, track_deg_true, vrate_mps]` from readsb trace fields 4 (ground speed, kt), 5 (track, deg) and
11 (geometric vertical rate) or 7 (baro rate), ft/min; nulls where missing. MLAT-only aircraft usually have no track angle
and sometimes implausible speeds; the engine ignores speeds above 150 m/s for non-jets. The engine (`web/engine/geoloc/track.js`)
uses the lag-corrected (+2.75 s, Lane F) reported velocity as Hermite tangents across ADS-B gaps > 20 s and flags a gap as
uncertain only if those end velocities require more than ~2 m/s^2 of manoeuvre.

## 10. Deployed backend (2026-11-07)
- Worker `doppler-geoloc-data` at `https://doppler-data.azemar.eu` (custom domain), R2 bucket `doppler-adsb-index`.
- Coverage: Catalonia + Andorra, 42 cells of 0.5° (lat 40.0-43.0, lon 0.0-3.5), last ~30 UTC days, both feeds.
- Built by `ref/data/daily_job.py` in ONE stream pass per feed and day (the region's legs are kept in the pass, so no
  per-cell Range re-download as in `build_tiles.py`). Per day: tiles (42, ~1.8 MB gz total), index shards (2 × 42,
  ~1.1 MB), 2 `day.json`. Baro calibration is per cell (all aircraft incl. jets, as in `build_tiles.py`); jets are
  kept in the pass only as calibration points, so memory stays small.
- Measured 2026-11-06: 4.9 GB streamed (prod 3.82 + mlatonly 1.08), 75,277 + 36,872 traces, 1,291 non-jet tile
  tracks; 13 min end to end (prod 9.7 min at 4-6 MB/s from GitHub that hour, mlatonly 2.2 min, tiles 6 s, upload of
  128 objects 37 s). Later runs reached ~27 MB/s.
- `stream_day(process=...)` lets a caller replace the parse function; `<tag>.counts.json` (trace count) is written
  next to every index and is what `reference_traces` uses once the big index is deleted.
