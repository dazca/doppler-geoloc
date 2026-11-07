# Lane K report: blind real-world tests in Catalonia

**Bottom line: 0 of the 3 blind-run Catalonia cases was located, and a further 2 candidates could not be run.**
* **Both Sabadell cases (2023-12-17 and 2026-06-11):** the engine had nothing to match. adsb.lol has **no** low-level GA or helicopter track near LELL on those days; the same was true on 2024-02-17, the guessed date of a rejected candidate.
* **Salou airshow:** the engine gave a **confidently wrong** answer, 6–15 km off with margins up to 0.30. It matched the only low turboprop in the data, a military CN-235 whose track looks MLAT-derived.

The main limits were ADS-B coverage and the material: public Catalan spotting videos are almost all edited montages, and most of what they record is ground operations. The engine's maths was not the cause, but it lacks an absolute "no match" answer (§5). The only day with usable coverage near LELL is 2026-11-01 (Lane B's fixture: 5.9 low GA tracks/h within 5 km), and no public recording from that day was found.

Everything below was run blind: I marked the events from the spectrogram, offset the region centre by a random 5–10 km, and gave only the date window. `meta.json` (the truth) is read only by the evaluator, after the run.

## 1. What was searched and what was kept (K1)

I ran about 60 YouTube searches (yt-dlp, relevance-sorted and date-sorted) and checked Freesound and the Wikimedia/Freesound route from Lane V. Queries covered Sabadell/LELL, Girona/LEGE, Reus/LERS, Igualada/LEIG, Cerdanya/LECD, Empuriabrava, Bombers/Air Tractor/Canadair/helicopters, Aerosport, Festa al Cel, open days, and BCN live streams. Only the audio was downloaded, as untrusted data, each file in its own directory. I looked at a spectrogram of every candidate.

| case dir | source | why chosen | location truth | time truth | verdict |
|---|---|---|---|---|---|
| `cat_lell_patrona_20231217` | youtu.be/9SN6z46_9pA (30 min vlog) | the only pre-2025 LELL video with a date that can be proved | LELL ARP ±800 m (open-day apron) | open day Sun 2023-12-17, 09:00–12:30 UTC (Aeroclub notice) | run blind |
| `cat_lell_terrace_20260611` | youtu.be/-qIoQFYP_WM (21 min **live**) | continuous recording with an exact start time; fixed, known spot | Aeroclub Sabadell terrace, OSM 41.52072, 2.10221 ±150 m | live `release_timestamp` 2026-06-11 14:55:34 UTC (±1 min) | run blind |
| `cat_salou_festaalcel_20260919` | youtu.be/LAZriiFw318 (first 30 of 65 min) | many strong prop combs; date in the description | Salou beach front ±1.2 km | 2026-09-19, sunset show (window 15:00–19:30 UTC) | run blind |
| `cat_lell_training_2024` | youtu.be/yzYwtsIBido (13 min) | Sabadell touch-and-go session | LELL ±800 m | **unknown** (best METAR guess 2024-02-17) | rejected: no clean pass, no date, no coverage |
| `cat_leig_2026` | youtu.be/_IeVhXXpmU0 (18.5 min) | the cleanest audio (raw, many passes) | LEIG ±800 m | **unknown** (uploaded 2026-05-20) | not run: no date; coverage probe negative |

Rejected after listening or checking metadata (not saved):
* LECD EuroGA fly-in, 29 Sep 2023 (`irxnplNVH4g`): music bed.
* Empuriabrava (`JtXB7AQ-Afo`) and Sabadell compilations (`sJg_M-C3Rww`, `A31paNoSMdI`, `VZN83zvMM9o`, `HhBs3UVJnVM`): montages, no date.
* Sabadell Festa Major open day 2025 (`njRfCAY3zcc`): second half is music; few passes.
* BCN El Prat live streams (`ZK-ddPfiTD8` 2025-11-25, `Z3J92vcsBfc`, `_UBHoIIWxzE` 2026-11-01): continuous with exact times, but jets only, with commentary and wind. Below 1 kHz there are no tonal Doppler lines, only broadband approach noise, so they are unusable with the engine's ≤1 kHz reference spectrogram.
* Pre-2023 videos (Air Tractors 2021, Canadair 2021, Collserola 2021) are older than adsb.lol history.
* Freesound: no Catalan aircraft recordings with a date and a geotag.

