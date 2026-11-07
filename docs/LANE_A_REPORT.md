# Lane A report — theory + Python reference implementation

## 1. What was built

| path | content |
|---|---|
| `docs/MATH.md` | derivations: retarded time (existence/uniqueness, fixed-point vs Newton convergence), exact vs first-order Doppler (error table), **closed-form exact straight-pass curve** `f(T) = F0/(1−β²)·[1 − βT/√(T²+τ0²)]`, identifiability of (F0, v, d, t_c), harmonics, DEM/altitude datums, wind (exact uniform-wind Doppler), temperature, ground reflection, recording artefacts, sensitivity / identifiability (1 vs 2 vs 3 events, GDOP of the time offset), improvements |
| `ref/doppler_ref/geo.py` | exact WGS84 ⇄ ECEF ⇄ ENU |
| `ref/doppler_ref/track.py` | contract track JSON → C¹ cubic Hermite in ENU (positions + analytic velocity), optional local-quadratic smoothing (W = 15 s default in the pipeline) |
| `ref/doppler_ref/doppler.py` | Newton retarded-time solver (vectorised over observers × times), exact / first-order Doppler, closed-form straight-line model, CPA / delayed-CPA tables, audibility radii |
| `ref/doppler_ref/spectrogram.py` | contract spectrogram (Hann STFT, dB), per-bin whitening, bilinear sampling, multi-harmonic curve score |
| `ref/doppler_ref/synth.py` | audio synthesiser: harmonic prop / broadband jet sources, 1/r + excess attenuation, phase-integrated Doppler, **independent forward model** (dense emission grid, exact uniform-wind propagation), noise + hum + gust clutter |
| `ref/doppler_ref/fit.py` | harmonic-stacked ridge tracker + robust LSQ fit of (F0, v, d, t_c) with covariance; event-from-fit |
| `ref/doppler_ref/search.py` | end-to-end stages 3–6: grid + DEM, CPA tables, v/d + time-offset + silence (+ optional T_start prior) filters, track-based Doppler simulation, T_start/F0 sweeps, coarse-to-fine refinement (200 → 100 → 50 m) |
| `ref/doppler_ref/scenarios.py` | analytic DEM, kinematic track generator (turns, accel., climb), ADS-B-like sampling (1–5 s, 3 m noise, 25 ft quantisation, gaps), scenario writer/loader, simulated human measurement |
| `ref/scripts/` | `make_scenarios.py`, `run_search.py`, `make_golden.py`, `make_plots.py`, `robustness.py` |
| `ref/tests/` | 20 Lane A pytest tests (physics, fit, golden reproducibility, end-to-end) |
| `fixtures/scenario1/`, `fixtures/scenario2/` | `tracks.json` (contract), `audio.wav` (8 kHz mono int16), `truth.json`, `events_measured.json` (contract events + `_point_estimates`), `scenario.json` (DEM params, search centre), `result_ref.json` |
| `fixtures/golden/*.json` | cross-check data for the JS port (see §5) |
| `fixtures/robustness_results.json` | robustness experiment table |
| `docs/img/` | `scenarioN_spectrogram_overlay.png`, `scenarioN_score_maps.png` |

Scenarios:
* **scenario1** (Long-Island-like, hills up to 220 m): 2 prop events 921.5 s apart (C172 F0 128 Hz, d 748 m,
  v 57.5 m/s, turn + climb; PA28 F0 112 Hz, d 1212 m, accelerating + descending), distractors: 3 props
  (one passes 6 km away during the clip, one 4.4 km, one 400 m but 25 min earlier) and an A320 jet.
  Duration 1150 s.
* **scenario2** (Alpine valley, observer at 1100 m on a slope, relief 600–1200 m): 3 prop events
  (d 596 / 905 / 860 m; Q2 has a 12 s ADS-B gap 20–30 s before its CPA; Q3 turns into its CPA),
  distractors: prop at 5 km during the clip, unknown-type prop after the clip, A20N jet. Duration 720 s.
* Measured events simulate a human: t ±3 s, F0 ±2 %, v ±15 %, d ±30 % (uniform), entered as ranges
  v·[0.8, 1.25], d·[0.7, 1.5].

## 2. Test results (actual output)

`cd ref && python -m pytest tests -v -s` (20 Lane A tests; the 3 `test_data_adsb.py` tests belong to Lane B):

