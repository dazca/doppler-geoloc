# Lane L report: live mode feasibility

**Verdict: feasible, and simpler than expected. It needs a small CORS proxy, and production use needs adsb.lol's OK.**
The past ~24 h of any aircraft's track is available live from adsb.lol through per-aircraft `trace_full` and `trace_recent` files. So the browser does **not** need to build tracks from 1 Hz polling. It only has to *discover* which aircraft were around. Polling `/v2/point` every 15–30 s during the clip is enough for that. After the clip it fetches each nearby aircraft's trace.

With T_start known from the device clock, **one event is enough**. I ran an end-to-end test on real live tracks with a synthetic pass. One event gave a **5 m** error with T_start known, and it still gave 5 m with T_start biased by +2 s. With T_start unknown, the same case went **3 km wrong** with the wrong flight.

Nothing was deployed. The only proxy used was a local Node dev proxy.

All numbers come from real requests made on 2026-11-04 from a home line in Spain, around Sabadell/Barcelona (41.52, 2.10, radius 25 nm). Here "CORS" means the `Access-Control-Allow-Origin` header returned for a request sent with `Origin: https://example.pages.dev`.

## 1. API comparison (L1)

| Source | Live snapshot endpoint | Tested result | CORS | Rate limit (observed / stated) | Past tracks? | ToS for a SaaS |
|---|---|---|---|---|---|---|
| **adsb.lol** | `api.adsb.lol/v2/point/{lat}/{lon}/{nm}` (also `/v2/lat/../lon/../dist/..`, `/v2/hex/{hex}`, `/v2/closest`, ...; OpenAPI at `/api/openapi.json`) | 200, readsb `aircraft.json` format `{ac:[...], now (ms), ctime, total}`. RTT p10/50/90 = 84/140/296 ms | **none** (GET has no ACAO; `OPTIONS` → 405) | No rate headers on the re-api. **At one poll per 2 s, 193 of 294 requests got 429** (only 101 were 200). At one per 5 s, 20 of 20 were 200 | **Yes**: `adsb.lol/data/traces/{xx}/trace_full_{hex}.json` (last ~24 h, e.g. a span of 85,025 s) and `trace_recent_{hex}.json` (last ~2–5 min at ~1 s). Both are gzip readsb trace format. Header `x-ratelimit-limit: 30, 30;w=1, 900;w=60` (30/s, 900/min) | ODbL 1.0. API ToS: *"You can use the API for free. In the future, you will require an API key which you can get by feeding to adsb.lol. If you want to use the API for production purposes, please contact me so I do not break your application by accident."* (api.adsb.lol OpenAPI `info.description`) |
| adsb.fi | `opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{nm}` (v2 is deprecated) | 200, same readsb format, `now` in ms (v3). In the 10-min run the snapshot age was **p50 0.68 s, p90 1.5 s** (adsb.lol: 0.11 / 0.30 s) | **none** (`OPTIONS` → 405) | stated: *"rate limited to 1 request per second"*. *"Requests returning a 400, 401, 403, 404, or 429 status code count toward the limit."* | **No**: `globe.adsb.fi/data/traces/...` → 403 | *"adsb.fi open data is for personal, non-commercial use only."* *"You may not license, sell, rent, or lease any part of the data or the service."* *"You must cite adsb.fi and include a link to our home page."* *"Please contact us if you have commercial or higher request rate requirements."* (github.com/adsbfi/opendata) |
| airplanes.live | `api.airplanes.live/v2/point/...` | **403** `"Please contact us at contact@airplanes.live. Your email MUST include any links, a description of the project..."` | n/a | 1 req/s per its API guide (from a search snippet; the guide page itself returned 403 to WebFetch) | No: `globe.airplanes.live/data/traces/...` → 403 | The guide lists "No SLA, No Uptime Guarantee, Non-Commercial Use" (search snippet) |
| OpenSky `/states/all` (anonymous) | `opensky-network.org/api/states/all?lamin..` | 200, state vectors. `X-Rate-Limit-Remaining: 398` | `https://opensky-network.org` only (**not usable cross-origin**) | 400 credits/day; a bbox ≤ 25 sq° costs 1 credit. So at most 400 polls per day per IP. *"Time resolution is 10 seconds"* | No: *"Only the most recent state vectors are available - the time parameter is ignored"* for anonymous users | Non-commercial / research (see DATA.md) |
| ADS-B Exchange globe | — | `globe.adsbexchange.com/data/traces/...` → 403 "Request forbidden by administrative rules" | — | — | — | paid API only |