**Honest K1 summary:** no Catalan public recording that is continuous, has a known date and contains several clean airborne prop passes was found. Every usable candidate is a montage (clips of 10–50 s) or a phone live stream with weak lines. Most of the "aircraft sound" at airfields is engine start, run-up, taxi and take-off roll. These show rising or flat combs, not Doppler passes.

## 2. ADS-B (K2)

`ref/data/fetch_adsb.py` was run unmodified. Problems found (not patched):
1. **mlatonly release missing ⇒ hard failure.** For 2023-12-17 and 2024-02-17 there is no `v…-planes-readsb-mlatonly-0` release. `part_urls` raises `RuntimeError(... not found)` *after* the prod feed has been streamed and indexed, and the whole fetch aborts. Workaround: `--feeds prod`. A missing feed should be a warning, not a fatal error.
2. **MemoryError** in `stream_day` (`pool.imap(_process_batch…)`: "Unable to allocate output buffer") on the first try, while other lanes were using RAM (2.7 GB free of 16). A retry worked. The pool could cap its workers or batch size when free RAM is low.
3. **Partial days are not flagged.** The 2026-06-11 prod release is 1.52 GB / 42k traces, against 3.2–3.6 GB / 56–79k on normal days, and its mlatonly release is empty (0 traces). The fetch succeeds silently. It should warn when a day's trace count is far below normal.
4. By default, ground points are dropped. For airfield recordings, where many "passes" are take-off rolls, use `--keep-ground`. I used it for the terrace and Salou cases.

Coverage near LELL (non-jet tracks with any point < 1000 m MSL within 5 km of the LELL ARP):

| day | window (UTC) | non-jet tracks in 50×50 km bbox | low GA tracks within 5 km | per hour |
|---|---|---|---|---|
| 2023-12-17 | 08:00–13:30 | 1 (a P06T, lowest 948 m) | 0 | 0 |
| 2024-02-17 | 11:00–17:30 | 2 (a BE20 ≥ 1.6 km) | 0 | 0 |
| 2026-06-11 (partial release) | 14:00–16:30 | 5 | 0 | 0 |
| 2026-11-01 (Lane B fixture) | 07:00–15:00 | 70 | 47 (21 aircraft) | 5.9 |
| LEIG 2026-05-16 (probe) | 06:00–19:00 | 43 | 0 below ~870 m AGL within 5 km of LEIG | 0 |

## 3. Blind runs (K3)

**Pipeline.** `node web/tests/cat_run.mjs fixtures/real/cat_<name> [--modes robust,faithful]`. It reads only `blind.json`, `audio.wav` and `tracks.json`. Steps:
1. Lane C STFT (nfft 8192, hop 512, local whitening).
2. `ridge.trackRidgeMulti` from my seed clicks, then `cleanRidge`.
3. `geoloc.fitEvent`.
4. `geoloc.runSearch` with `audio` (the engine builds its reference spectrogram), a circular region of radius 15 km whose centre is offset 5–10 km from the truth at a random bearing, the date window and `grid_m: 100`, inline.
5. `simulateCurves` on the best candidate.

The evaluation runs afterwards: `python -P ref/validation_cat/evaluate.py fixtures/real/cat_<name> --plots`. It writes `eval.json` and `docs/img/lane_k_<case>_<seg>_<mode>_{map,overlay}.png`.

Montages: each continuous clip is its own segment with its own unknown T_start. The engine has no per-segment offset (see §5), so each segment is a separate single-event search.