```
============================= test session starts =============================
platform win32 -- Python 3.12.9, pytest-8.4.2, pluggy-1.5.0 -- C:\ProgramData\miniconda3\python.exe
cachedir: .pytest_cache
rootdir: C:\Users\hamdd\Workspace\Experiments\doppler_geoloc\ref
plugins: anyio-4.11.0, cov-7.0.0
collecting ... collected 23 items
tests/test_data_adsb.py::test_category_codes PASSED
tests/test_data_adsb.py::test_extract_and_contract PASSED
tests/test_data_adsb.py::test_cells PASSED
tests/test_fit.py::test_fit_noiseless_recovers_truth[128-57-750-5.0] PASSED
tests/test_fit.py::test_fit_noiseless_recovers_truth[95-110-2500--12.0] PASSED
tests/test_fit.py::test_fit_noiseless_recovers_truth[140-40-400-30.0] PASSED
tests/test_fit.py::test_fit_noisy_recovers_truth PASSED
tests/test_fit.py::test_ridge_fit_on_synthetic_audio[scenario1-0-0.05-0.1] PASSED
tests/test_fit.py::test_ridge_fit_on_synthetic_audio[scenario1-1-0.05-0.1] PASSED
tests/test_fit.py::test_ridge_fit_on_synthetic_audio[scenario2-0-0.05-0.1] PASSED
tests/test_fit.py::test_ridge_fit_on_synthetic_audio[scenario2-1-0.08-0.1] PASSED
tests/test_golden.py::test_golden_emission_and_cpa PASSED
tests/test_golden.py::test_golden_straight_and_spectrogram PASSED
tests/test_physics.py::test_enu_roundtrip PASSED
tests/test_physics.py::test_hermite_reproduces_quadratic_motion PASSED
tests/test_physics.py::test_retarded_time_vs_bruteforce PASSED
tests/test_physics.py::test_fixed_point_converges_linearly PASSED
tests/test_physics.py::test_newton_matches_independent_emission_grid_model PASSED
tests/test_physics.py::test_straight_line_closed_form_vs_numeric PASSED
tests/test_physics.py::test_first_order_error_magnitude PASSED
tests/test_physics.py::test_cpa_vs_bruteforce PASSED
tests/test_search.py::test_end_to_end_recovers_observer[scenario1] 
scenario1: grid=14615 coarse_survivors=8 err=25 m dT_start=-0.40 s total=15.8 s timings={'whiten': 0.22, 'stage3_grid_cpa': 2.51, 'stage4_filters': 0.01, 'stage56_coarse_score': 3.1, 'refine': 8.63, 'load_wav_spectrogram': 1.31}
PASSED
tests/test_search.py::test_end_to_end_recovers_observer[scenario2] 
scenario2: grid=14641 coarse_survivors=5 err=16 m dT_start=+0.16 s total=12.0 s timings={'whiten': 0.11, 'stage3_grid_cpa': 1.09, 'stage4_filters': 0.01, 'stage56_coarse_score': 0.68, 'refine': 9.49, 'load_wav_spectrogram': 0.66}
PASSED
============================= 23 passed in 37.13s =============================
```

What the tests check: retarded-time Newton vs `brentq` brute force (< 1e-6 s, limited by float64 resolution
of Unix time) and vs an independent emission-grid forward model; fixed-point linear convergence; Hermite
exactness for quadratic motion; closed-form straight pass vs numeric solver (f < 1e-8·F0) plus the analytic
properties (f(d/c) = F0, slope −F0v²/(cd), asymptotes, point symmetry); first-order error formula;
CPA vs 1 ms brute force; LSQ fit recovers (F0, v, d, t_c) from noiseless (1e-5..1e-3) and noisy curves;
ridge + fit on synthetic audio (v within 5–8 %, d within 10 %, t within 1 s); golden reproducibility;
end-to-end recovery (< 150 m, right flights, T_start within 2 s).

## 3. Runtimes and accuracy (single-threaded numpy, Windows laptop)

Measured by `ref/scripts/run_search.py` (lightly loaded machine; the pytest run above was taken while
other jobs were running, hence ~2× higher numbers):

| stage | scenario1 (14 615 pts × 6 flights) | scenario2 (14 641 pts × 6 flights) |
|---|---|---|
| WAV load + spectrogram (8 kHz, 1150 s / 720 s) | 0.8 s | 0.5 s |
| whitening | 0.2 s | 0.1 s |
| stage 3: grid + DEM + CPA tables | 0.9 s | 0.8 s |
| stage 4: filters | 0.01 s (→ 8 survivors) | 0.01 s (→ 5 survivors) |
| stages 5–6 coarse scoring (17 δ × 17 F0 × 4 k × 241 τ per survivor-event) | 0.7 s | 0.5 s |
| refinement 100 m (81 pts) + 50 m (49 pts) | 6.9 s | 6.7 s |
| **total** | **~10 s** | **~9 s** |