### Measurements from the 10-min run (`web/tests/live_poll.mjs`, 10:32–10:42 UTC)

- **Traffic:** 47 aircraft were seen, 24–31 per snapshot. 22 of them flew below 3000 m and were backfilled: 44 trace requests, 0 failures, 14.3 s at 4 req/s.
- **Polled tracks:** median 2.08 s between distinct positions (p90 39.5 s, inflated by the 429 gaps).
- **Trace tracks, last 30 min before the clip plus the clip:**
  - Spacing between points: p10/50/90 = **0.96 / 3.0 / 13.6 s**. Lane A showed that 10–30 s decimation costs only 0–31 m.
  - Coverage per aircraft: median **26 min** of the 30 requested, p90 40 min.
  - `trace_full` itself lags real time by ~1–2 min. The trace's `last-modified` header was 2 min old, and an aircraft's last full-trace point was 131 s old. `trace_recent` fills that gap.
- **Polled vs trace positions at the same instants (908 pairs):** horizontal p50/90/99 = **4.2 / 9.5 / 16.6 m**, vertical p50/90 = 2.4 / 8.0 m. The two sources agree, and so does `traceToTracks`.
- **Latency vs real time:**
  - Per-aircraft `seen_pos` (age of the last position at snapshot time): p10/50/90 = **0.04 / 0.35 / 9.8 s**. The long tail is MLAT or sparse aircraft.
  - Snapshot age at receipt after clock correction: p50 **0.11 s** (adsb.lol) and 0.68 s (adsb.fi).
  - Position timestamps are reconstructed as `now − seen_pos`, so that age does not bias them.
  - What cannot be observed from the API is the delay between the aircraft's true position time and the aggregator's receive timestamp: feeder network plus MLAT solve, typically 0.1–1 s. DO-260B allows ≤ 1.5 s total position latency.
  - Lane F found a 2.75 s ground-speed lag. That is a velocity-filter effect; we use positions, not `gs`. So the design keeps a **±3 s T_start tolerance**.
- **Clock:**
  - Local PC vs adsb.lol, from the JSON `now` (ms) of the lowest-RTT polls (min RTT 59 ms): **server − local = −494 ms**.
  - The 1 s HTTP `Date`-edge bound gives [−475, −355] ms. It agrees to about 0.1 s (`now` is the snapshot time, so it is a slight lower bound).
  - Either method gives T_start to **≈ ±0.1–0.2 s**, well under 1 s.

**Key answer:** we can get the past ~30 min of tracks per aircraft from adsb.lol traces. The browser does not need to poll at 1–5 s and build tracks itself. It only needs discovery polling, which is also the only polite option: the re-api throttles at a 2 s rate.

## 2. Architecture (L2)

```
browser (live.html)                                         CF Worker (design only, NOT built/deployed)        adsb.lol
 getUserMedia -> AudioWorklet raw PCM, frame-0 anchor        GET /live/point/{lat}/{lon}/{nm}  ----------->  api.adsb.lol/v2/point/...
 every 15-30 s: GET proxy/live/point (discovery + clock)       - cache 5 s per (rounded lat/lon), coalesces users
 stop: for hexes seen < 10,000 ft within 15 km:              GET /live/trace/{full|recent}/{hex} -------->  adsb.lol/data/traces/xx/trace_*_{hex}.json
       GET proxy/live/trace/full + recent (<= 4 req/s)         - cache 30-60 s per hex; whitelist hex regex
 builder -> traceToTracks (geoid N from 2° EGM96 grid)        - adds ACAO *, Access-Control-Expose-Headers: Date
 runSearch(T_start known ±3 s, 1+ events)                     - descriptive User-Agent; per-IP rate limit
```

- **Why a proxy is needed:** no live source sends CORS headers that a third-party origin can use. The Worker is about 40 lines, the same pattern as `worker/src/index.js` (owned by another lane, not touched). My local stand-in is `web/tests/live_proxy.mjs`. It forwards only these two path patterns and passes the upstream `Date` header through.
- **Poll rate:**
  - The design uses one `/v2/point` request every 15–30 s per user. A light aircraft at 60 m/s moves 1.8 km in 30 s, and the 25 nm discovery circle is 46 km in radius, so an audible aircraft cannot slip through.
  - The prototype polls every 5 s and backs off ×2 (up to ×6) on 429.
  - With the Worker's 5 s cache and coalescing, N users in one area cost adsb.lol at most 1 req/5 s for that area.
  - Trace backfill is 2 requests per low aircraft, typically 10–40 per clip. That is far below the stated 30/s and 900/min.