| case / segment | events (my marking → fit) | candidate tracks (≤4 km, window) | **robust**: err, margin, matched flight | **faithful** | T_start inferred | verdict |
|---|---|---|---|---|---|---|
| patrona A (1491–1511 s) | comb ~176 Hz, fit v 29 m/s d 71 m, flagged poorly constrained | 117 (1 prop) | 10.7 km, margin n/a, score 0.000, 3460d4 P06T (closest to truth 9.7 km) | 10.7 km, same | 12:11 UTC (meaningless) | FAIL: no data |
| patrona B (1512–1545 s) | ~150 Hz comb line, v 40 d 130 m (cov 0.94, flagged) | 117 | 9.6 km, score −0.019, same P06T | no candidate | — | FAIL: no data |
| patrona C (1144–1155 s) | v 43 d 103 m (flagged) | 117 | 9.6 km, score −0.118, same P06T | no candidate | — | FAIL: no data |
| terrace E12 (1100–1200 s, 2 events) | ev0 155→136 Hz (looks like a step, not a pass), ev1 156→134 Hz, v 45 d 261 m (runway ≈ 250 m away: physically plausible) | 23 (0 prop within 10 km) | **no candidate** | **no candidate** | — | correct "no answer"; data missing |
| Salou S0 (109–131 s) | 77→66 Hz, v 55 d 411 m | 22 | **14.8 km**, margin **0.285** (reported as not ambiguous), CUCO501 CN35 (Spanish AF CN-235, sparse MLAT-like track), closest to truth 9.0 km | 6.5 km, margin 0.027, CN35 (earlier pass) | 16:35 / 15:55 UTC | FAIL: confident wrong answer |
| Salou S2 (181–212 s) | 79→69 Hz, v 48 d 254 m (not flagged) | 22 | **14.6 km**, margin 0.208, CN35 | 14.8 km, margin 0.301, CN35 | 16:35 UTC | FAIL: confident wrong answer |
| Salou S1 (259–288 s) | 82→64 Hz, v 52 d 111 m | 22 | 12.2 km, margin 0.070 (ambiguous), CN35 | 5.9 km, margin 0.119, CN35 | 16:28 / 15:55 UTC | FAIL |

Run times: 1–12 s per search in Node, inline, single thread.

Plots:
* `docs/img/lane_k_cat_salou_festaalcel_20260919_S2_robust_{map,overlay}.png`: the score field exists only around the CN-235 legs (proximity mask), and the truth lies outside every flight's audible area. The overlay shows the simulated CN-235 curve nearly flat at ~80 Hz, while the observed line falls 80→65 Hz over 195–212 s. The match is poor in shape, yet it is reported with a 21 % margin.
* `docs/img/lane_k_cat_lell_patrona_20231217_B_robust_{map,overlay}.png`: the field around the single P06T, 10 km from the truth.
* `docs/img/lane_k_cat_lell_terrace_20260611_E12_robust_overlay.png`: the two short ridges.

### Sanity of the matched flights
* **P06T 3460d4** (patrona): the only non-jet in a 50×50 km box over 5.5 h. Its lowest point is 948 m, 9.7 km from the field. It cannot be the taxiing or low-passing aircraft heard on the apron. The match is implausible, and the engine still returned it as the best candidate with a score ≤ 0.
* **CUCO501 CN-235 T.19B-21** (Salou): a real Spanish Air Force turboprop at the airshow, at 300–480 m MSL, 15:55–16:35 UTC. Points arrive every 20–80 s; the track looks MLAT-derived. The heard comb has a spacing of ~19.5 Hz with a strong line at ~78 Hz. That fits a 4-blade propeller at ~1170 rpm (shaft 19.5 Hz, blade-pass 78 Hz), so a CN-235 is acoustically plausible. However, its closest approach to the beach is 5.1 km, and the montage clips may show a different display aircraft with no ADS-B. I cannot tell whether the CN-235 is what was heard. Either way, the location is wrong by 6–15 km.

## 4. Diagnosis (K4)