Accuracy (final 50 m level, horizontal): **scenario1 25 m** (T_start error −0.40 s, right flights P1+P2),
**scenario2 16 m** (T_start +0.16 s, right flights Q1+Q2+Q3). Before track smoothing was added: 36 m / 16 m.
The coarse-to-fine step sizes, not the physics, limit the accuracy (50 m grid).

## 4. Robustness (requested by the coordinator)

`python ref/scripts/robustness.py` (≈16 min; results in `fixtures/robustness_results.json`). Columns:
`err_m` final horizontal error; `ok_flights` right flight assignment; `n_surv` coarse survivors after the
filters; `best` final score; `truth` score of the true hypothesis (no sweep); `runner_up` best coarse score
> 1 km from the winner (None = no competitor survived the filters); `amb_km2` area with score ≥ 90 % of the
coarse max; `dT_start_s` T_start error. Audio-side perturbations (wind, temperature, noise) re-synthesise
the audio; the model always assumes still air, c = 343 m/s.

| scenario | variant | err_m | ok_flights | n_surv | best | truth | runner_up | amb_km2 | dT_start_s |
|---|---|---|---|---|---|---|---|---|---|
| scenario1 | baseline (human-measured events) | 25 | True | 8 | 2.593 | 2.668 | None | 0.04 | -0.4 |
| scenario1 | auto events (ridge + LSQ fit) | 25 | True | 13 | 2.591 | 2.668 | 1.575 | 0.04 | -0.21 |
| scenario1 | one event only (clip cut) | 5071 | True | 3707 | 1.694 | 1.646 | 1.634 | 4.92 | 83.0 |
| scenario1 | one event + T_start known +-2 s | 25 | True | 8 | 1.625 | 1.646 | 1.329 | 0.04 | -0.4 |
| scenario1 | no v/d filter (offset+silence only) | 25 | True | 545 | 2.593 | 2.668 | 2.396 | 0.16 | -0.4 |
| scenario1 | no silence filter | 25 | True | 10 | 2.593 | 2.668 | 0.994 | 0.04 | -0.4 |
| scenario1 | ADS-B altitude bias -100 m | 76 | True | 8 | 2.602 | 2.42 | None | 0.08 | -0.67 |
| scenario1 | ADS-B altitude bias +50 m | 35 | True | 9 | 2.62 | 2.571 | None | 0.04 | 0.34 |
| scenario1 | ADS-B altitude bias +100 m | 83 | True | 12 | 2.56 | 2.367 | 1.332 | 0.04 | 1.1 |
| scenario1 | ADS-B altitude bias +200 m | 147 | True | 24 | 2.568 | 1.79 | 1.394 | 0.16 | 1.49 |
| scenario1 | ADS-B altitude bias +400 m | 483 | True | 26 | 2.184 | 0.855 | 1.195 | 0.12 | 4.77 |
| scenario1 | track decimated to 10 s | 25 | True | 10 | 2.56 | 2.616 | None | 0.04 | -0.42 |
| scenario1 | track decimated to 20 s | 25 | True | 9 | 2.604 | 2.649 | None | 0.04 | -0.37 |
| scenario1 | track decimated to 30 s | 25 | True | 8 | 2.61 | 2.622 | None | 0.04 | -0.17 |
| scenario1 | 30 s gap at CPA (event flights) | 38 | True | 10 | 2.59 | 2.593 | None | 0.04 | 0.08 |
| scenario1 | 60 s gap at CPA (event flights) | 71 | True | 9 | 2.548 | 2.506 | None | 0.04 | -0.95 |
| scenario1 | measured t err +-6 s | 45 | True | 10 | 2.493 | 2.668 | 1.348 | 0.04 | 0.5 |
| scenario1 | measured t err +-10 s | 2049 | True | 10 | 1.637 | 2.668 | 0.91 | 0.08 | 28.12 |
| scenario1 | measured v err +-30%, d err +-60% | 76 | True | 11 | 2.328 | 2.668 | None | 0.04 | -0.81 |
| scenario1 | event-0 CPA range wrong (excludes truth) | 615 | True | 11 | 1.053 | 2.668 | None | 0.04 | -5.98 |
| scenario1 | wind 5 m/s (audio only) | 25 | True | 8 | 2.626 | 2.487 | None | 0.04 | -0.27 |
| scenario1 | wind 10 m/s (audio only) | 25 | True | 8 | 2.637 | 2.027 | None | 0.04 | -0.27 |
| scenario1 | wind 15 m/s (audio only) | 25 | True | 8 | 2.625 | 1.441 | None | 0.04 | -0.27 |
| scenario1 | air temp 0 C (audio c=331.3), model c=343 | 83 | True | 8 | 2.442 | 2.081 | None | 0.04 | 0.94 |
| scenario1 | air temp 30 C (audio c=349.0), model c=343 | 38 | True | 8 | 2.545 | 2.441 | None | 0.04 | -0.11 |
| scenario1 | noise x2.5 | 25 | True | 8 | 0.798 | 0.838 | None | 0.04 | -0.27 |
| scenario1 | noise x5.0 | 45 | True | 8 | 0.135 | 0.098 | None | 0.04 | 0.66 |
| scenario2 | baseline (human-measured events) | 16 | True | 5 | 4.345 | 4.388 | None | 0.04 | 0.16 |
| scenario2 | auto events (ridge + LSQ fit) | FAIL | False | 0 | None | 4.388 | None | None |  |
| scenario2 | one event only (clip cut) | 3138 | True | 1877 | 1.788 | 1.767 | 1.738 | 1.88 | -50.2 |
| scenario2 | one event + T_start known +-2 s | 16 | True | 8 | 1.772 | 1.767 | 0.855 | 0.04 | 0.16 |
| scenario2 | no v/d filter (offset+silence only) | 16 | True | 24 | 4.345 | 4.388 | 1.138 | 0.04 | 0.16 |
| scenario2 | no silence filter | 16 | True | 5 | 4.345 | 4.388 | None | 0.04 | 0.16 |
| scenario2 | ADS-B altitude bias -100 m | 56 | True | 3 | 3.918 | 3.943 | None | 0.04 | -0.66 |
| scenario2 | ADS-B altitude bias +50 m | 16 | True | 6 | 4.267 | 4.245 | None | 0.04 | 0.26 |
| scenario2 | ADS-B altitude bias +100 m | 16 | True | 7 | 3.871 | 3.766 | None | 0.04 | 0.37 |
| scenario2 | ADS-B altitude bias +200 m | 58 | True | 10 | 3.054 | 2.81 | None | 0.12 | 0.92 |
| scenario2 | ADS-B altitude bias +400 m | 206 | True | 9 | 2.782 | 1.392 | None | 0.08 | -1.58 |
| scenario2 | track decimated to 10 s | 16 | True | 5 | 4.071 | 4.135 | None | 0.04 | 0.21 |
| scenario2 | track decimated to 20 s | 47 | True | 5 | 3.517 | 3.373 | None | 0.04 | -0.55 |
| scenario2 | track decimated to 30 s | 47 | True | 5 | 3.367 | 3.373 | None | 0.04 | -0.27 |
| scenario2 | 30 s gap at CPA (event flights) | 16 | True | 5 | 4.195 | 4.273 | None | 0.04 | 0.17 |
| scenario2 | 60 s gap at CPA (event flights) | 56 | True | 5 | 3.651 | 3.487 | None | 0.04 | -0.83 |
| scenario2 | measured t err +-6 s | 58 | True | 1 | 3.297 | 4.388 | None | 0.04 | 0.97 |
| scenario2 | measured t err +-10 s | FAIL | False | 0 | None | 4.388 | None | None |  |
| scenario2 | measured v err +-30%, d err +-60% | FAIL | False | 0 | None | 4.388 | None | None |  |
| scenario2 | event-0 CPA range wrong (excludes truth) | FAIL | False | 0 | None | 4.388 | None | None |  |
| scenario2 | wind 5 m/s (audio only) | 16 | True | 5 | 4.275 | 4.108 | None | 0.04 | 0.16 |
| scenario2 | wind 10 m/s (audio only) | 16 | True | 5 | 4.215 | 3.496 | None | 0.04 | 0.16 |
| scenario2 | wind 15 m/s (audio only) | 16 | True | 5 | 4.166 | 2.775 | None | 0.04 | 0.16 |
| scenario2 | air temp 0 C (audio c=331.3), model c=343 | 35 | True | 5 | 3.612 | 3.5 | None | 0.04 | -0.19 |
| scenario2 | air temp 30 C (audio c=349.0), model c=343 | 16 | True | 5 | 4.131 | 4.167 | None | 0.04 | 0.29 |
| scenario2 | noise x2.5 | 16 | True | 5 | 1.538 | 1.577 | None | 0.04 | -0.21 |
| scenario2 | noise x5.0 | 16 | True | 5 | 0.351 | 0.299 | None | 0.04 | -0.21 |

