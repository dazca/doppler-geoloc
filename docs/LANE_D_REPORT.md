# Lane D report: browser geolocation engine

Lane D is the real engine behind `web/engine/geoloc-api.md`. It is written as plain ES modules, has no build step, and runs in both Node 22 and the browser.

* **Faithful mode** reproduces the Python reference bit for bit on scenario1 and scenario2: horizontal errors of 25.3 m and 16.1 m.
* **Robust mode** is the default. It recovers every non-degenerate robustness variant that fails with the hard filters.
* **Speed:** in Firefox 158 with 16 workers, a whole scenario search takes 0.4–0.7 s in faithful mode and 2.3–2.8 s in robust mode. Python takes 16.0 s for scenario1 and 11.8 s for scenario2 (search only, from `result_ref.json`).

Commands:
* Tests: `node --test web/tests/*.test.mjs`. This runs 46 tests: 44 pass, 0 fail, and 2 network-only DEM tests are skipped. All tests of the other lanes stay green.
* Benchmark: `node web/tests/geoloc_bench.mjs 0,4,8,16`.
* Robustness table: `node web/tests/geoloc_robust_run.mjs both`.
* Browser benchmark: serve the project root and open `/web/tests/geoloc_browser.html`.

## 1. Files

| file | content |
|---|---|
| `web/engine/geoloc/geo.js` | WGS84 ⇄ ECEF ⇄ ENU, exact, Float64 |
| `web/engine/geoloc/track.js` | contract track → C¹ Hermite with 3-point tangents, local-quadratic smoothing (tricube, W = 15 s), `evalTrack` with no allocation |
| `web/engine/geoloc/doppler.js` | Newton retarded-time solver (4 iterations), exact Doppler, straight-line closed form, 0.5 s track resampling + delayed-CPA tables (argmin R² + parabolic refinement) |
| `web/engine/geoloc/spectro.js` | reference spectrogram (periodic Hann, no detrend, `10log10(P/Σw²+1e-12)`) on Lane C's `fft.js`; per-bin median/MAD whitening (numpy-style median); bilinear sampling; curve score |
| `web/engine/geoloc/filters.js` | stage 4: speed/CPA, time offset, silence, user silences, T_start window; faithful (hard) and robust (gates + soft-L1 priors) |
| `web/engine/geoloc/score.js` | stage 5–6 kernel: retarded-time simulation + δ×ρ×k×τ bilinear sweep, typed scratch buffers, no allocation in the loops |
| `web/engine/geoloc/fit.js` | port of `fit.track_ridge`; `fitStraight` (bounded LM on the soft-L1 cost, multi-start in d, scipy-equivalent covariance, plus `fix`/`prior` options); `fitPass` (honest uncertainty, §5) |
| `web/engine/geoloc/search.js` | grid + DEM + proximity mask, coarse → 100 m → 50 m refinement, prescreen, per-seed re-centring, distinct candidates and margin |
| `web/engine/geoloc/exec.js` | inline executor (the same interface as the pool) |
| `web/engine/geoloc.js` | public API: `ENGINE_INFO`, `STAGE_ORDER`, `fitEvent`, `fetchFlights`, `runSearch`, `simulateCurves`, plus `prepareSpectrogram`, `referenceSpectrogram` |
| `web/workers/geoloc.worker.js`, `web/workers/geoloc-pool.js` | module worker that runs under both browser and `worker_threads`; pool with one global FIFO, about 4 chunks per worker, Z in a `SharedArrayBuffer` when available, abort |
| `web/tests/geoloc_{physics,spectro,fit,search,api}.test.mjs` | tests for D1–D7 and the API |
| `web/tests/geoloc_helpers.mjs` | scenario loader + analytic DEM ported from `scenarios.make_dem` |
| `web/tests/geoloc_run.mjs`, `geoloc_bench.mjs`, `geoloc_robust_run.mjs`, `geoloc_browser.html` | runners and benchmarks |
| `fixtures/golden_js/make_golden_js.py` → `fit_scenarios.json`, `robust_variants_scenario1.json` | Python ridge/fit outputs, and the robustness event sets (they need numpy's RNG) |
| `web/engine/geoloc-api.md` | **appended addendum** with backward-compatible extras; nothing existing changed |

## 2. Validation against the reference (actual test output)

| step | check | result |
|---|---|---|
| D1 geo | `geo.json` | max \|ΔENU\| 9.6e-10 m, \|Δlat/lon\| 1.4e-14°, \|Δh\| 8.6e-10 m |
| D1 track | `track_interp.json`, raw and W15 | \|Δpos\| 1.46e-5 m, \|Δvel\| 1.96e-7 / 1.28e-7 m/s (tolerance 1e-4 / 1e-6) |
| D2 | `emission_doppler.json` | t_e 4.8e-7 s, R 1.5e-5 m, v_r 4.8e-7, f 1.3e-7 Hz, t_dcpa 0 |
| D2 | `straight_line.json` | f, τ 5e-10; f = F0 and slope −F0v²/(cd) at the delayed CPA |
| D3 | `spectrogram.json` | \|ΔdB\| 7.6e-6, \|Δz\| 4.8e-7 |
| D3 | `curve_score_small.json` | K=1/2/3: 1.996419 / 0.976161 / 0.603857, equal to 6 decimals |
| D3 | `scenario1_point_scores.json` | 8981×513; mean dB −23.38179 (ref −23.38179); all 5 point scores equal to 5 decimals (2.66849, 1.64775, 0.74959, −0.12829, 0.11875) |
| D4 | ridge + weighted / unweighted fit vs `fit.py`, all 5 events | identical ridge points (< 1e-6); F0, v, d, t_c and σ within 0.05σ, e.g. scenario1 ev0 F0 127.851, v 57.115 ± 0.601, d 736.0 ± 24.1, t_c 100.129 |
| D5 | `run_search`, faithful | **identical:** grid 14615 / 14641; survivors 8 / 5; levels 81/34, 49/47 and 81/17, 49/44; best score 2.593280 / 4.344830; lat/lon < 1e-9°; ΔT_start 0.0000 s; F0 exact; **errors 25.3 m / 16.1 m** |
| D6 | pool vs inline | bit-identical results; progress stages in contract order; abort honoured in 0–2 ms |

## 3. Speed

Python's single-threaded reference times come from `result_ref.json`. Node times come from `geoloc_bench.mjs`, measured after JIT warm-up. In each cell, the first number is faithful mode and the second, after the slash, is robust mode. Robust mode scores many more survivors: 671 coarse survivors, against 8 in faithful mode.

| stage (scenario1) | Python | JS inline | JS pool ×4 | JS pool ×16 |
|---|---|---|---|---|
| spectrogram + whitening | 1.85 + 0.33 s | 0.37 + 0.15 s | — | — |
| grid + DEM + CPA tables | 2.36 s | 0.14 s / 0.24 s | 0.07 s | 0.05 s |
| filters | 0.007 s | 0.002 s | — | — |
| coarse score | 1.35 s | 0.03 s / 2.28 s | 0.01 s / 0.61 s | 0.02 s / 0.31 s |
| refinement | 11.9 s | 0.23 s / 2.41 s | 0.09 s / 0.69 s | 0.07 s / 0.31 s |
| **total search** | **16.0 s** | **0.40 s / 4.9 s** | **0.17 s / 1.4 s** | **0.14 s / 0.68 s** |

Scenario2: Python takes 11.8 s. JS faithful takes 0.77 s inline and 0.16 s with 16 workers; robust takes 5.7 s inline and 0.94 s with 16 workers.

**Browser (Firefox 158, 16 hardware threads, not cross-origin isolated, so Z is copied to each worker):**

| run | time | error |
|---|---|---|
| scenario1 faithful | 0.73 s (2.4 s on the first run, which includes whitening and worker start-up) | 16 m |
| scenario1 robust | 2.27 s | 16 m |
| scenario2 faithful | 0.44 s | 28 m |
| scenario2 robust | 2.66 s | 28 m |

The API run centres its grid on the region centre rather than the reference's ENU origin, so its 16/28 m errors differ from the reference's 25/16 m. Everything is within the 5 s target.

**Kernel cost:** about 5–7 ns per bilinear sample. The kernel is a scalar loop over the active τ samples, with the ratio and row offsets precomputed for each δ.

## 4. Robustness (D7), scenario1

`node web/tests/geoloc_robust_run.mjs both`. Each cell gives the error in metres, then the margin `m`. A margin below 0.1 means "ambiguous". An `x` after the error marks a wrong flight assignment.

| variant | Python (`robustness_results.json`, stale table) | JS faithful | JS robust |
|---|---|---|---|
| baseline | 35 | 25 (m 1.0) | 25 (m 0.012) |
| auto events (ridge + LSQ) | 35 | 25 | 25 |
| one event only | 6618 | 5071 | 8405 x (fundamentally ambiguous, MATH §10) |
| one event + T_start ±2 s | FAIL | 25 | 25 |
| no v/d filter | 8718 | 25 (m 0.004) | 8239 x (m 0.002) |
| measured t err ±6 s | 45 | 45 | **25** |
| **measured t err ±10 s** | 2188 | 2049 | **25** |
| measured v ±30 %, d ±60 % | 76 | 76 | **25** |
| **event-0 CPA range wrong** | 693 | 615 | **25** |
| t err ±10 s, CPA time from the ridge fit (D7b) | — | **25** | **25** |

What robust mode changes:
* **(a) Soft priors.** The entered ranges no longer hard-prune; they act as soft-L1 penalties: `λ/2·Σ 2(√(1+χ²)−1)`, with λ = 0.05, σ_v = max(10 %, half the range width) and σ_d = max(20 %, half the range width). The time offset uses σ_t = max(8 s, the event's `t_sigma_s`).
  * The only hard gates are the class's physical envelope united with the widened range (for props: 25–110 m/s and ≤ 4 km) and an offset gate of 30 s.
  * The T_start sweep widens to ±12 s on the coarse grid, with a cheap prescreen. The penalised score is maximised jointly over δ.
* **(b) Fitted CPA time.** The fitted t_cpa replaces the hand-entered one whenever the event has a ridge. On its own, this fixes the ±10 s case even in faithful mode.
* **(c) Distinct candidates with margins.** The result lists the top distinct candidates (≥ 1 km apart) with their score margins.
* **Per-seed re-centring of the T_start/F0 sweeps (new).** The reference re-centres every seed on the *global* coarse best. When an alias wins the coarse level, the true mode's refinement sweeps then miss its own T_start. This was the cause of the robust-mode failures in the first runs.

**Key finding: a genuine alias in scenario1.** The point 8.1 km away, with flights P1 + P5 and T_start −150 s, has a raw score of 2.53 against 2.60 at the truth. Without the v/d ranges it is a near-tie: faithful wins by 0.004 and robust loses by 0.002. In robust mode the baseline therefore reports margin 0.012, "ambiguous", and lists that alias as the runner-up with different flights. In faithful mode the hard v-range excludes P5 (70 m/s) and hides the alias. Showing it is the honest behaviour that Lane A §6.8 asks for. The UI should show the runner-up's overlay.

**Faithful mode:** `settings.mode: 'faithful'`, or `{mode: 'faithful'}` in `runSearchCore`. It is exactly the Python behaviour.

## 5. Orchestrator note: honest event fits (colsto)

`fitEvent` uses `fitPass`, which adds four things to the plain fit:
1. The residual lag-1 autocorrelation inflates the noise, because STFT frames overlap. The factor is k = (1+ρ)/(1−ρ), 10–37 on colsto.
2. Soft physical priors per class (prop: v 30–100 m/s, d ≤ 4 km) enter as pseudo-residuals.
3. A profile likelihood over d gives the 2σ region in (v, d).
4. A model-error floor of 15 % on v, 25 % on d and 1.5 s on t_cpa is scaled by 1/coverage². Coverage is the fraction of the Doppler swing that was observed.

`poorly_constrained` is set, with readable `reasons`, when coverage < 0.8, the uncertainties are large, the profile is unbounded, or the free fit falls outside the envelope.

| ridge (fixtures/real/colsto_longisland/ridges.json) | free fit | honest result |
|---|---|---|
| ev1 h1, 201–276 s, 172→97 Hz | v 139, d 6270, t_cpa 255.4 | flagged (67 % of the swing seen; outside the prop envelope); v [47, 231] m/s, d [10, 13120] m, t_cpa 255.3 ± 10.6 s, range [234, 276] (covers Lane C's 237.3 s) |
| ev2 h1 | v 79, d 1504 | flagged (71 %); v [32, 126] m/s, d [10, 3024] m, t_cpa 1168.8 ± 3.7 s |
| synthetic, all 5 events | — | not flagged; the truth is inside every v, d and t_cpa±2σ range, including scenario2 Q3 inside a turn (v 48.5 fitted, 64 true, range [32, 65]) |

The frequency ratio on colsto ev1 alone (172/97 over a partial swing) implies v ≥ 96 m/s for *any* straight pass. The free fit is therefore not necessarily wrong: it could be a fast turboprop, or a turning pass. The engine reports this and does not clip it.

In the search, these ranges never hard-prune in robust mode unless the event sets `locked: true`. When the ridge fit is poorly constrained, the hand-entered CPA time is kept and only its prior is widened (`t_sigma_s`).

## 6. API

The API is the same as `geoloc-api.md`. The backward-compatible extras are listed in its new addendum. The main ones:
* `fitEvent(points, {c, cls})` → also returns `poorly_constrained`, `quality.reasons`, `t_sigma_s` and `sigma_total`.
* `runSearch`:
  * accepts `input.dem` (function or `{elevations}`; default Lane B Terrarium z12), `input.audio`, and `settings.{mode, useRidgeFit, workers, config}`;
  * accepts event fields `locked` and `t_sigma_s`;
  * returns `confidence {margin, ambiguous, runnerUp, message}`, per-candidate `margin`, `raw_score`, `penalty` and `level_m`, richer `assignments`, and `stats.timings`/`notes`.
* `fetchFlights` wraps Lane B's `adsb.fetchTracks`. It needs `query.worker` or `globalThis.GEOLOC_ADSB_WORKER`; without one it falls back to the stub's data and adds a note.
* `spec`: any contract dB spectrogram is accepted. It is cropped to the needed band, whitened by median/MAD, and cached.
* The UI switches over with `?engine=real` or with `DEFAULT_ENGINE = 'real'` in `web/ui/engine.js`. That is Lane E's file and I did not touch it.

## 7. Limitations / next steps

* The UI passes Lane C's display spectrogram (16 kHz, nfft 8192, `whiten: 'freq'`). The engine re-whitens it with MAD, but its bin/hop differ from the validated 1.95 Hz / 0.128 s. Passing `input.audio` gives the reference spectrogram.
* Robust mode costs 5–12× the faithful work, because it scores many more survivors. It stays under 3 s in the browser with 16 threads; with 4 threads expect about 1.5–2 s on these scenarios.
* The "one event only" case remains km-ambiguous, as theory predicts.
* Not done: the Gauss–Newton refinement on the track model (MATH §11.2), a time-scale nuisance parameter, and validation on real data beyond the colsto fits.


---

## 8. D8: scale, speed and alias discrimination

Tests: `node --test web/tests/*.test.mjs` runs 51 tests: 49 pass, 0 fail, 2 skipped (network only). The faithful mode still reproduces `result_ref.json` exactly.

New files:
- `web/engine/geoloc/cpa_sparse.js` (sparse CPA);
- `web/engine/geoloc/evidence.js`;
- `web/tests/geoloc_colsto_bench.mjs`, `geoloc_speed_run.mjs`, `geoloc_alias_run.mjs`, `geoloc_browser_colsto.html`;
- `fixtures/scenario_rand/make_rand.py`, which generates `fixtures/scenario_rand101..106`.

### 8.1 Scale on real traffic (orchestrator top priority)

Lane E measured the colsto case (779 flights, 30 h window, about 20–25k grid points) at **1448 s**: filters 1185 s, score 228 s, 582k survivors, near out-of-memory.

| cause | fix |
|---|---|
| Dense delayed-CPA tables, F × N (779 × 25k × 4 Float64 = 620 MB), each cell an argmin over all track samples | `cpa_sparse.js`. Each flight is cut to the time window (T_start window + clip ± 10 min) and to the box (+ reach). Its 5 s polyline is rasterised over the grid lattice; only points within the flight's reach get an entry. Reach = max(audible radius, largest accepted CPA distance). Entries are refined on the 0.5 s samples of the nearest segment ± 1 with the reference parabolic step, so they are identical to the dense tables within reach. Output is CSR sorted by (point, t_dcpa). |
| Offset filter O(F²·N) | Per point and anchor entry, the other events are found by binary search in the sorted delayed-CPA times: O(N·k log k), k = flights within reach. |
| Honest wide fit ranges (d up to 13 km) became 26 km hard gates | In robust mode the d-gate is the physical audibility envelope: 1.34 × the audible radius (4 km for props, 8 km for jets). The entered or fitted range still acts as a soft penalty. |
| Jets (3923 of 5410) rasterised over the whole grid only for the silence filter | Two phases. CPA only for candidate classes. Non-candidate flights go into a space-time index of their 2 s samples (120 s slots × 6 km cells), and each survivor's recording window is checked against it. |
| Unbounded survivors | Pre-cap at 3 × 20000 by prior penalty, then the veto, then a cap of 20000 (`max_survivors`). The coarse prescreen scores only the top fraction. |
| Building and smoothing all tracks on the main thread | Only flights whose raw points fall in the box + 8 km and the time window are built. Non-candidates skip the W = 15 s smoothing. |
| Every track cloned into every worker | Non-candidate tracks go to workers as empty stubs. The spectrogram is sent once and kept in the workers across searches. |
| Lane C's resampler took 75 s for 24 M samples | Integer-factor FIR decimator (`spectro.decimate`): about 1 s. |

Results on `fixtures/real/colsto_longisland/tracks_2026.json` (adsb.lol, 5410 tracks, 30 h window). Events are the one-click honest fits of `ridges.json`; DEM is flat 20 m (offline). Node runs use 16 `worker_threads`. Other lanes were loading the machine, so times are upper bounds.

| case | grid points | pairs within reach | survivors (before veto/cap → scored) | total | stage times (s) | peak RSS |
|---|---|---|---|---|---|---|
| circle 15 km, all 5410 tracks | 17,665 | 1.26 M | 26,592 → 4,712 | **8.5 s** (15.8 s under heavy load) | CPA 1.6, filters 0.11, veto 0.21, score 1.2, refine 0.6 | 1.2 GB |
| circle 15 km, no jets (1487 tracks) | 17,665 | 1.26 M | 26,592 → 20,000 (cap) | 12.7 s | CPA 2.0, filters 0.16, score 4.7, refine 0.8 | 1.2 GB |
| meta bbox 60 × 60 km, all 5410 | 91,200 | 7.54 M | 133,946 → 7,425 | **27.8 s** | CPA 12.4, filters 0.6, veto 0.4, score 2.1, refine 0.6 | 2.1 GB |
| same case before the fixes (bbox, all) | 91,200 | 34 M dense | — | 49 s (CPA 37 s) | | 2.6 GB |
| circle 15 km before the d-cap and decimator | 17,665 | 26 M | — | 96 s (+ 80 s spectrogram) | | 1.4 GB |

**Browser** (Firefox 158, 16 threads, not cross-origin isolated, machine shared with other lanes; circle 15 km, all tracks):

| run | total | breakdown |
|---|---|---|
| cold | 65.7 s | preamble 13.6 s (ridge refits 4.4, track building 8.4); worker init 2.3; CPA 6.2; filters 1.7; score 35.5; refine 3.2 |
| warm (second search in the same page) | 21.6 s | — |

Since that measurement, the preamble fixes (prefilter, no smoothing for non-candidates, profile on ≤ 600 ridge points) roughly halve the preamble. I could not re-measure in the browser because another lane took over the shared Playwright browser. The browser score stage is about 30× slower than Node's for the same 4712 survivors; I attribute it mostly to contention and consider it the next item to profile. The < 30 s target is met warm, not yet cold under load.

### 8.2 Robust-mode speed (synthetic)

Machine-independent bilinear-sample counts; each row adds one change. Accuracy is unchanged in every row.

| change | samples, M (scenario1 / scenario2 / rand103) | best, margin |
|---|---|---|
| D7 robust (full δ × ρ sweep) | 512 / 618 / 866 | — |
| + c2f sweep (every 2nd δ and ρ, then fine ±1 around the best 2 penalised coarse δ; penalty evaluated in-kernel) | 178 / 221 / 283 | identical |
| + prescreen re-centred (the full pass sweeps only ±1.5 s around the cheap pass's T_start) | 141 / 190 / 184 | identical |
| + τ step 0.5 s at the 100 m level | 102 / 129 / 156 | identical |
| + seed pruning (< 50 % of the best) | 102 / 80 / 156 | identical |
| D8 default (+ SNR-envelope weighting, §8.3) | 122 / 71 / 254 | changes results (better) |

Not done:
- A log-frequency axis: the kernel cost is the 4 bilinear loads per sample, not the index arithmetic, so it does not reduce the sample count.
- Re-use of (point, flight) scores across refinement levels: the T_start/F0 sweeps are re-centred at every level, so scores are not reusable. Only the retarded-time solve could be shared, and it is < 5 % of the cost.

### 8.3 Alias discrimination

Table from `node web/tests/geoloc_alias_run.mjs` (and `--auto`). Each cell: error in metres / margin; `A` = ambiguous (margin < 0.1); `x` = wrong answer. Scenarios: scenario1, scenario2 and 6 randomized scenarios (seeds 101–106: 2–3 prop events, turns, accelerations and climbs, source levels ±6 dB, noise ×0.8–1.6, distractors and a jet).

| scenario | D7, entered events | D8, entered events | D8 + T_start metadata ±60 s | D7, honest auto events | D8, honest auto events |
|---|---|---|---|---|---|
| scenario1 | 25 / 0.012 A | 25 / 0.082 A | 25 / **0.264** | 25 / 0.040 A | 25 / 0.092 A |
| scenario2 | 16 / 0.671 | 16 / 0.728 | 16 / 0.728 | 16 / 0.717 | 16 / 0.735 |
| rand101 | 67 / 0.144 | **21** / 0.228 | 21 / 0.228 | 67 / 0.123 | 33 / 0.227 |
| rand102 | 53 / 0.255 | 53 / 0.236 | 53 / 0.236 | 53 / 0.263 | 53 / 0.240 |
| rand103 | **16025 x** / 0.179 | **27** / 0.388 | 27 / 0.388 | 16025 x / 0.205 | **27** / 0.346 |
| rand104 | 7 / 0.473 | 7 / 0.420 | 7 / 0.420 | 7 / 0.486 | 7 / 0.424 |
| rand105 | 18 / 0.386 | 18 / 0.272 | 18 / 0.272 | 18 / 0.361 | 97 / 0.240 |
| rand106 | 20 / 0.013 A | 20 / 0.064 A | 20 / **0.240** | 6433 x / 0.159 | 6503 x / 0.054 A |

What worked, in order of effect:
1. **Matched filter on the predicted amplitude envelope** (`weighting: 'snr'`, robust default; MATH §11.3). Each curve sample is weighted by w = max(0, 1 − ΔPL(R)/15 dB), where ΔPL is the path loss (20 log R + 3 dB/km) relative to the CPA; samples count out to 2 × the audible radius. This replaces the hard 3 km window.
   - Before, a pass 2.9 km away could score only its loud 28 s centre: that is how rand103 failed, with distractors D2+D3 16 km away.
   - Now it must match over the long, slowly fading window it implies.
   - Effect: fixes rand103 and raises the scenario1 margin 0.012 → 0.082 (the D7 robustness variants also go 0.007 → 0.08). Wrong-flight answers drop from 3/16 to 1/16.
   - Cost: margins on already-clear cases drop slightly (rand104/105).
2. **T_start prior from file metadata.** A ±60 s window around a (deliberately 37 s offset) creation time is soft in robust mode. It turns both remaining ambiguous cases clear (0.26, 0.24). The UI should always pass `time` from the file metadata when present.
3. **Source-level consistency evidence** (`evidence.js`). Received level near each CPA + PL(d) gives each event's implied source level; inconsistent levels across events are penalised (σ = 6 dB, λ = 0.1). True hypotheses come out within about 4 dB; aliases 9–15 dB apart. Effect: +0.01–0.05 margin (scenario2 0.709 → 0.728, rand103 0.335 → 0.388). It is kept small on purpose because real absorption is uncertain.
4. **ADS-B ground speed vs Doppler-implied speed:** the `v_est`/`d_est` Gaussian priors from the honest fit. Used in the auto-event columns.
5. **Silence consistency** (unassigned flights within 8 km that should be heard): implemented, but it never fired on these scenarios.

Not implemented: harmonic-structure consistency (harmonic ratios per aircraft).

Remaining failures:
- rand106 with auto events: the true second pass is essentially inaudible (2 dB above the noise, event score 0.12). Both the truth and the alias then rest on noise, and the result is correctly flagged ambiguous. Metadata fixes it.
- The orchestrator's "pure one-click, scenario1, alias wins by 1.1 %" is fixed: with honest auto events, scenario1 now finds the truth (25 m, margin 0.092, flagged ambiguous).

Regressions in the D7 robustness variants under D8 (`geoloc_robust_run.mjs robust`):
- "no v/d filter" is fixed: 8239 m → 25 m.
- "one event + T_start ±2 s": 25 → 155 m, margin 0.001 (ambiguous anyway).
- All other variants: 25 m, margins about 0.08.

### 8.4 Defaults now

Robust mode uses:
- sweep `c2f` and weighting `snr`;
- evidence when a raw spectrogram is available;
- per-seed re-centring;
- d-gate = physical envelope;
- 20000-survivor cap and two-phase veto.

Faithful mode (`settings.mode: 'faithful'`) is still the bit-exact Python reference.


---

## 9. D9: browser scoring speed (the "30× slower than Node" question)

Method:
- The browsers are my own headless Playwright 1.48.2 instances (Firefox 131.0, Chromium 130.0.6723.31). The driver script is in the scratchpad, with its own static server, optionally sending COOP/COEP headers. The shared MCP browser was not touched.
- New pages: `web/tests/geoloc_kernel_bench.html` (with `geoloc_kernel_bench_lib.mjs` and a Node twin, `geoloc_kernel_bench.mjs`) and `web/tests/geoloc_browser_colsto.html`.

**Kernel micro-benchmark.** Fixed robust c2f job on scenario1: 256 survivors × 2 events, 91.8 M bilinear samples.

| | main thread | 1 worker | 16 workers (wall) |
|---|---|---|---|
| Node 22 | 12.3–14.1 ns/sample | 14.3–17.0 | 2.2–3.9 |
| Firefox 131 | 13.4–14.7 | 17.9–20.6 | 2.5–3.3 |
| Chromium 130 | 13.0–13.4 | 16.7–18.1 | 2.5–3.7 |

**Conclusion: the 30× was environmental, not the code.**
- The kernel runs at the same speed in all three engines. There is no SpiderMonkey deopt and no Float64/Math penalty.
- The pool is used in the browser, and the spectrogram is cloned once per worker per search (cached across searches), not per task.
- The 35 s score stage was measured in the shared MCP Firefox 158 while Lane E was driving it, on a machine loaded by other lanes.

**Colsto end to end, cold** (a fresh browser process per run; 16 workers; one-click honest events; flat DEM):

| case | Firefox 131 | Chromium 130 |
|---|---|---|
| 15 km circle, 17.7k points, 5410 tracks, 30 h | **10.5 s** (CPA 1.2, filters 0.3, veto 0.35, score 1.3, refine 0.9; preamble 2.0) | **8.3 s** |
| 60 × 60 km box, 91k points, 7.5 M pairs → 7424 survivors | **18.7 s** (cross-origin isolated: 15.8 s) | **10.8 s** (isolated: 11.0 s) |

Target < 30 s cold: met in both browsers, with identical results across browsers and Node.

What remains on the main thread in the box case:
- grid + proximity mask: 2.4 s in Firefox;
- CSR merge of the CPA entries;
- track building.

These are the next candidates to move into the workers if needed.

**Performance budget test** (`web/tests/geoloc_perf.test.mjs`, part of `node --test web/tests/*.test.mjs`):

| check | measured | budget |
|---|---|---|
| kernel work (deterministic) | 91.8 M samples | ±1 M |
| kernel speed | 13.5 ns/sample | < 60 ns/sample |
| robust scenario1 work (D7 was 512 M) | 121.7 M samples, 1.9 s | < 140 M samples, < 30 s |
| colsto, 15 km circle, inline: sparse pairs | 1.26 M | < 1.5 M |
| colsto: survivors scored | 1589 | ≤ cap |
| colsto: filters / veto | 0.12 s / 0.13 s | < 10 s each |
| colsto: spectrogram | 1.6 s | < 15 s |
| colsto: search | 10.2 s | < 120 s |

The work counters catch algorithmic regressions independently of machine load.


---

## 10. D10: colsto solved by the JS engine (following Lane A's diagnosis)

Tests: `node --test web/tests/*.test.mjs` runs 60 tests: 58 pass, 0 fail, 2 skipped. They include the colsto acceptance test in `geoloc_perf.test.mjs`.

**Result.** With one-click honest events (ridge h1 of each event, class prop), 5410 tracks and the 30 h window:

| run | position | distance to Lane A (40.8762, −73.5251) | flights | T_start | time |
|---|---|---|---|---|---|
| full 60 × 60 km box | **40.87611, −73.52338** | **142 m** | **a1dfeb CST1219 PC-12 + ace391 EGE93 B350** (same as Lane A) | 20:49:11.03Z (Lane A 20:49:11.22) | Node, 16 workers: 22.4 s. Cold browser: Firefox 131 18.6 s, Chromium 130 17.4 s |
| 15 km circle (acceptance test) | 40.87585, −73.52373 | 118 m | same | ΔT −0.16 s | inline single thread: 42 s |

- Confidence: "best is 88 % (box) / 146 % (circle) above the next distinct alternative".
- Ridge RMS of the winner: 0.38 % / 0.72 % (Lane A: 0.47 %).

**Changes** (robust mode only; faithful mode is still the bit-exact Python reference):
1. **Engine-aware reach.** Each built track carries an engine class from the ICAO Doc 8643 descriptor in `web/data/types.json`: L1P piston, L1T/L2T turboprop, H…P/T heli, …J jet. Reach (audible radius) in robust mode:

   | piston | turboprop | heli (piston / turbine) | jet | unknown prop |
   |---|---|---|---|---|
   | 4 km | 9 km | 4 / 6 km | 6 km | 8 km |

   The reach is used by the sparse CPA, the silence check and the score window. The event d-gate is the class maximum (9.5 km for props). The sparse CPA keeps the work bounded: 11.2 M pairs on the full box.
2. **Physical bounds only.** Fit-derived v/d ranges never gate. They give only the weak soft-L1 penalty of §4. The colsto event-2 fit (v ≈ 77 m/s, d ≈ 1.4 km against the true 103 m/s / 3.7 km) costs the truth only about 0.01.
3. **Soft silence.** Lane A's true hypothesis has 2 unassigned props within 3 km during the recording. In robust mode the silence filter and the jet veto now add a penalty per audible unassigned flight (χ² 2.47 each, at most 3) instead of removing the hypothesis.
4. **Ridge misfit in the objective.** For events that carry their tracked ridge (`event.ridge`, fundamental, ≤ 150 points), the kernel computes for every δ the RMS of log f_ridge − log ρ(t), with F0 profiled out. The ρ grid comes from the same retarded-time simulation.
   - Combined objective: S = spectrogram score − penalties − μ·Σ_e log(rms_e / 0.5 %), μ = 1 (`ridge_weight`). It is used inside the c2f δ choice and in the final argmax.
   - Comparison on colsto (full box): spectrogram only (μ = 0) gives a wrong pair 28.8 km away. μ = 1 and μ = 3 both give the true pair (142 m and 109 m).
   - The orchestrator's offset tolerance ±15 s is covered: the robust offset gate is ≥ 30 s, with a soft σ_t of 8 s.
5. **Margin definition.** A distinct alternative is now a different flight assignment ≥ 1 km away, or anything ≥ 3 km away. The same pair 1 km along the weakly constrained direction (6 km CPA) was flagged as "ambiguous 0 %"; it is position uncertainty, not an alias. Margins are normalised by max(|best|, 1) because the combined objective can be ≤ 0.
6. **Split legs.** a1dfeb arrives as separate legs with 24–26 points at about 20 s spacing. Each leg is its own track, and the W = 15 s smoothing correctly leaves such sparse knots raw.

**Synthetic checks.**
- Faithful: unchanged (25.3 / 16.1 m, identical to Python).
- Robust, entered events: unchanged (scenario1 25 m, margin 0.082; scenario2 16 m; rand101–106 as in §8.3).
- Robust, auto events that now carry their ridges: margins rise sharply. scenario1 goes from 0.092 (ambiguous) to 0.324 (clear); rand101/102/104 go above 1.
  - Regression: rand105 97 → 194 m.
  - Still wrong: rand106, whose second pass is inaudible, so its ridge is noise. It is flagged ambiguous.
- D7 robustness variants: all as in §8.3 (25 m; "one event + T_start ±2 s" 155 m).

**Performance-budget updates** (legitimate changes in work):
- robust scenario1: 150.9 M samples (budget raised 140 → 180 M; soft silence keeps 974 instead of 671 coarse survivors);
- colsto circle: 1.89 M pairs (budget raised 1.5 → 3 M; turboprops reach 9 km).

The colsto acceptance (< 300 m from Lane A, same flights, T_start ±2 s) is now part of the suite.


---

## 11. D11: absolute verdict, montages, ground-ops filter

Tests: `node --test web/tests/*.test.mjs` runs 63 tests: 61 pass, 0 fail, 2 skipped. New: `geoloc_d11.test.mjs`. The colsto acceptance now also requires verdict `match`. Faithful mode is unchanged, and no performance budget needed changing.

### 11.1 Absolute fit-quality test (`web/engine/geoloc/verdict.js`)
The margin only compares candidates with each other. The new test asks whether the best candidate is plausible at all, per event.

- **Spectrogram permutation null.** The candidate's predicted curve is re-scored, with the same local δ × ρ sweep, at:
  - 40 time shifts: 25–240 s, restricted to shifts that keep the curve inside the recording (montage clips are 20–30 s long);
  - 8 F0 offsets of ±4–12 %;
  - 16 mixed copies.

  Then z = (s − median) / max(1.4826 MAD, 0.02).
- **Ridge null** (when the event carries its tracked ridge). The robust misfit (1.4826 MAD of log f_ridge − log ρ, F0 profiled out) is compared with the same misfit at the null shifts. The ρ grid covers ridge + shifts, and all points are required. Ratio = misfit / median null misfit. If the flight's track does not cover the ridge's time span, the event is marked "uncovered".
- **Per-event status.**
  - With a ridge, the ridge decides: ≤ 0.15 good, > 0.6 bad, else moderate. On cluttered real audio the spectrogram z is weak even for the truth (colsto event 2: z = 0.2), as Lane A found.
  - Without a ridge, the z decides: ≥ 5 good, < 2 bad.
  - An unexplained or uncovered event is bad.
- **Verdict:** `match` if every event is good, `no plausible match` if any event is bad or there is no candidate, otherwise `weak`. It comes with readable reasons and appears as `result.confidence.absolute` and `confidence.verdict`.

Calibration (all through the public API; the Catalonia runs use Lane K's blind runner `web/tests/cat_run.mjs`, robust):

| case | expected | verdict | key numbers |
|---|---|---|---|
| colsto (real) | match | **match** | ridge ratio 0.01 / 0.05; spectrogram z 2.8 (event 2 z 0.2: carried by the ridge) |
| scenario1, scenario2, rand101–106, entered events | match | **match** (all 8) | weakest-event z 7.2–45.8 |
| the same with auto events (ridges) | match | **match** (7); rand106 → **no plausible match** | ridge ratio 0.009–0.09 at the truths. rand106's answer is 5.9 km wrong: its event 2 has z −0.4 and ridge ratio 1.04 |
| scenario1 with P1/P2 removed | not a match | **no plausible match** (no candidate) | — |
| Salou S0 (15 km wrong, margin 0.34) | weak / no | **weak** | ridge ratio 0.20 |
| Salou S1, S2 | weak / no | **no plausible match** | the CN-235 track does not cover the ridge span |
| Patrona A, B, C (score ≤ 0) | no | **no plausible match** | score 0, outside audible range, track does not cover the ridge |
| Terrace E12 (no flights) | no | **no plausible match** | no candidate |

### 11.2 Montages (`web/engine/geoloc/montage.js`)
API:
- `events[].clip` (any id), plus optional `input.clips: [{id, t0, t1}]` (audio spans; default: the clip's events ± 90 s);
- each clip has its own unknown T_start; time-offset pairing happens only within a clip, and silence is checked only inside the clip's own span (`audio_window`).

Given the observer, the evidence is separable, so the search is:
1. one `runSearchCore` per clip on the same grid;
2. sum of the per-point best scores across clips (a clip with no survivor at a point gets −1 below that clip's worst score);
3. common 100 m → 50 m refinement around the top 3 distinct seeds (≥ 2 km apart).

Candidates carry `t_start_by_clip`, and `assignments[].clip` / `t_start_unix`.

Validation is a synthetic montage: scenario2 cut into 3 clips of ±90 s around each pass, re-ordered C, A, B (522 s; the true T_start differs per clip).

| input | error | flights | T_start error per clip | verdict | time |
|---|---|---|---|---|---|
| with clip ids | **30 m** | Q3+Q1+Q2 (correct) | −0.51 / +0.71 / −0.35 s | match | 13.9 s on 8 Node workers |
| same input without clip ids | 2.9 km | — | — | **no plausible match** | — |

ksmo was not run: Lane F's segmentation would first need to be converted into events with clip ids.

### 11.3 Ground-ops filter (`flyoverCheck` in `geoloc.js`)
An event is classed as a flyover only if its ridge is a falling Doppler curve with a real swing. Otherwise:

| class | rule | meaning |
|---|---|---|
| `rising` | median of the last 20 % − first 20 % > +1 % | rpm increase, start-up, take-off roll |
| `static` | swing (p95 − p5)/median < 2 %, or no falling trend | run-up, hover, constant tone |
| `step` | the median-smoothed 90 % → 10 % transition < 1.5 s | throttle/rpm step; a Doppler swing needs ≥ 2.67·d/v, ≥ ~3 s for any airborne pass |

- `fitEvent` returns `flyover`.
- `runSearch` excludes non-flyover events by default (`settings.keepGroundOps` keeps them) and lists them in `excluded_events` and `stats.notes`.
- If nothing is left, it returns no candidates with verdict `no plausible match`.

On real ridges:
- Lane K's terrace ev0 ("looks like a step") is classed **step** (transition 1.0 s).
- Every other real pass is a flyover: Salou, Patrona, terrace ev1, and colsto (transitions 3.8–49 s).
- The synthetic passes take 18–52 s.


---

## 12. D12: blind real montage, KSMO 2024-07-09

Runner: `node web/tests/geoloc_ksmo_montage.mjs 16 [--chrono] [--tails]`, which writes `fixtures/real/ksmo_2024-07-09/run_montage_*.json`. Tests: 66 total, 64 pass, 0 fail, 2 skipped.

**Blind inputs:**
- `audio.wav` (1327 s), `tracks.json` (3956 tracks) and the local day as the T_start window (2024-07-09 07:00Z → 07-10 07:00Z);
- region: a 15 km circle centred 5.0 km from KSMO at a random bearing;
- cuts: `web/ui/segment.js` `detectCuts` gives 56 cuts and 57 clips;
- events: one automatic "click" per clip at the strongest whitened tonal point in 50–400 Hz, extended with Lane E's `extendRidge` (harmonics 1–3, falling), then `flyoverCheck` and `fitEvent`. That gives 19 flyover events in 19 clips; 1 static and 1 rpm-step clip were skipped.

Lane F's labels and combined estimate were read only by the evaluation.

| run | error vs Lane F (34.01862, −118.44960) | right tail number | verdict | runtime (16 Node workers) |
|---|---|---|---|---|
| blind, clips independent | **197 m** | **0 / 19** | weak (4 good, 5 moderate, 10 bad clips) | 89 s |
| blind + chronological prior | 479 m | 1 / 19 | weak | 89 s |
| **tail-number hints** (`event.reg`, from the video description) + chronological prior | **231 m** | **16 / 19** (the 3 misses are jets: Phenom 300/100) | weak (4 / 5 / 10) | 101 s |

All three errors are inside Lane F's ±250–700 m; for reference, the ARP is 350 m from Lane F's estimate.

**Per-clip T_start vs Lane F** (hinted run; clip start = T + clip t0):

| agreement | clips |
|---|---|
| within 1–15 s | N338DK +2 s, N67CM (2nd) −1 s, N353DS +4 s, N67CM −9 s, N58504 −12 s, N796SP −15 s |
| 41–54 s | N6409U, N201XQ |
| a different pass of the same aircraft (circuits; Lane F's own per-pass scores tie, e.g. N796SP p3 2.161 vs p7 2.160) | N201XQ ×2, N2902S, N36PJ, N785AM, N355JS, N148AC |

**Diagnosis of the blind failure.**
- A fence-side observer at a runway hears every landing and take-off on 03/21 with nearly the same Doppler curve: same path, 20–40 m/s, CPA about 100 m. With a free T_start per clip, each single-event clip matches whichever runway pass of the day fits best.
- A per-clip check at Lane F's location (labelled aircraft against unrestricted): the labelled aircraft wins only about 8 of 19 clips even at the right place.
- So the position is right (every runway pass is abeam the same fence) but the flight identities are not.
- The chronological prior does not fix this. It is a DP over the top-6 survivors per clip and point, with a soft penalty of 1 score unit per order inversion; the right passes are mostly not in the per-point top-6.
- Identity needs extra information. Tail numbers (the product feature `event.reg`) give 16/19, and the chronological prior then selects a consistent pass sequence. This is what Lane F did.
- The per-clip verdict is weak in all runs. It cannot separate a right runway pass from a wrong one either, because the ridge fits are equally good. The montage verdict is a fraction rule: match ≥ 60 % of clips good, weak ≥ 30 % good or moderate.

**Changes made for D12.**
1. **Scale for single-event clips.** Each clip searches the whole day, so every runway pass is a candidate (60k survivors per clip). Two fixes:
   - a well-constrained ridge fit now also supplies Gaussian `v_est`/`d_est` (the Doppler-implied speed and CPA distance against the ADS-B track at the candidate), so the survivor cap ranks meaningfully; poorly constrained fits stay range-only;
   - montage refinement keeps, per clip, only the anchor flights of the coarse top survivors within 1 km of the seed (≤ 12).

   Runtime went from about 35 min (projected) to 89–101 s.
2. **Candidates carry the pass the search used** (`tdcpa`). Legs with several circuits made the verdict and assignments recompute a different pass with a global `cpa()`.
3. **Ridge coverage.** The verdict's robust ridge misfit skips ridge points outside the track's valid time (ADS-B starts at lift-off while the ridge includes the ground roll) and requires ≥ 70 % coverage.
4. `config.montage_chrono` (soft chronological prior, `montage_chrono_penalty`); `event.reg` tail-number hints (restriction to tracks with that registration or callsign); `config.anchor_flights`; per-event `allowed_flights`.


---

## 13. D13: unexplained (outlier) events and single-event caution (Lane V2 cases)

Tests: 67 total, 65 pass, 0 fail, 2 skipped. Perf budgets are unchanged and green. Regressions checked:
- colsto: `match` at the same spot (118 m from Lane A);
- scenarios and rand: errors unchanged;
- D7 robustness variants: unchanged;
- KSMO montage (hinted): 231 m, 16/19, weak, 74 s.

**Changes (robust mode; faithful mode is still the exact Python reference):**
1. **Outlier events** (`filters.js`). Each event is either matched to a flight or *unexplained*, at a fixed cost of U = 1 score unit (`soft.unexplained_chi` = 2U/λ = 40).
   - Hypotheses are seeded from every event as anchor; the other events are matched greedily inside the offset gate.
   - Each hypothesis is counted once: its anchor must be its first explained event. That is O(N·E·k log k).
   - At least 2 events must be explained, or 1 when T_start is known to ±120 s (`min_explained`).
   - Unexplained events score 0 and add no ridge, offset or v/d terms.
   - Candidates list `unexplained_events`, and their assignments carry `flight: null`.
   - Calibration: U = 1 is more than any real match costs. A matched event contributes its score (> 0 for real passes) plus a ridge term that turns positive only above about 0.5 % misfit. So a hypothesis with every event explained beats the same one with an event dropped whenever the flight fits; on colsto and the synthetic scenarios the results are unchanged.
   - Cost: scenario2 (3 events) now also scores its 2-of-3 hypotheses, 71 → 351 M samples. Two-event cases are unchanged.
2. **Verdict on the explained events only**, with the reason "k of E events left unexplained … events …". Because dropping events adds model freedom, a verdict with unexplained events is lowered one level (match → weak, weak → no plausible match).
3. **Single explained event and unknown T_start → never more than `weak`.** The reason states that the position is km-ambiguous along the track. `confidence.absolute.ambiguity_km2` reports the area of coarse cells within 10 % of the best score.
4. **Robustness fixes found on the way:** the verdict crashed on unexplained events (now skipped); its fallback on an internal error is now `no plausible match` (it was `weak`); and a D11 status override no longer turns 'unexplained' into 'bad' outside montages.

**Lane V2 cases, blind** (`node web/tests/cat_run.mjs fixtures/real/<case> --modes robust`, unmodified; evaluated afterwards against `meta.json`):

| case / run | before (V2 report) | after D13 |
|---|---|---|
| Egelsbach 2025 H1 (6 events) | no candidate | 3.68 km, **no plausible match**; events 2, 4, 5, 6 unexplained, 2 explained by aircraft 3d4101 (two legs) |
| Egelsbach 2025 ORACLE ev4+ev5 (not blind) | 0.73 km, no plausible match | 0.73 km, no plausible match (true pair DEIGR + DERIS; its evidence is weak: DEIGR's track has 94 s gaps) |
| Egelsbach 2025 S0–S5 (single events) | 0.42–13.2 km, **all `match`** | the same errors, **all `weak`** (ambiguity 0.02–0.07 km²) |
| Egelsbach 2023 H1 | no candidate | no candidate (coverage) |
| Teuge 2026-04 H1 | 1.66 km, no plausible match | 1.20 km, **no plausible match**; event 2 unexplained |
| Teuge S0 / S1 / S2 | no / no / **match** (1.74 km) | no / no / weak |
| KSMO live 2023 H1 | 2.58 km, no plausible match | 2.58 km, no plausible match (all 4 explained, no low-level coverage) |
| Malvern A | 20.5 km, no plausible match | 11.7 km, **no plausible match**; events 2, 4 unexplained |
| Malvern A, wide window | 21.2 km, no plausible match | 5.24 km, **no plausible match**; events 1, 3 unexplained, 2 explained by CFARA SC7 (the jump ship) + another |
| Malvern S0–S3 | 8.0 / 2.3 / 22.4 / 23.5 km: match / weak / no / weak | the same errors: weak / weak / no / weak |

**Outcome.**
- No run is confidently wrong. Every single-event `match` (errors up to 13 km) is now `weak`.
- Every multi-event run says `no plausible match` or has no candidate, and names the events no flight explains.
- None of the V2 cases is located. In Egelsbach 2025 the blind search prefers a pair of legs of one circuit aircraft (3d4101: −3.87 including the 4 unexplained-event costs) over the true pair (−0.83 − 4 = −4.83). The true pair's own evidence is weak (sparse DEIGR track, speech-masked approaches), so a lower unexplained cost would not fix it.
- Partial matching did turn "no candidate" into an explained, honestly flagged answer.
- Side effect: the synthetic montage given *without* clip ids now returns 3.0 km and `weak` (it was `no plausible match`), because two of its three events can be explained at one T_start.


---

## 14. D14: ADS-B gap handling

Tests: 67 total, 65 pass, 0 fail, 2 skipped. colsto: still `match` at the same spot (118 m from Lane A). Synthetic verdicts unchanged (scenario1/2, rand101–106 all `match`). Faithful mode and helper-built test tracks have no gap model, so the reference reproduction is unchanged.

**Changes (robust mode; the API builds tracks with `settings.gapS`, default 20 s).**
1. **Kinematic gap interpolation** (`track.js`). For knot gaps > 20 s, the horizontal path is no longer the cubic between distant points:
   - it uses a constant turn rate and linearly varying speed from one-sided end velocities taken from the neighbouring legs;
   - of the turn rates dh, dh ± 2π (circuits often turn the long way), the one with the smallest end mismatch is kept, and the mismatch is blended in linearly;
   - stored as a 1 s table; the vertical stays Hermite.

   If the mismatch exceeds 30 % of the chord, the model is inconsistent with the data, so the Hermite cubic is kept. A gap is **uncertain** when its end mismatch exceeds 60 m (the aircraft manoeuvred), or for ground/hover legs.
2. **Scoring.**
   - Curve samples emitted inside uncertain gaps ≥ 60 s get weight 1/(1 + (err/500 m)²) in the numerator only, so they shrink toward zero evidence instead of renormalising the mean onto the tails.
   - Ridge points inside uncertain gaps are skipped in the misfit; a ridge that is mostly inside a gap counts as unverified (a mild 1 % misfit, not a free pass).
   - The time-offset σ per (survivor, event) is inflated to ≥ gap length / 4 when the assigned flight's CPA lies inside a gap.
3. **Verdict.** Ridge points inside gaps are treated as unknown. A ridge more than 70 % inside a gap is "unverifiable" (moderate), not a misfit. Each event reports `gap_fraction` (ridge) or `curve_gap_fraction`, with a reason when it exceeds 20 %.

**Results.**

| case | before D14 | after |
|---|---|---|
| Egelsbach 2025 ORACLE ev4 + ev5 (true pair DEIGR + DERIS) | 733 m, ΔT −25 s, no plausible match | **190 m, ΔT −5 s, weak** (DEIGR: 82 % of its ridge inside its 94 s gap, unverifiable; DERIS ridge ratio 0.17) |
| Egelsbach 2025 blind H1 (6 events) | 3.68 km, no plausible match | 3.68 km, no plausible match (1.07 km with a 200 m / all-gaps weight scale, which however broke scenario2) |
| Teuge 2026-04 H1 | 1.20 km, no plausible match | **0.09 km**, no plausible match (ΔT +376 s; event 3 unexplained, one explained event bad) |
| scenario1 gap at CPA 30 / 60 / 90 s, entered events | 16 / 41 / 62 m (gap model off) | 16 / 41 / **16 m**, all `match` |
| the same, auto events (ridges) | 16 / 41 / 62 m | 16 / 41 / **16 m**, all `match` |
| scenario2 gap 30 / 60 s | 28 / 28 m | 75–82 / 129 m (correct flights; `match`, or `weak` with auto events at 60 s) |
| scenario2 gap 90 s | 183 m match (entered), 3.7 km (auto) | 3.7 km weak (entered), 1.6 km no plausible match (auto) |

**Limitation.** For a pass that turns *into* its CPA (scenario2 Q3), a constant turn rate over the whole gap is the wrong shape: the cubic happens to bridge it better, and the end mismatch over-states the uncertainty. That costs 50–100 m at 30–60 s gaps and loses the 90 s case.

The weight scale is a trade-off. Stronger down-weighting (200 m, all gaps) suppresses suspicious gappy tracks: in Egelsbach blind, DEWWF has 222 s / 5 km and 57 s / 1.9 km gaps. That brought Egelsbach blind to 1.07 km, but it broke scenario2 (2.9 km). The features available (gap length, end mismatch) do not separate the two situations. Better: use the ADS-B *reported* velocity/track when available, and add a turn-into-CPA template; both are left for a later step.


---

## 15. D15: reported ADS-B velocities across gaps

Tests: 67 total, 65 pass, 0 fail, 2 skipped; colsto unchanged (`match`, 118 m).

**Data contract (backward compatible).** Tracks may carry an optional `vel: [[gs_mps, track_deg_true, vrate_mps], ...]` aligned with `points`; `points` keeps exactly 4 elements. Edits:
- `ref/data/fetch_adsb.py`: readsb fields 4/5/11 (else 7); the coverage loop now reads `p[:4]`;
- `web/engine/adsb.js`: `traceToTracks`, and the tile merge keeps `vel` attached to its point;
- `docs/CONTRACTS.md` and `docs/DATA.md` document the field.

The adsb tests still pass (9/9).

**Engine** (`track.js`, robust mode; `settings.useReportedVel`, `velLagS` = 2.75 s):
- the reported velocity at t + 2.75 s is taken as the velocity at t (Lane F's lag);
- speeds > 150 m/s are ignored for non-jets;
- a gap > 20 s with reported velocities at both ends uses a Hermite with those tangents;
- that gap is uncertain only if the cubic needs a peak acceleration a_max > 2 m/s² (u = a_max / 4 m/s², weight 1/(1 + u²)). A real turn passes this physical test; a suspicious gap does not;
- gaps without reported velocities keep the D14 model.

**Synthetic validation.** Reported velocities were generated from the true kinematic paths with a 2.75 s lag and noise (`fixtures/golden_js/make_tracks_vel.py` → `scenario{1,2}_tracks_vel.json`). Results with the gap at the CPA:

| case | no gap model | D14 | **D15 (reported velocity)** |
|---|---|---|---|
| scenario1, 30 / 60 / 90 s, entered | 16 / 41 / 62 m | 16 / 41 / 16 m | **16 / 16 / 40 m** |
| scenario1, auto events | 16 / 41 / 62 m | 16 / 41 / 16 m | **16 / 16 / 40 m** |
| scenario2, 30 / 60 s, entered | 28 / 28 m | 82 / 129 m | **28 / 75 m** |
| scenario2, 30 / 60 s, auto | 28 / 28 m | 75 / 129 m (60 s weak) | **28 / 75 m**, match |
| scenario2, 90 s, entered | 183 m match | 3.7 km weak | **293 m** weak |
| scenario2, 90 s, auto | 3.7 km no match | 1.6 km no match | 3.7 km no match |

D15 resolves most of the D14 trade-off on synthetic data. The remaining 90 s case loses most of Q2's and Q3's CPA turns.

**Real cases** (Lane V2's track sets with `vel` merged by id/time from a re-fetch; scratch copies, Lane V2's fixtures untouched):
- Egelsbach oracle: 190 m, ΔT −5 s, weak (unchanged from D14).
- Egelsbach blind: 3.68 km, no plausible match (unchanged).
- Teuge: 90 m, no plausible match (unchanged).

Reason: the aircraft that matter are **MLAT-only** (DEWWF/3d4101 and DEIGR/3d1a75: `sources: ['mlat']`). MLAT positions carry no track angle, and their speeds are unreliable (393 m/s for a DV20). So the reported velocity is absent exactly where the gaps are (88 % of Egelsbach points and 57 % of Teuge points have gs + track; the gappy MLAT aircraft have none). A position-only plausibility test for MLAT gaps would be the next step.

**Teuge: is the matched flight the true one?** Partly.
- **Event 2** is matched to **PH-FMO (C172)**, whose single runway pass (233 m from the spot, 48 m altitude) happens at audio ≈ 3115 s at the true T_start. That is the time of **event 3**. The engine fitted the true aircraft and the true pass to the *wrong event*, which is why T_start is off by +376 s (≈ 3113 − 2743 s).
- **Event 1** is matched to **PH-ZEF (Pipistrel Velis)**, which is 1.5–1.8 km from the spot at the event time: not the true aircraft.
- **Event 3** is unexplained.
- At the true times of events 1 and 2 the only ADS-B traffic within 1.5 km of the spot is a glider (PH957), so their aircraft are not in ADS-B.
- The 90 m position error comes from PH-FMO's runway pass being abeam the spot. The verdict `no plausible match` is correct.


---

## 16. D16: montage verdict consistent with its segments (Salou)

Tests: 67 total, 65 pass, 0 fail, 2 skipped.

**Cause.** The aggregation threshold and a skipped uncovered-ridge check were ruled out. The montage verdict inherited D14's rule "ridge mostly inside an ADS-B gap → unverifiable → *moderate*":
- the CN-235 (3432cd) is an MLAT track with 20–80 s point spacing, so 82–100 % of every clip's ridge lies inside track gaps;
- all 3 clips became "moderate";
- the montage rule then accepted 'weak' (≥ 30 % good or moderate) at 15.1 km.

The per-segment runs never reached that branch: S0's ridge is "uncovered" (bad).

**Fix (no threshold tuned).**
1. An unverifiable ridge is not supporting evidence. The event falls back on its spectrogram permutation z: bad if z < 2 or score ≤ 0, else at most moderate. An uncovered ridge stays bad, as before.
2. In the montage fraction, moderate clips count half: weak needs (good + ½·moderate)/E ≥ 30 %.

**Results.**

| case | before | after |
|---|---|---|
| Salou montage | weak, 15.1 km | **no plausible match** (clips: bad, bad, moderate) |
| Salou segments S0 / S1 / S2 | — | no plausible match / weak / weak (S1, S2: their own ridge fits the CN-235, but a single event without a known start is capped at weak) |

Unchanged:
- colsto: match;
- scenarios and rand: all match;
- synthetic montage: match;
- KSMO hinted montage: weak, 231 m (4 good + 5 moderate of 19 = 34 %);
- Egelsbach oracle: weak, 190 m;
- all V2 multi-event runs: no plausible match (Malvern A now 4.5 km instead of 11.7 km).
