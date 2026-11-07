# Automatic event detection (Lane AD): integration contract and validation

Status: implemented and validated (numbers below). Owner: Lane AD (`web/engine/autodetect.js`,
`web/tests/autodetect.test.mjs`, the `autodetect` message in `web/workers/dsp.worker.js`). The UI lane integrates it.
Lane AD does not touch `web/ui/*`.

## Function

```js
import { detectEvents } from '../engine/autodetect.js';
const events = await detectEvents(spec, opts);   // events.stats = diagnostics (non-enumerable)
```

`spec` is the app's contract spectrogram: whitened dB from `stftOptions(...)` in `web/ui/spec-panel.js`. Any preset
works because the detector reads `dt` and `df`. The spectrogram is only read: `data` is never modified, and tracking
uses zero-copy `subarray` crops.

`opts` (all optional; defaults in `AUTODETECT_DEFAULTS`):

| key | default | meaning |
|---|---|---|
| `fMin`, `fMax` | 40, 600 | band (Hz) where a pass's *tracked line* may lie |
| `maxEvents` | 12 | cap on returned events, best first |
| `minScore` | 0.25 | events with `score < minScore` are dropped |
| `confidentScore` | 0.6 | `label = 'confident'` at or above this score, `'suggestion'` below |
| `maxCandidates` | 30 | max seeds that are tracked (extendRidge). Main speed/recall knob for busy airfield recordings |
| `cls` | `'prop'` | class used for the ridge options and the fit prior (`fitEvent(..., {cls})`) |
| `c` | 343 | speed of sound |
| `tMin`, `tMax` | whole spectrogram | only scan this audio-time window (seeds inside it) |
| `exclude` | `[]` | `[{t0, t1}]` windows, or already-marked events `[{t_cpa_audio}]` (±30 s), to skip |
| `impulse` | true | impulsive-noise ridge options (LANE_C C6, like the app default) |
| `trackHalfS` | 60 | half-width of the crop that each seed is tracked on. If the ridge reaches the crop edge, the seed is tracked again once on a crop twice as wide |
| `maxTimeMs` | 15000 | safety budget for the tracking loop (`stats.untried > 0` when it or `maxCandidates` stopped it) |
| `onProgress` | – | `(p) => {}`, `p = {stage: 'scan'|'track'|'fit', frac}` |
| `signal` | – | AbortSignal, checked between candidates. Rejects with `AbortError` |

## Return shape (sorted by `score`, best first)

```ts
Array<{
  seed: { t, f },          // point ON THE TRACKED LINE (Hz of that line): usable as a UI click / ev.seeds[0]
  harmonic: number,        // harmonic number of the tracked line w.r.t. the reported fundamental (= UI ev.harmonic)
  points: Array<[t, f]>,   // ridge of the FUNDAMENTAL (tracked line / harmonic), one point per STFT frame
  fit: EventFit,           // Engine.fitEvent result (t_cpa_audio, F0, v_mps, cpa_m, point, t_sigma_s, quality, curve, ...)
                           //   computed on <= 400 evenly decimated points of `points` (same fit within ~0.3 s / 1 %)
  flyover: {ok, kind, ...},// geoloc.js flyoverCheck on the tracked line
  score: number,           // 0..1 confidence
  label: 'confident' | 'suggestion',
  snr_db: number,          // median ridge SNR of the tracked line (dB over the band median)
  span: [t0, t1],          // time span of the ridge
  related: Array<{ f_ratio, t, f, strength, tracked? }>,  // other lines of the same pass (harmonics, engine-order comb)
  reasons: string[],       // why the score is not 1 (weak, short, partial swing, implausible v/d, steps, ...)
}>
events.stats = { tracklets, flat, tried, untried, tracked, sigma, thr, timings: {scan, track, quick, fit, nFit}, elapsedMs }
```

To turn one into an app event (same fields as `trackEvent` in `web/ui/app.js`):
`{cls, harmonic: e.harmonic, seeds: [e.seed], ridge: e.points, fit: e.fit, t_cpa_audio: e.fit.t_cpa_audio, F0: e.fit.F0,
v_mps: [...e.fit.v_mps], cpa_m: [...e.fit.cpa_m], status: 'ok'}`. Show `label === 'suggestion'` (and `reasons`) as
"accept / dismiss" suggestions. Re-tracking from `seed` with the UI's own click code also works.

## Worker message (`web/workers/dsp.worker.js`)

```
in : {id, type: 'autodetect', spec, opts}       // spec is structured-cloned (functions in opts cannot cross)
out: {id, type: 'progress', p}                  // p = {stage, frac}
     {id, type: 'result', result: {events, stats}}
     {id, type: 'error', message}
```
`dsp-client.js` has no wrapper. The UI can add
`autodetect: (spec, opts, onProgress) => call({type: 'autodetect', spec, opts}, [], onProgress)`.
Abort means terminating the worker, or ignoring the result. The track worker (`track.worker.js`) already holds a copy of
the spectrogram. To avoid a second ~100 MB clone, the UI may add the same three-line handler there instead
(`detectEvents(spec, opts)`). Tested in Node through a `worker_threads` shim (`web/tests/autodetect.test.mjs`).