**Findings**

1. **One event is not enough** (km-scale error, 2–5 km² ambiguity, right flight but wrong place along the
   track), exactly as predicted in MATH §10. **One event + a T_start known to ±2 s is as good as two
   events** (25 m / 16 m) — so video metadata timestamps are extremely valuable; the UI should ask for them.
2. **Time-offset filter is the workhorse.** Without the v/d filter, scenario 1 still converges (545
   survivors instead of 8, but the right answer) *after track smoothing*; before smoothing the same run
   picked a wrong pair 8.7 km away (velocity noise from 3 m ADS-B jitter lowered the truth score below a
   distractor). Smoothing (W = 15 s) is therefore part of the recommended pipeline.
3. **Measurement errors.** t errors up to ±6 s are fine with tol = 8 s (45–58 m); ±10 s breaks it
   (2 km / FAIL): the tolerance must be ≥ the combined event-time error. **Hard v/d ranges are the most
   fragile part**: a CPA range that excludes the truth gives a wrong answer (615 m, with a visibly lower
   score) or no answer; in the 3-event scenario, ±30 %/±60 % v/d errors and the auto-fit ranges (the
   turning Q3 pass fits v = 49 m/s vs true 64) remove the truth entirely. More events make hard filters
   *more* fragile (every event must pass). ⇒ Use the v/d estimates as soft penalties or very wide ranges,
   and rely on the offset + score.