| case | primary cause | secondary |
|---|---|---|
| patrona 2023-12-17 | **ADS-B coverage**: no low GA or helicopter in adsb.lol for 2023 near LELL (lowest point anywhere in the box 758 m MSL) | montage; mostly ground ops (start, run-up, taxi: rising or flat combs); dense combs (~17–38 Hz spacing) |
| terrace 2026-06-11 | **ADS-B coverage**: partial adsb.lol day (half-size prod release, empty mlatonly), 0 GA near LELL | lines weak under wind noise; passes are 4–5 s runway rolls; ev0 is probably an rpm step, not Doppler |
| Salou 2026-09-19 | **the true emitter is (probably) not in ADS-B**, or only as a sparse MLAT track; observer outside every track's audible area | montage, curved display paths over the sea, observer position ±1.2 km |
| training 2024 (not run) | no clean pass, unknown date, no coverage | — |
| LEIG 2026 (not run) | unknown date; nothing received below ~870 m AGL within 5 km of LEIG | ULMs and gliders carry no ADS-B |

No failure was caused by the event measurement alone. The ridge fits are physically sensible: v 29–55 m/s, d 70–410 m, as expected for airfield or display passes. The one exception is the comb-hopping in patrona B v1 (below).

## 5. What the product needs (engine API gaps, not patched)

1. **Absolute evidence / "no match" answer.** `runSearch` always returns its best candidate if any track survives:
   * patrona robust returned candidates with score 0.000 and −0.118, and `margin: null`;
   * Salou returned a candidate 15 km off with margin 0.21–0.29, and `ambiguous: false`.

   `margin` measures only relative spatial distinctness. Needed: a null test (the best score against scores with the tracks time-shifted or shuffled, or the residual RMS between ridge and simulated curve in Hz), a `confidence.absolute` field, and an explicit "no flight in the data explains this sound" result. The UI must not show a pin in that case.
2. **Montage / multi-segment support.** Add `events[].segment` (or `segments: [{t0, t1}]`) with an independent T_start per segment, and combine the evidence across segments. Most public videos are edited, and today each clip is a separate km-ambiguous single-event search.
3. **Coverage report.** Before searching, count low (< 1000 m AGL) non-jet tracks per hour within ~5 km of the region and show it. Also flag partial adsb.lol days (trace count far below normal, empty mlatonly). For both Sabadell cases (and both rejected candidates), this alone would have told the user "cannot work" up front. The heat map should also say that a NaN area means "no flight audible here", not "low score".
4. **Comb-aware ridge tracking.** Piston engines and turboprops give dense harmonic combs, here with 17–39 Hz spacing. With the default `bandFrac: 0.25`, the Viterbi tracker hopped between comb lines (patrona B, first marking) and produced a staircase. A narrow band (0.08–0.12) fixed it. Better: estimate the comb spacing (cepstrum or harmonic sieve) and track spacing × order, or set the band to ± spacing/2 automatically.
5. **Ground-ops filter.** At airfields most loud aircraft sound is start-up, run-up, taxi and take-off roll, which give rising or flat combs. The UI should only suggest falling, Doppler-shaped segments. For runway passes, ground ADS-B points are needed (`--keep-ground` / tiles with ground points).
6. **DEM robustness.** A transient `fetch failed` on a Terrarium tile aborts the whole `runSearch` (Salou faithful S0 and S2 failed once; a rerun worked). `dem.js` needs retry, with a flat-DEM fallback and a note.
7. **Jets.** The reference spectrogram stops at 1 kHz. BCN approach and departure audio shows no tonal lines below 1 kHz, so jets need a higher band (fan tones at 1–4 kHz) to be usable.
8. `fetch_adsb.py` issues are listed in §2: missing mlatonly is fatal, MemoryError under RAM pressure, partial days are silent.

## 6. Files

* `fixtures/real/cat_lell_patrona_20231217/`, `cat_lell_terrace_20260611/`, `cat_salou_festaalcel_20260919/`: `audio.wav` (mono 16 kHz, ≤ 30 min), `meta.json`, `blind.json` (exactly what the engine saw), `spec*.png`, `tracks.json` (+info), `run_<seg>_<mode>.json`, `eval.json`, `fetch*.log`.
* `fixtures/real/cat_lell_training_2024/`, `cat_leig_2026/`: rejected or not-run candidates, with `meta.json`, `spec.png`, `audio.wav` and the coverage-probe tracks.
* `web/tests/cat_run.mjs`: the blind runner.
* `ref/validation_cat/spec.py`: quick-look spectrogram.
* `ref/validation_cat/peaks.py`: spectral peaks, for placing seeds.
* `ref/validation_cat/evaluate.py`: truth scoring, coverage check and plots.
* `docs/img/lane_k_*.png`: score maps and overlays.

