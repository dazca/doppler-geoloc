# Geolocation engine API (UI ↔ engine contract)

Author: Lane E (UI). Implementer: Lane D (`web/engine/geoloc*.js`, `web/workers/geoloc.worker.js`).

The UI imports the engine only through `web/ui/engine.js`. Today that file re-exports
`web/engine/geoloc-stub.js`. When the real engine is ready, change the one import line in `web/ui/engine.js`.
Every function below must keep its name and its signature. Units and formats follow `docs/CONTRACTS.md`.

All functions are `async`. Long-running ones take `{signal, onProgress}`:
- `signal` is an `AbortSignal`. When it is aborted, reject with `DOMException('…', 'AbortError')` as soon as you can,
  and in any case within 250 ms.
- `onProgress(p)` may be called any number of times. Never call it after the promise settles.

```js
export const ENGINE_INFO = { name: 'stub' | 'geoloc', version: '0.1.0', fake: boolean };
```
If `fake` is true, the UI shows a "stub engine — results are not real" banner.

---

## 1. `fitEvent(points, opts) → Promise<EventFit>`
Fits a straight, constant-speed pass to a tracked ridge. The model is MATH.md §3, eq. (3.2).

```ts
points: Array<[t_audio_s, f_Hz]>        // the FUNDAMENTAL: the UI has already divided by the clicked harmonic number
opts: { c?: number = 343, cls?: 'prop'|'heli'|'jet'|'unknown', harmonics?: number[] /*of the fundamental*/ }

EventFit = {
  t_cpa_audio: number,      // DELAYED CPA in received audio time: t_c + d/c. This is the contract's t_cpa_audio
  t_c: number,              // symmetry centre of the curve (emission-time CPA mapped to rx time; MATH.md §3)
  F0: number,               // rest frequency of the fundamental, Hz
  v_mps: [min, max],        // suggested range. The UI lets the user edit it
  cpa_m: [min, max],        // suggested slant CPA distance range
  point: { v: number, d: number },   // point estimates
  rms_hz: number, n: number,         // fit quality: residual RMS and number of points used
  curve: Array<[t, f]>,     // model curve of the fundamental over the fitted span plus a margin, for display
}
```
Throw `Error` with a human-readable message if the fit is impossible (fewer than ~8 points, no swing, and so on).

## 2. `fetchFlights(query, {signal, onProgress}) → Promise<FlightSet>`
```ts
query: { bbox: [lat0, lon0, lat1, lon1], t0: unix, t1: unix,   // UTC window for the recording START
         padS?: number = 1800, maxAltM?: number }              // the engine pads the window by the recording duration + padS
onProgress({ stage: 'index'|'download'|'parse', frac: 0..1, message?: string })

FlightSet = {
  tracks: ContractTrack[],                 // CONTRACTS.md flight track format; category is one of prop|jet|heli|unknown
  source: string,                          // e.g. 'adsb.lol globe_history' | 'fixture:scenario1' | 'synthetic'
  attribution: string,                     // shown under the map, e.g. 'ADS-B data © adsb.lol contributors, ODbL 1.0'
  counts: { prop, jet, heli, unknown },
  notes?: string[],                        // warnings, e.g. 'window truncated to 24 h', '2026-06-11 prod: partial'
  days?: DayStatus[], failed?: string[],   // real data only: archive completeness per UTC day/feed, failed downloads
}
```
The real implementation wraps `web/engine/adsb.js#fetchTracks` (Lane B). `onProgress` frac is `done/total` traces (or
null when unknown, never NaN). If not one index request gets an HTTP answer the promise rejects with `err.code ===
'unreachable'`; HTTP errors and single failed traces do not reject (see `failed`/`notes`).

## 3. `runSearch(input, {signal, onProgress}) → Promise<SearchResult>`
```ts
input = {
  events: Array<{ t_cpa_audio, F0, v_mps:[a,b], cpa_m:[a,b], cls: 'prop'|'heli'|'jet'|'unknown',
                  ridge?: Array<[t,f]> /*fundamental*/ }>,       // ordered by t_cpa_audio, 1..N
  silences: Array<{ t0, t1 }>,          // audio-time intervals with no audible aircraft
  region: { shape: 'circle'|'rect', center: [lat, lon], radius_m?: number, bbox: [lat0, lon0, lat1, lon1] },
  time: { t0: unix, t1: unix },         // window for the recording START (T_start), UTC
  duration_s: number,
  tracks: ContractTrack[],              // already filtered by the user's category toggles
  spec: Spectrogram | null,             // contract spectrogram (whitened dB) for pixel scoring; may be transferred
  settings: { grid_m: 100, c: 343, topN: 10, offsetTolS: 10, refine: true },
}

onProgress({
  stage: 'grid'|'cpa'|'filters'|'sim'|'score'|'refine',
  frac: 0..1,                            // progress within this stage
  survivors?: number,                    // candidates (grid point × flight assignment) left after this stage
  total?: number,                        // e.g. grid points
  message?: string,                      // e.g. 'speed filter: 1,204 left'
})

SearchResult = {
  candidates: Array<Candidate>,          // sorted by score, best first, at most topN, spatially distinct
  field: { bbox: [lat0, lon0, lat1, lon1], nLat, nLon, values: number[] /*row-major, row 0 = lat0 (south)*/,
           min, max } | null,            // best score per grid cell, for the heat map; NaN = filtered out
  stats: { gridPoints, survivorsByStage: {grid, cpa, filters, sim, score, refine}, elapsedMs },
}
Candidate = {                            // CONTRACTS.md candidate plus extras
  lat, lon, elev_m, score, flights: string[] /* track ids, one per event */, t_start_unix,
  F0?: number[] /* refined per event */,
  assignments?: Array<{ event: number, flight: string, t_cpa_unix: number, cpa_m: number }>,
}
```
Stage names and their order are fixed (the UI shows one row per stage). Stages that do not apply should still emit
`frac: 1`.