- **Time sync:**
  - `T_start = anchor_local_ms + offset`.
  - `anchor_local_ms` is `performance.timeOrigin + performanceTime`, taken from `AudioContext.getOutputTimestamp()` and mapped back to the worklet's first frame (`currentTime`), minus `baseLatency`.
  - `offset` is the median `now − (send+recv)/2` over the 20 % lowest-RTT polls. The `Date`-header interval is a cross-check (`web/dev/live/clock.js`).
  - The monotonic `performance` clock means an NTP step during the clip does not matter.
  - Budget: offset ±0.1 s, audio input latency 5–40 ms (not exposed), ADS-B stamp latency 0.1–1 s, which gives **±3 s as a safe prior**.
- **How the search changes:**
  - The engine gets `time = {T−3, T+3}`. In robust mode this becomes `t_start_prior`, a soft window with a 10 s gate (geoloc-api addendum).
  - With T_start pinned, the event's received CPA time `t_cpa_audio + T_start` fixes the along-track position. Only d (the across-track distance, left or right) remains.
  - So one event gives a point pair instead of two km-long curves (MATH §10; LANE_A §4: "one event + T_start known ±2 s" = 25 m / 16 m vs 5 km / 3 km).
  - The T_start sweep shrinks from ±12 s × many seeds to ±3 s, which speeds things up: 1–6 s vs 7–57 s in my runs.
  - Two or more events then become a consistency check and also resolve the left/right mirror.
- **Location:** the browser could just ask `navigator.geolocation`. Live mode is therefore mainly a **demo / self-calibration / trust-building mode**: "record here, see that it finds you". It also validates the pipeline against ground truth on real data. The region only needs to be coarse (city level, ~6 km search radius).

## 3. Prototype (L3): what works

| file | role |
|---|---|
| `web/dev/live.html` | dev page: location → record (mic) → stop → backfill → spectrogram (Lane C viewer) → click a ridge → `trackRidge` + `fitEvent` → `runSearch` with T_start ±3 s. It also accepts a WAV plus a typed T_start. Needs `?proxy=` |
| `web/dev/live/adsb-live.js` | `LiveTrackBuilder` (snapshots and traces merged by time and stored as readsb trace points, then `adsb.js#traceToTracks` + `baroCalibration` → contract tracks), `backfill`, URL helpers |
| `web/dev/live/clock.js` | `ServerClock` (min-RTT JSON `now` offset + `Date` edge bound), `wallNow` |
| `web/dev/live/recorder.js` | getUserMedia (no EC/NS/AGC) → AudioWorklet raw PCM, with the frame-0 wall-clock anchor |
| `web/dev/live/session.js` | `startPolling` (with 429 backoff), `hexesNear`, `finishTracks`, `liveSearchInput` |
| `web/dev/live/geoid.js` | 2° EGM96 grid (54 KB raw), bilinear. Within 1.6 m of PROJ at the four test sites (LELL 50.1 vs 49.8, Long Island −33.1 vs −32.1) |
| `web/tests/live_unit.test.mjs` | 5 offline tests, **all pass** (`node --test web/tests/live_unit.test.mjs`) |
| `web/tests/live_poll.mjs` | 10-min real polling, backfill and comparison (numbers in §1) |
| `web/tests/live_e2e.mjs` | real live tracks + synthetic one-pass clip → runSearch |
| `web/tests/live_browser.mjs` | Firefox (Playwright, `media.navigator.streams.fake`) drives live.html end to end |
| `web/tests/live_proxy.mjs` | local dev CORS proxy and static server (never deploy) |

**End-to-end search (`live_e2e.mjs`):**
- Each run takes one real low track from the live set and puts a synthetic observer 700 m to its side.
- The clip is 240 s, with harmonics 1–3 plus noise and a flat DEM. One event comes from the ridge plus the fit.
- The search centre is 2.5 km off the truth, the search radius is 6 km, and every live track in the set is a possible distractor.