## Method (one paragraph)

1. **Scan.** The band is pooled into 0.5 s blocks and turned into a tonal-contrast map: each bin minus its ±3..8-bin
   side bands, which cancels broadband bursts. Peaks above median + 3·MAD-sigma are linked into tracklets that are
   falling or flat (≥ 4 s).
2. **Track.** Tracklets are taken strongest first. A tracklet is skipped when it is flat or rising. It is also skipped
   when it lies on an already tracked line, on a small-integer ratio of an accepted pass, or *parallel* to it (constant
   frequency ratio, which is how engine-order combs show up). Such lines are recorded in `related`. Otherwise
   `extendRidge` (the UI click tracker, with the app's ridge options) runs from the tracklet's strongest point.
3. **Judge.**
   - `flyoverCheck` rejects static, rising and step lines.
   - A cheap straight-pass LSQ screens the rest.
   - Events with the same CPA time and overlapping spans are merged as one pass (best line kept).
   - The fundamental is the lowest small-integer line below the tracked one.
   - `fitEvent` fits the survivors.
   - The score combines SNR, duration, swing coverage, residual and harmonic support. It is penalised for poorly
     constrained fits, for v < 20 m/s or d < 100 m ("ground source?"), and for v/d outside the class envelope (a mild
     penalty when the 2σ range is plausible). It is also penalised for a staircase fall: > 30 % of the fall faster than
     2.5× the fitted pass's maximum slope, which is how rpm steps, taxiing and run-ups look.

## Timings (Node 16-core laptop, single thread; app default STFT: 8 kHz, 2048/4096, hop 512 (1024 > 40 min), hum + impulse)

| recording | duration | detectEvents |
|---|---|---|
| colsto (2 passes, quiet) | 25 min | 1.5–1.8 s |
| cat_lell_patrona / cat_salou (busy airfield) | 30 min | 2.2–2.4 s (up to 4.9 s while the machine was loaded) |
| v2 Egelsbach / Teuge live streams | 60 min (hop 1024) | 1.5–2.1 s |
| v2 KSMO live | 40 min | 2.1–2.8 s |
| ksmo_2024 montage / cat_leig (very dense combs) | 18–22 min | 3.1–4.4 s (7–8 s on a loaded machine) |
| synthetic scenarios | 9–19 min | 0.4–1.4 s |

Cost is bounded by `maxCandidates` (about 50–120 ms per tracked seed) plus `maxEvents` full fits (about 60–150 ms each).
It does not grow with duration beyond the scan (about 0.15 s per 30 min). Wider caps (`maxCandidates: 100, maxEvents: 40`)
take 5–10 s and raise recall on busy airfields (Egelsbach 2025: hand events found 3 → 6, ADS-B passes 5 → 11).

## Validation (final code, default options)

### Synthetic fixtures (truth events)

scenario1, scenario2, scenario_rand101–106: 18 truth passes.

| metric | value |
|---|---|
| recall | **17/18**. The miss (rand106 E2, d = 1.67 km) is not visible in the app spectrogram |
| confident | 13/17 detected; 4 are suggestions with scores 0.52–0.60 |
| false detections | **0**: no detection that is not a truth pass |
| t_cpa error | median 0.28 s, max 2.5 s (scenario2 Q3 turns at its CPA; rand101 E1) |
| F0 error | median 0.17 %, max 3.2 % (Q3) |
| v error | median 1.5 %, max 27 % (Q3, the curved track that also biases a hand fit; MATH.md §4) |

### Real recordings vs hand-marked events

Hand events come from `ridges.json` (colsto), `blind.json` (Lane K and V2 seeds) and `run_montage_free.json` (KSMO).
"ADS-B" = transponder tracks passing < 3 km from the known spot, when the true start time is known; the match window is
±25 s. "Unexplained" means neither hand-marked nor ADS-B. Most of those are real passes that were never marked or have
no transponder (busy GA fields, an airshow). Some are false positives: rpm steps, birds, vehicles.

| case | dur | ms | hand events | found (any score) | found confident | detections | confident | confident unexplained | ADS-B < 3 km / detected |
|---|---|---|---|---|---|---|---|---|---|
| colsto_longisland | 25 min | 1521 | 2 | **2** | **2** | 3 | 2 | 0 | – |
| cat_lell_terrace | 21 min | 1240 | 2 | 1 | 0 | 3 | 0 | 0 | – |
| cat_lell_patrona | 30 min | 2229 | 3 | 2 | 1 | 12 | 4 | 3 | – |
| cat_salou (airshow) | 30 min | 2399 | 3 | 3 | 2 | 12 | 8 | 6 | – |
| v2_egelsbach_2023 | 60 min | 2122 | 4 | 3 | 2 | 12 | 5 | 3 | – |
| v2_egelsbach_2025 | 60 min | 2000 | 14 | 3 | 3 | 12 | 7 | 3 | 22 / 5 |
| v2_ksmo_live | 40 min | 2059 | 4 | 1 | 0 | 6 | 0 | 0 | 36 / 2 |
| v2_malvern | 11 min | 1075 | 8 | 2 | 0 | 3 | 0 | 0 | 1 / 0 |
| v2_teuge_0406 | 60 min | 1476 | 6 | 1 | 0 | 10 | 3 | 2 | 22 / 3 |
| v2_teuge_0802 | 60 min | 1606 | 0 | – | – | 9 | 1 | 1 | 14 / 1 |
| ksmo_2024 (montage) | 22 min | 3057 | 19 | 6 | 2 | 8 | 2 | 0 | – |
| cat_leig | 19 min | 4375 | 0 | – | – | 6 | 1 | 1 | – |
| cat_lell_training | 13 min | 2077 | 0 | – | – | 6 | 2 | 2 | – |
| lfmd (jets) | 15 min | 2280 | 0 | – | – | 2 | 0 | 0 | – |
| sunderland_heli (negative control) | 7 min | 432 | 0 | – | – | 0 | 0 | 0 | – |

Totals: 65 hand events. 24 were found at any score (37 %) and 13 were confident. On colsto, the case the method was
designed for, the result is perfect: both passes, both confident, ranked 1–2, and the only other detection is a 0.33
suggestion. On busy airfield recordings, recall of the hand-picked passes is low for three reasons. The candidate cap
and `maxEvents` cap are binding (`stats.untried` in the hundreds). Many hand events are short takeoff/landing curves
that rise and then fall. Dense engine-order combs fragment the tracklets.

False positives:
- Synthetic: none, including the static and stepped tone negative control in the tests.
- sunderland (helicopter circling): none.
- lfmd (jets only): no confident events.
- colsto non-pass stretches: one suggestion (score 0.33). The static tone with an rpm step at about 1100 s, and the
  wobbly faint curves at 810–851 s, are scored below `minScore`.
- Example of the failure modes that the step penalty demotes: Egelsbach 2023 at 2550 s, a staircase of rpm changes
  (taxi/run-up). It was confident (0.89) before the step penalty and is now a 0.44 suggestion.
- On busy airfields, confident detections that are neither hand-marked nor ADS-B-explained number 0–6 per recording.
  The ones inspected visually were mostly real low passes. **Confidence does not separate "the pass a human would
  pick" from "another real line".** The scores of hand events (0.26–0.95) and of unexplained detections (0.25–0.92)
  overlap.

### End-to-end: colsto search with auto-detected events

`web/tests/geoloc_colsto_bench.mjs` setup: 5410 tracks, bbox region, 30 h window, robust mode, flat DEM, 12 workers.
The auto run uses the two `confident` events, unedited. With `score ≥ 0.4` it would also be the same two events.

| events | t_cpa (s) | best candidate | flights | T_start | verdict | margin to next alt. |
|---|---|---|---|---|---|---|
| manual (ridges.json) | 255.3, 1168.8 | 40.87611, -73.52338 | a1dfeb (CST1219 PC-12) + ace391 (EGE93 King Air) | 20:49:11.03Z | **match** (z 2.64) | 73 % |
| **auto** | 255.0, 1171.2 | 40.87566, -73.52397 (**≈70 m** from manual) | same two flights | 20:49:10.75Z | **match** (z 2.67) | 97 % |

## Limitations

- Tuned for props and helicopter lines in 40–600 Hz on continuous recordings. Jets (broadband) and passes with no
  falling tonal line are not detected. A pass visible only on its flat asymptote is not detected either, by design.
- Busy airfields: only `maxCandidates` seeds are tracked, and `maxEvents` events are returned. Passes beyond that are
  missed (`stats.untried`). Raise the caps or scan a window (`tMin`/`tMax`) for more.
- Takeoff passes that rise and then fall, and very close passes (d < 100 m: "too close"), get low scores. Airfield
  fence recordings are therefore mostly suggestions.
- The harmonic number is inferred only from detected lines below the tracked one. If the true fundamental is never
  visible, `F0` refers to the lowest line seen. The search sweeps F0 anyway.
- `score` is a heuristic, hand-tuned on these fixtures (no held-out set). Treat `confident` as "a clean Doppler pass",
  not as "an aircraft that will match ADS-B".
- In the worker, `opts.signal` cannot cross the boundary, so abort means terminating the worker.