## 4. `simulateCurves(candidate, {events, tracks, c, harmonics}) → Promise<SimCurve[]>`
Doppler curves predicted for one candidate, using its assigned flights (exact retarded-time model, CONTRACTS.md).
```ts
SimCurve = { event: number, flight: string, harmonic: number, points: Array<[t_audio, f]> }
```
The UI overlays them on the spectrogram when the user selects a candidate.

## Threading
The UI calls these functions on the main thread and expects them to stay responsive. Run heavy stages in
`web/workers/geoloc.worker.js` (or in a pool). The `spec` passed to `runSearch` can be large (≈70 MB for 20 min).
Copy what you need, or ask the UI to transfer it. The UI keeps its own copy for display.

---

## Addendum (Lane D, real engine `web/engine/geoloc.js`): backward-compatible extras

The names, signatures and required fields above are unchanged. The real engine also accepts and returns the following.

**`fitEvent(points, {c, cls})`**: `cls` selects the soft physical prior (prop v 30–100 m/s, heli 20–80, jet 60–300; CPA ≲ 4 km for props).
`v_mps`/`cpa_m` are *honest* 2σ ranges. They combine:
- the statistical error, inflated for residual correlation;
- the straight-line model error, which grows when the asymptotes are not seen;
- the profile-likelihood region.

So they can be much wider than ±20/40 %. Extra fields:
`t_sigma_s`, `t_cpa_range`, `sigma`, `sigma_total`, `poorly_constrained: boolean`,
`quality: {coverage /*fraction of the Doppler swing observed*/, reasons: string[], corr_inflation, n_eff}`,
`unconstrained: {F0, v, d, t_c, t_cpa_audio}` (fit without priors) and `profile: {v:[a,b], d:[a,b], t_cpa_audio:[a,b]}`.
Show `quality.reasons` when `poorly_constrained` is true.

**`runSearch` input extras**:
- event fields: `locked: true` makes that event's v/d ranges hard gates. Otherwise, in robust mode, they act only as soft penalties, and the only hard gates are the class's physical envelope. `t_sigma_s` is that event's CPA-time uncertainty, which widens the time prior.
- `input.dem`: `fn(lat[], lon[]) → elev[]` or `{elevations({lat, lon})}`. The default is Lane B's Terrarium DEM (`dem.js`, z12).
- `input.audio = {samples, fs}`: used when `spec` is null. The engine then computes the reference spectrogram (8 kHz, Hann 4096, hop 1024).
- `settings.mode`: `'robust'` (default; soft priors, wide T_start sweep, per-seed re-centring) or `'faithful'` (exactly the Python reference: hard v/d/offset filters).
- `settings.useRidgeFit`: default true. An event with a `ridge` gets its delayed CPA from the fit, unless the fit is poorly constrained; then only the time prior is widened.
- `settings.workers`: 0 runs inline. `settings.config`: raw overrides of `geoloc/search.js#DEFAULT_CONFIG`.
- `time {t0, t1}`: a hard window for T_start in faithful mode. In robust mode it is a soft window with a 10 s gate margin.
- `silences`: no unassigned audible flight may have its delayed CPA inside a silence.
- `spec`: any contract spectrogram (dB). The engine crops it to the band the harmonics can reach and whitens it per bin (median/MAD, clip [−3, 8]), caching the result per `spec.data`. If `spec.unit === 'z'`, it is used as is.

**`runSearch` result extras**:
- `confidence: {margin, ambiguous /*margin < 0.1*/, runnerUp, message}`. `margin` = (best − best distinct alternative ≥ 1 km away)/best.
- per candidate: `margin` (relative to the best), `raw_score`, `penalty`, `level_m` (50 = refined, 200 = coarse-only mode).
- `assignments[]` also carry `t_dcpa_audio`, `speed_mps`, `score`, `offset_resid_s`.
- `stats` also carries `timings`, `mode`, `executor`, `workers`, `refinePoints` and `notes`.

**`fetchFlights`**: real data needs `query.worker` or `globalThis.GEOLOC_ADSB_WORKER` (the ADS-B proxy URL). Without one, the call falls back to the stub's fixture/synthetic data and adds a note.

**D8 additions** (backward compatible):
- Event fields `v_est: [mu, sigma]` and `d_est: [mu, sigma]` (for example, `fitEvent`'s `point` and `sigma_total`) become Gaussian soft priors. They compare the ADS-B ground speed and CPA distance at the candidate with the Doppler-implied values, and replace the interval penalty of `v_mps`/`cpa_m`.
- Candidates carry two more fields:
  - `score_doppler`: the curve score before the evidence penalty;
  - `evidence: {chi2_level, chi2_silence, penalty, events:[{flight, d, L_db, Ls_db}], silence:[...]}`. `L_db` is the received level near the CPA (dB above the per-bin median) and `Ls_db` the implied source level.
- `score` = `score_doppler − evidence.penalty`. In robust mode the score is a matched filter over the predicted amplitude envelope (`weighting: 'snr'`), so its scale differs from faithful mode. Compare scores only within one run.
- `settings.config` also accepts `weighting` (`'none'` | `'snr'`), `sweep` (`'full'` | `'c2f'`) and `evidence` (`null` = off).
- A file-metadata time in `time {t0, t1}` (e.g. ±60 s) is the strongest alias breaker. Pass it whenever the video carries a creation time.