4. **ADS-B altitude bias** maps into horizontal error roughly as predicted (h/y·δh): +100 m → 16–83 m,
   +200 m → 58–147 m, +400 m → 206–483 m; −100 m → 56–76 m. The score at the truth drops (2.67 → 0.86
   at +400 m) and the winner moves sideways: use geometric altitude or QNH-corrected baro.
5. **Track sampling gaps:** decimation to 10–30 s costs 0–31 m; a 60 s gap right at the CPA costs 40–70 m.
   Smoothed Hermite interpolation is adequate; gaps > 60 s at the CPA should be flagged.
6. **Wind** up to 15 m/s does not move the answer (25/16 m) but lowers the truth score by 45 % (curve
   mismatch); an F0/T_start sweep absorbs it. **Temperature** errors of 12 °C cost 20–60 m. Wind/temperature
   are second-order error sources, as derived in MATH §8.
7. **Noise:** at 5× the noise the scores fall to 0.1–0.35 (≈ noise level) yet the answer is still within
   16–45 m, because the filters already reduced the problem to 5–8 hypotheses. On real data with many more
   survivors the score margin will be the limiting factor.

## 5. Golden fixtures for the JS port (`fixtures/golden/`)

| file | inputs | expected outputs | tolerance |
|---|---|---|---|
| `geo.json` | ref point, lat/lon/h | ENU, round-trip lat/lon/h | 1e-6 m, 1e-9° |
| `track_interp.json` | contract track (irregular 1–5 s, turning, climbing), query times incl. outside | Hermite pos/vel/valid, and with W = 15 s smoothing | 1e-4 m, 1e-6 m/s |
| `emission_doppler.json` | track, 3 observers, t_rx (±90 s around delayed CPA) | t_e, R, v_r, exact & first-order f (F0=100), CPA {t_cpa, d_cpa, speed, t_dcpa} | t_e 1e-6 s, f 1e-4 Hz, t_dcpa 2e-3 s |
| `straight_line.json` | (F0, v, d), T grid | closed-form f, τ, slope at delayed CPA, asymptotes | 1e-9 |
| `spectrogram.json` | formula signal (chirp + tone), nperseg 512, hop 128 | full dB spectrogram (contract dict) and whitened array | 1e-3 dB |
| `curve_score_small.json` | curves on that spectrogram | scores for K = 1, 2, 3 harmonics | 1e-4 |
| `scenario1_point_scores.json` | spectrogram params for `fixtures/scenario1/audio.wav` (int16/32768), 5 observer points (truth and offsets 100 m … 1.7 km), true flights, T_start, F0 | spectrogram checksums, `score_point` totals & per-event scores | 2e-3 |

Exact definitions to reproduce are in the module docstrings (`track.py`, `spectrogram.py`, `doppler.py`,
`scenarios.py` for the analytic DEM). Absolute Unix times must stay Float64.

## 6. Recommendations for the browser port

**Algorithm choices (validated here):**
1. Spectrogram: Hann, nperseg 4096 @ 8 kHz (0.512 s, 1.95 Hz bins), hop 1024 (0.128 s), keep ≤ 1 kHz
   (or the equivalent at 16/44.1/48 kHz: same window *duration* and bin width; resample to 8 kHz first
   — it is 6× cheaper and loses nothing below 1 kHz). Whiten per bin (median/MAD, clip [−3, 8]) once;
   keep the whitened `Float32Array` (nT·nF ≈ 9 k × 513 ≈ 18 MB for 20 min) and share it with all
   workers (`SharedArrayBuffer` if cross-origin isolated, else transfer a copy per worker).