| track set | pass | T_start exact ±3 s | T_start +2 s bias ±3 s | T_start unknown ±600 s |
|---|---|---|---|---|
| smoke run (16 tracks) | P208 EC-?, 720 m MSL | **5 m**, right flight, margin 0.14, 6.6 s | **5 m**, right flight, margin 0.13 | **3,023 m, wrong flight**, ambiguous |
| 10-min run (22 tracks) | unknown type, 940 m | **5 m**, right flight, margin 0.02 (ambiguous flag) | **5 m** | 5 m (few distractors; still ambiguous) |

The low margin in the second case is the left/right and along-track alias that one event cannot remove by itself. Two events fix it. The fit was flagged `poorly_constrained` both times: the synthetic amplitude is not distance-shaped. The search still recovered, because robust mode treats the v/d ranges as soft priors.

**Browser mic test (Firefox headless, fake mic, `live_browser.mjs`):**
- Recording works: 55.4 s captured at 48 kHz in a 60 s window, rms 0.07 (fake tone).
- The frame-0 anchor was 865 ms after the click. That is getUserMedia plus worklet start-up, minus the 238 ms clock offset. The anchor is what counts, not the click.
- Polling through the proxy worked, but 8 of 12 polls got 429 because `live_poll.mjs` was polling from the same IP at the same time. Even so, 31 aircraft were seen, the clock offset was estimated (−238 ms, RTT 347 ms), and 3 low tracks (2 heli, 1 prop) were backfilled in 2.2 s.
- **Clean re-run (90 s, no other polling):**
  - 88.9 s captured, with 16 polls and only 1 error (429 backoff).
  - 36 aircraft were seen. The clock offset was −261 ms (min RTT 166 ms), inside the `Date` bound [−288, +145] ms.
  - 6 low tracks were backfilled: 3 prop, 1 heli, 2 jet.
  - The anchor came 1.19 s after the click.
  - So the full mic → polling → clock → backfill → contract tracks path works in Firefox.

**Not done:**
- The real Worker. It is designed above, and I was told not to deploy or touch `worker/`.
- Silences UI.
- A real outdoor recording. The fake mic has no Doppler, so the search was exercised with the synthetic clip instead.
- Mobile Safari: AudioWorklet works there, but `getOutputTimestamp` support should be checked. The fallback is `wallNow()` at the first worklet message minus 128/fs, an error of a few ms plus the message delay.

## 4. Risks

1. **ToS / dependency on one provider (main risk).**
   - adsb.lol is ODbL and free, but says "contact me" for production and plans **API keys for feeders**.
   - adsb.fi and airplanes.live are non-commercial, and airplanes.live gives 403 without an agreement. OpenSky is non-commercial with no usable CORS.
   - So live mode in a commercial SaaS depends on an agreement with adsb.lol. Owner action: email them; offer attribution, caching and a feeder.
2. **Throttling.** The re-api returned 429 for 66 % of requests at a 2 s interval and none at 5 s. The Worker must cache and coalesce, and clients should poll every ≥ 15 s. Trace files have explicit limits of 30/s and 900/min per IP. Behind a Worker those limits apply to the Worker's egress IPs, shared by all users, so caching per hex matters.
3. **Coverage.**
   - Low GA below ~300–500 m AGL may drop out of receiver coverage. MLAT-only aircraft have `seen_pos` up to 10 s and baro-only altitudes, which are calibrated locally.
   - Non-transponder aircraft are invisible, as in historical mode.
   - `trace_full` has p90 gaps of 13.6 s. That is acceptable per Lane A (≤ 30 s decimation costs ≤ 31 m), but a gap ≥ 60 s at the CPA costs 40–70 m.
4. **Time.**
   - The ADS-B stamp latency (0.1–1 s, unobservable) is absorbed by the ±3 s prior and the δ sweep.
   - If a phone's clock is wrong by many seconds, the server offset corrects it. That is why the offset is measured rather than trusting `Date.now()`.
   - The audio input latency is not exposed by browsers (5–40 ms), which is negligible.
5. **Privacy/UX.** Live mode needs mic permission and keeps the page open for the clip. Background tabs may throttle timers: polling slows down, but the backfill makes that harmless.
6. **Geoid.** The 2° grid adds ≤ ~2 m. A production build could use the Worker's per-cell `geoid_N` from the index shards.