All audio is copyrighted YouTube content (standard licence), kept as private test fixtures; do not redistribute. ADS-B data © adsb.lol contributors, ODbL 1.0.

## 7. Round K2: looking for a recent continuous recording (owner request)

**Result: no suitable recording exists.** I found no continuous Catalan recording of about 30 min or more from Sept–Nov 2026 with markable flyovers, so nothing new was run blind.

What I checked:
* **AnnaMi channel** (the Aeroclub Sabadell terrace livestream): all 60 streams and 60 videos listed.
  * Its only airfield streams are `-qIoQFYP_WM` (2026-06-11, 21 min; already run) and `MtJPuHFHbsA` (2026-01-13, 15.6 min).
  * `3XQ1c5xJBDs` (vintage expo, Oct 2024, 23.5 min) and `XiDViSQJDeU` (La Bunyola, El Prat, jets) are also airfield-related.
  * None is ≥ 30 min or from Sept–Nov 2026.
* **Date-sorted searches for long videos (> 20 min):**
  * Covered: Sabadell/LELL, aeroclub, Girona, Reus, Empuriabrava, Igualada, Cerdanya, Barcelona live, helicopters.
  * Sabadell searches returned only cockpit videos (moving observer), flight-sim videos and pre-2023 material.
  * `fd5zWcbzLkY` (Girona LEGE live) is no longer available.
  * Empuriabrava returned only indoor-skydiving streams. Webcam searches turned up nothing Catalan.
* **BCN El Prat live VOD `_UBHoIIWxzE`** (2026-11-01, 14:02:58 UTC start, 3.3 h; that day's ADS-B index was already cached), checked as in step (2):
  * The coverage check (`fetch_adsb.py --site 41.297,2.080`) is **poor** for light aircraft: 0.7 low tracks/h. Jets are fully covered.
  * I then downloaded only a 30-min audio section (20:00–50:00) and inspected it (`fixtures/real/cat_bcn_live_20261101/spec_*.png`). It has continuous spoken commentary, jet broadband with ground-reflection fringes, and slow taxi tones. There is **no tonal Doppler flyover** to mark below 1.6 kHz, and the spotting spot is unknown to ±3 km.
  * Rejected; `meta.json` is saved, the audio is not kept.
* **Mikel BCN 2026-11-04** (`ZP-rrpvPXZ8`): the ADS-B release is not published yet; same jets-and-commentary profile.

**Re-runs of the round-1 cases with the current engine** (robust, no reg hints; montage mode `--montage` puts events in `clip`s):

| case | verdict (new) | err | note |
|---|---|---|---|
| patrona (3 clips, montage) | **no plausible match** | 9.6 km | correct rejection (only a P06T 9.7 km away in the data) |
| terrace E12 | **no plausible match** | 15.3 km (candidate shown, T_start err −2648 s) | correct rejection |
| Salou (3 clips, montage) | **weak** | 15.1 km, margin 0.68 | still matches the sparse CN-235 track; "weak" rather than "no plausible match" is too generous for a 15 km miss whose simulated curve does not follow the ridge |

`web/tests/cat_run.mjs` gained `--montage`, prints the verdict and stores it. `evaluate.py` now reports the T_start error (if `t_start_truth_unix` is in `meta.json`) and the verdict.

**Recommendation:** to get a real Catalonia validation, *record one*. A 30–60 min continuous phone recording at a known spot under the LELL circuit on a weekend afternoon (coverage there was "ok" on 2026-11-01, 5.9 low GA/h), with the file creation time kept. Public YouTube material does not provide this.