2. Tracks: ENU via exact ECEF formulas (Float64), **local-quadratic smoothing W = 15 s** then C¹ Hermite.
   Smoothing raised the truth score by 15–38 % and is what makes the "no v/d filter" case work; it is
   the single most valuable track-side step. Drop jets by category but keep "unknown".
3. Retarded time: Newton, 4 iterations from `t_e = t_rx − R(t_rx)/c`, exact Doppler `c/(c−v_r)`.
   Never the first-order formula. Never Float32 for absolute times.
4. Stage 3 (cheap, all points): per flight, resample the track at 0.5 s into Float64 arrays once;
   for each grid point find argmin R² + parabolic refinement ⇒ `t_dcpa, d_cpa, speed` tables
   (Float64Array[F·N]). Cost N·F·M (14.6 k × 6 × ~1.5 k ≈ 1.3·10⁸ distance evaluations): ~0.3 s in plain
   JS, split across workers by flight. Speed-up: only evaluate points within `max(cpa_m) + margin` of
   the track (KD/bucket grid on track samples) — everything else is "inaudible" for that flight.
5. Stage 4 filters: vectorised over points; O(E·F·N). Instant.
6. Stages 5–6: only for survivors. Per (survivor, event): one retarded-time solve on the τ grid
   (241 samples coarse / 481 fine), then the sweep δ × ρ × k × τ of bilinear samples
   (coarse 17 × 17 × 4 × 241 ≈ 2.8·10⁵, fine ≈ 3·10⁵). Loop order: survivor → event → δ → ρ → k → τ
   with the ratio curve r(τ) and the per-δ fractional time index precomputed; no allocations in the loop.
   Estimate (not measured here): ~2–3 ms per survivor-event in tight JS loops ⇒ 1000 survivors × 2 events ≈ 5 s single-thread, ≈ 1 s on 6 workers. Python/numpy measures ~60 ms per survivor-event (temporaries-bound).
   Score is separable per event given T_start: take max over ρ per event, then sum over events, then max
   over δ.
7. Refinement: re-centre T_start and F0 sweeps on the previous level's best, then 100 m (±400 m) and
   50 m (±150 m) around the top distinct seeds (≥ 2× window apart). Re-run CPA + filters on the fine
   points (cheap).
8. Show the user the **top distinct candidates with their score margin**, plus the overlay of the
   predicted curves on the spectrogram (as in `docs/img/*_spectrogram_overlay.png`): this is how a human
   spots a wrong flight pair.
9. **Real-data lesson (section 7): rank by ridge residual.** After the offset join, score each hypothesis by the
   RMS misfit between the tracked ridge points (Lane C) and the predicted harmonic curve (best F0 per event in
   closed form, T_start swept ±10 s). Per hypothesis it costs far less than the spectrogram sweep, and it was
   decisive on colsto. Run the spectrogram score only on the top few thousand.
10. Provide the **automatic event fit** (ridge + LSQ) as the default way to fill events, with the human
   able to drag/adjust; ranges v ± 20 %, d ± 40 % from the fit (`fit.event_from_fit`).
11. Defaults: offset tolerance 8 s (≥ 2× the expected t error), T_start sweep ±4 s, F0 sweep ±4 %,
   audible radius 3 km (props) / 6 km (jets) for the silence filter, minimum audible curve length 20 s.

**WASM/GPU:** not needed for the reference scale (stage 3 ≈ 0.3 s, scoring ≈ 1 s with workers). Only if
loose filters leave > 10⁴ survivors (the video reports ~15 k at the 100 m stage) would a WebGPU
compute shader for the bilinear sweep pay off (embarrassingly parallel: one thread per survivor × δ × ρ).
An alternative 5–10× algorithmic saving: store the whitened spectrogram on a log-frequency axis so that
the F0 sweep becomes an index shift, and sample each δ row once for all ρ.


## 7. Real test: colsto Long Island recording (`fixtures/real/colsto_longisland`)

Code: `ref/doppler_ref/bigsearch.py` (local-pass CPA records for thousands of flights, sorted-key
time-offset join, ridge-residual scoring, silence check), `ref/doppler_ref/dem_terrarium.py` (real DEM:
AWS Terrarium z12 tiles, the same source as `web/engine/dem.js`; Long Island 0–110 m),
`ref/scripts/run_real_colsto.py`, `ref/scripts/plot_real_colsto.py`. Results:
`fixtures/real/colsto_longisland/result_laneA_<tag>.json`. Plots: `docs/img/colsto_overlay.png`,
`docs/img/colsto_score_map.png`.

Setup: the whole bbox [40.60–41.14, −73.86 – −73.14] on a 300 m grid (40 281 points), the whole day
(T_start free), ADS-B from adsb.lol (2026: 5410 tracks; 2025: 6057), spectrogram 0.512 s / 0.128 s from
`audio.wav`, events from the Lane C ridges (`ridges.json`, harmonics 1–3 together). The event times are
delayed-CPA times from my straight-line fit of the ridges: 255.2 s and 1168.6 s (offset 913.4 s). The offset
tolerance is ±15 s.

### Result (run `ridge_2026`): 2.2 km from the video's rounded answer, year 2026

| # | lat, lon | dist. to (40.87, −73.50) | T_start (UTC) | flights (event 1 / event 2) | d (m) | v (m/s) | F0 (Hz) | ridge RMS | spectrogram score | silence viol. |
|---|---|---|---|---|---|---|---|---|---|---|
| **1** | **40.8762, −73.5251** | **2.2 km** | **2026-09-08 20:49:11** | **CST1219 PC12 (a1dfeb) / EGE93 B350 (ace391)** | 6109 / 3655 | 137 / 103 | 114.6 / 126.5 | **0.465 %** | **2.21** | 2 |
| 2 | 40.9197, −73.3484 | 13.9 km | 2026-09-08 13:57:06 | XFL295 PC12 / N264TM SR20 | 5642 / 1231 | 132 / 69 | 122.3 / 138.5 | 0.531 % | 2.00 | 5 |
| 3 | 41.1085, −73.5409 | 26.7 km | 2026-09-08 12:31:48 | GPD106 PC12 / N116TX BE20 | 3676 / 2092 | 111 / 88 | 119.3 / 138.1 | 0.613 % | 1.51 | 7 |
| 4 | 41.1159, −73.5647 | 27.8 km | 2026-09-08 11:12:06 | GPD259 PC12 / N85FM TBM8 | 4433 / 1803 | 121 / 81 | 117.4 / 140.2 | 0.663 % | 1.50 | 5 |
| 5 | 40.9508, −73.2997 | 19.1 km | 2026-09-08 11:16:35 | GPD668 PC12 / FTO381 C208 | 4069 / 1749 | 118 / 79 | 113.9 / 138.0 | 0.665 % | 1.65 | 3 |

* The winner is #1 on **both** criteria (ridge misfit and spectrogram score). Margins: ridge RMS 0.465 %
  against 0.531 % for the runner-up (14 % worse), spectrogram score 2.21 against 2.00 (10 %). A misfit of
  0.465 % of F0 is about 0.55 Hz at the fundamental, the same misfit the true observer gets on the synthetic
  scenarios (0.5 %).
* The best 2025 hypothesis (run `ridge_2025`, same method) is worse: 0.505 % at 41.045, −73.190, 32.5 km
  away. The data therefore favour **2026**.
* Corroboration: T_start = 20:49:11 for `audio.wav` puts the start of the original hour (`orig.opus`,
  offset 1900 s) at 20:17:31 UTC. That hour contains the "8:37 pm UTC" of the video's separate single-clip demo.
* Both aircraft are **turboprops** (PC-12, King Air 350). Event 1 is fast and far (137 m/s, 6.1 km slant);
  event 2 is at 3.7 km. The ridge fit for event 1 that looked implausible (v ≈ 139 m/s, d ≈ 6.2 km) was right.
* 2.2 km is outside the ±0.5 km rounding of (40.87, −73.50). A 6 km CPA constrains the lateral position
  weakly, the refinement used only the ridge misfit (100 m, then 40 m), and the video's exact point is
  unknown. The true error is probably 1.5–3 km. In `colsto_overlay.png` the predicted harmonics 1–3 lie on
  the tracked ridges over the whole visible span of both events.

Survivors per stage (2026, final run): 40 281 grid points × 1416 prop/unknown/heli tracks → 12.7 M local
pass records (d < 9 km) → physical v/d bounds (v 25–180 m/s; d ≤ 9 km for event 1, ≤ 4.5 km for event 2):
12.1 M / 5.3 M records → offset join (±15 s): **1.34 M (point, pair) hypotheses over 8614 flight pairs and
38 341 points** → ridge-residual ranking keeps the top 4000 (325 flight pairs) → spectrogram score and ridge
refinement of 10 distinct seeds. Runtime: 31 min in Python, mostly the ridge residuals
(2 × ~1.5 M records × ~120 retarded-time solves).

### Why the video's answer was a hole at first, and what fixed it (attempts in order)

1. **Run `first`.** Gates came from the fit: event 1 v 97–180 m/s, d 2.5–12.4 km; event 2 v 54–101 m/s,
   d 0.6–2.9 km. Spectrogram scoring used the default 3 km audibility window. The winner was 25.7 km away
   (a GPD PC-12 pair). The true event-2 aircraft (B350, v 103 m/s, d 3.66 km) **failed both event-2 gates**.
   The ridges contain only the receding half of each pass (the approach is inaudible or masked), so the
   straight-line fit of event 2 is biased (v 77 m/s, d 1.4 km). The 3 km audibility window also cut event 1's
   predicted curve (d ≈ 6 km) down to nothing, so every score favoured hypotheses with d ≈ 2.8 km.
2. **Point check** at exactly (40.87, −73.50): only 37 passes (2026) and 24 (2025) within 3 km all day, and
   no prop pair 895–955 s apart. The only such pair is two jets (DAL231 → JBU2032, 949 s). The true pair is
   *not* within 3 km of the rounded point: event 1 is 6 km away.
3. **Local analysis** ±3 km around the answer, *all* categories (jets included), scored by ridge residual.
   Best pair: CST1219 PC12 → EGE93 B350, 0.46 %. The best jet pair is clearly worse (0.61 %). The categories
   were not the problem: jets were not needed, and heli/unknown added nothing.
4. **Loose gates + spectrogram ranking** (`loose_rr_2026`). The pair survives (coarse spectrogram rank ~71 of
   3000), but the spectrogram score alone does not single it out. The parts of each predicted curve where no
   signal is visible (the approach), hum lines and gust bursts add noise. The margin among the top
   hypotheses is < 15 %.
5. **Final** (`ridge_2026` / `ridge_2025`). No fitted v/d gates (physical bounds only), ±15 s offset,
   hypotheses ranked by the **ridge residual** and refined on it. The ridge residual is the RMS of
   log f_ridge − log(F0·ρ(t)) over the tracked ridge points, with the best F0 per event and T_start swept.
   Result: correct region, #1 on both criteria.
   The priors the coordinator suggested (v ≤ 110 m/s, d ≤ 4 km) would **remove the true event 1**
   (137 m/s, 6.1 km). The run with those priors (`coordpriors_2026`) did not complete: it ran out of memory
   while other lanes were running. I did not retry it, because the local analysis already shows those
   priors cannot contain the pair.

**Lessons for the product:**
* (a) Never gate on v/d fitted from partial ridges. Use only physical bounds or soft priors.
* (b) On real, cluttered audio the ridge-residual misfit (a few hundred points per event) discriminates much
  more sharply, and more cheaply, than summing spectrogram pixels. Use the spectrogram score as a second opinion.
* (c) The scoring audibility window must follow the measured ridge span, not a fixed 3 km radius.
* (d) Handle the year/date ambiguity by running both candidates and comparing the best misfit.


## 8. Known limitations

* **One real case only** (colsto, section 7): 2.2 km from a rounded label, so precision on real data is unproven.
* **Synthetic audio is idealised:** constant rpm, no ground-reflection fringes, no atmospheric
  absorption spectrum, no microphone wind noise, no directivity; sources are clearly visible up to ~3 km.
  Real clips (cf. hermes eval: most real clips fail) will be much harder; the search on real data should
  be validated on the `fixtures/real/` material once Lane B/C provide it.
* The ADS-B tracks in the scenarios are generated from the same kinematic truth as the audio, with only
  noise, quantisation and gaps. Real feeds add latency/time-stamp errors (OpenSky `time_position` vs
  `last_contact`), baro altitude errors, and multi-second outages.
* Filters are hard thresholds. A wrongly entered CPA range (truth excluded) silently produces a
  wrong answer (693 m error in the experiment, with a clearly lower score). Soft priors (Gaussian
  penalty on v/d/offset residuals added to the score) would degrade gracefully — recommended.
* Score normalisation: "mean z along the curve" (default) can favour very short curves; mitigated by
  the 20 s minimum audible window. A `sqrtN` (matched-filter) option exists but did not change results.
* One event without a timestamp is fundamentally ambiguous (km-scale, see §4). Parallel same-direction
  tracks at equal speed are a degenerate geometry for the time offset (MATH §10).
* The straight-line fit is biased for passes inside a turn (scenario 2, Q3: v −23 %, d −27 %), so the fit
  should only seed generous ranges; the track-based simulation decides.
* The grid is restricted to a 24 × 24 km box around a user-given centre and to points within 10 km of
  candidate tracks; no global search.
* Robustness runs vary one factor at a time on two synthetic scenarios; combined errors on real data will
  be worse.
