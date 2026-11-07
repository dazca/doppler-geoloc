# Lane V2 report: more real continuous test cases (blind)

**Bottom line: none of the 5 blind multi-event runs located the recorder (6 candidates were prepared; 1 was rejected on audio quality).** The engine never gave a confident wrong answer: every failure came back as `no plausible match` or with no candidate at all. In each case the cause was ADS-B: at least one marked pass has **no ADS-B counterpart**. Typical reasons are a circuit aircraft that is not transmitting, low-level departures the receivers miss, or a jump ship that shows up for only one of four passes. The engine requires every event to match a flight at one common T_start, so a single unexplained event is enough to sink the whole run. When only the events that do have ADS-B partners are kept (a non-blind "oracle" test), Egelsbach 2025 picks the right two aircraft. It lands 733 m from the truth and its T_start is 25 s off, but the verdict is still `no plausible match`.

All candidates are continuous recordings (YouTube **live VODs**, whose `release_timestamp` gives the start time to about ±1 min, plus one radio aporee field recording with a geotag and a stated time). All were made after 2023-02-16 in DE, NL, UK and the US. I downloaded audio only, into separate directories, as mono 16 kHz WAV of at most 60 min.

## 1. Cases

| case dir | source | location truth (±) | t_start truth | audio | marked events |
|---|---|---|---|---|---|
| `v2_egelsbach_20251011` | youtu.be/jbEasnZFlXI (live, 2 h 17 min) | Flugplatz Egelsbach restaurant Rodizio (OSM) 49.96287, 8.64205 (±300 m) | 2025-10-11 14:45:58 UTC (VOD +3600 s) | 60 min | 6 prop passes (comb ~83/167/250 Hz) |
| `v2_egelsbach_20230912` | youtu.be/SX3uY8MS2f8 (live, 2 h 7 min; description links Rodizio) | same (±300 m) | 2023-09-12 15:42:40 UTC | 60 min | 4 |
| `v2_teuge_20260406` | youtu.be/kaIF2ExQS-w (live, 6 h 21 min) | EHTE ARP 52.2447, 6.0467 (±700 m, exact spot not stated) | 2026-04-06 11:30:31 UTC (VOD +10800 s) | 60 min | 3 |
| `v2_ksmo_live_20230826` | youtu.be/HHalmlYSExg (sk Airplanes live, 3 h 54 min, Live ATC mixed in) | Lane F's estimate of the same uploader's KSMO spot, 34.01862, −118.4496 (±500 m) | 2023-08-26 20:21:44 UTC (VOD +3600 s) | 40 min | 4 departures |
| `v2_malvern_skydive_20260614` | radio aporee `aporee_53640_84643` ("Sky Divers, Malvern"), recorded from the recordist's roof | geotag 52.0813, −2.33072 (±100 m) | stated "2026-06-14 13:45 Europe/London" = 12:45:00 UTC | 10.8 min (whole file) | 4 passes of one jump ship |
| `v2_teuge_20260802` | youtu.be/93Q1BB9TwTw | EHTE ARP | 2026-08-02 | 60 min | **rejected**: wind bursts and speech, no pass the line follower could hold |

Each directory holds `audio.wav`, `meta.json` (the truth), `spec.png` (a 300 s-strip spectrogram, which I looked at), `blind.json` (exactly what the engine saw), `tracks.json` / `tracks.info.json`, `fetch.log`, `run_*.json` and `eval.json`.

## 2. Method (blind)

* **Event marking.** Seeds were placed from zoomed spectrograms (`ref/validation_v2/zoom.py`), a spectral peak list (`ref/validation_cat/peaks.py`) and a greedy line follower (`ref/validation_v2/trace.py`). I used one strong comb line per pass, with `bandFrac 0.08` (Lane K lesson 4), and only the falling part of each pass. Take-off power-ups (rising combs) were skipped. Speech and wind mask most approach halves.
* **Region and time.** The region is a circle of 15 km radius whose centre is offset 5–10 km from the truth at a random bearing (`ref/validation_v2/mkblind.py`). The time window is the known start ±10 min, because every case has a stated start time.
* **ADS-B.** Fetched with `ref/data/fetch_adsb.py` (`--keep-ground --site <truth>`) through `ref/validation_v2/fetch_all.sh` and `fetch_malvern.sh`. Each day took 5–12 min to stream.
* **Engine run.** `node web/tests/cat_run.mjs <case> --modes robust` (unmodified). The runner never reads `meta.json`.
* **Evaluation, afterwards.** `ref/validation_v2/evaluate.py` is a copy of Lane K's with verdict and T_start error added and one overlay panel per event; it writes `docs/img/lane_v2_<case>_<seg>_robust_{map,overlay}.png`. Two diagnosis scripts use the truth: `diag.py` (which flights pass the truth around each event) and `passes.py` (every low ADS-B pass near the truth during the audio).

### Coverage check (B2, ≥1 point below 1500 m MSL within 5 km of the site, in the fetch window)

| case | low non-jet tracks/h | B2 verdict | notes |
|---|---|---|---|
| ksmo 2023-08-26 | 30.2 | ok | mlatonly missing. Yet only 6 tracks below 400 m within 600 m of the spot in 100 min, while ≥4 departures were heard in 25 min |
| egelsbach 2025-10-11 | 9.2 | ok | — |
| teuge 2026-04-06 | 23.3 | ok | many gliders (`GLID`, aerotow) |
| teuge 2026-08-02 | 9.2 | ok | — (rejected on audio) |
| malvern 2026-06-14 | 2.7 | ok | 8 aircraft in 3 h |
| egelsbach 2023-09-12 | **0.9** | ok (4 aircraft ≥ 3) | mlatonly missing; **0 passes within 1.5 km during the audio**. The verdict should be "poor" here, see §4 |

## 3. Results (robust mode, all events of a case together)

| case | events → fit | error | verdict | T_start − truth | matched flights (closest approach to the truth) | runtime |
|---|---|---|---|---|---|---|
| egelsbach 2025 | 6 (v 22–39 m/s, d 70–250 m) | — | **no candidate** | — | — | 4 s |
| egelsbach 2023 | 4 | — | **no candidate** | — | — | 3 s |
| teuge 2026-04 | 3 | 1.66 km | no plausible match | +44 s | PH-ZEF PIVE (1.6 km), PH-KRI C172 (1.5 km), **PH-FMO C172 (234 m, correct for ev2)** | 33 s |
| ksmo 2023 | 4 | 2.58 km | no plausible match (margin 0.80) | +73 s | MLAT ~29b6e0, N73ES C82T, N68BB BE58, N72124 BE33 (1.2–2.6 km) | 73 s |
| malvern 2026 | 4 | 20.5 km | no plausible match | +321 s | 4 unrelated GA aircraft 5–7 km from the truth | 4 s |
| malvern, wide window 11:30–14:20 (`v2_malvern_skydive_20260614_widewin`) | 4 | 21.2 km | no plausible match | +2063 s | unrelated | 5 s |

Extra variants: single-event runs (blind, decided after the full run failed) and one oracle run.

| run | error | verdict | T_start − truth | flight |
|---|---|---|---|---|
| egelsbach25 S0–S5 (one event each) | 0.42 / 1.24 / 2.07 / 3.39 / 6.91 / 13.2 km | all `match` (!) | −228 … +435 s | various; DERIS and DEIGR are matched to the wrong events |
| **egelsbach25 ORACLE ev4+ev5 (NOT blind)** | **733 m** | no plausible match (score −0.83, margin 2.6) | **−25 s** | **DEIGR C152 + DERIS A210, the true pair**; the overlay curves sit on the ridges (`lane_v2_v2_egelsbach_20251011_ORACLE_e4e5_robust_overlay.png`) |
| teuge S0/S1/S2 | 0.57 / 1.74 / 1.74 km | no match / no match / match | −444 / +462 / +91 s | PH-SAS, PH-KAC |
| malvern S1 / S3 | 2.29 / 23.5 km | weak / weak | −178 / −175 s | **CFARA SC7 (the Skyvan jump ship) in both** |

Single-event runs at an airfield land 0.4–2 km from the truth only because every circuit aircraft passes near the field. Their T_start is minutes off, and their `match` verdicts are not meaningful.

## 4. Diagnosis (honest)

1. **Egelsbach 2025: a clean recording, but most passes have no ADS-B partner.** The ~380 s periodic passes at 312, 702, 1082 and 1852 s look like one aircraft flying circuits. **No ADS-B track passes within 1.5 km of the spot at those times** (`passes.py`). The ADS-B passes near the spot in that hour are DERIS A210 (audio 1164 and 3040 s), an EC45 helicopter (1465 s, a falling line I saw but did not mark), DEIGR C152 (2336 s, sparse with 94 s gaps) and DEJDT/DEGTS (≥ 800 m). Only ev4 and ev5 coincide with an ADS-B pass, and the oracle run on those two finds the correct pair. In short: the measurement and the physics are fine, the circuit aircraft (probably not transmitting ADS-B) is missing, and the all-events-must-match search fails because of it.
2. **Egelsbach 2023: coverage.** Within 5 km of the spot, below 1500 m, there were 0.9 low tracks/h; the mlatonly feed is missing; and nothing passed within 1.5 km during the audio. "No candidate" is the correct answer. B2's verdict said `ok` because 4 aircraft were seen over 4.5 h. **The verdict should also look at the rate per hour, or at passes within ~1.5 km.**
3. **Teuge 2026-04: partly covered.** ev2 (3113 s) is PH-FMO C172, which passes 234 m from the ARP at 48 m altitude, and the engine did pick PH-FMO for it. ev0 (1442 s) and ev1 (2742 s) have no ADS-B pass near the field. The field is full of FLARM/ADS-B gliders that do not make prop combs. The engine filled the two gaps with other C172s and got 1.66 km. It correctly said `no plausible match`.
4. **KSMO 2023: no low-level coverage at the runway.** The heard departures pass about 100 m from the spot at 0–150 m AGL. adsb.lol (prod only; mlatonly does not exist in 2023) has just 6 such tracks in 100 min, none of them at the event times. The engine matched four aircraft 1–2.6 km away, with `no plausible match`. This is the same failure mode as Lane K (ground operations and the lowest altitudes missing).
5. **Malvern: the jump ship is in ADS-B, but only one pass fits the stated time.** CFARA SC7 (Short Skyvan) passes 144 m from the house at about 650 m MSL at audio +82 s, which matches ev0 (t_cpa 78.5 s). It then leaves to the south-west (40 km within 10 min). The later passes (221, 371, 595 s) have no ADS-B counterpart at the stated time. Two single-event runs (ev1 and ev3) both picked the Skyvan with T_start = 12:42:02–05 UTC, 3 min before the stated 12:45, but at positions 2.3 km and 23 km from the house, so they are inconsistent. Either the stated minute is approximate, or the recordist heard more than one aircraft and only one of them was transmitting. Not resolved.
6. **What did not fail.** The ridge tracker held every comb line I seeded (300–1500 points per event). Fitted v and d are physically sensible for airfield passes (15–100 m/s, 30 m–2.3 km). No run gave a confident wrong pin: the D11 absolute test held up on 5 out of 5 full runs. **Single-event runs, however, return `match` too easily** (Egelsbach S0–S5, all `match`, errors up to 13 km).

## 5. Recommendations

* **Partial matching (most important).** Let the search drop up to k events that no flight explains (each gets a fixed penalty), instead of requiring all of them. Report which events were left unexplained. Egelsbach 2025 shows this would turn a "no candidate" into the right answer: the oracle run with ev4+ev5 gave 733 m and −25 s.
* **Coverage verdict.** Add a per-hour rate threshold (e.g. < 2 low tracks/h within 5 km ⇒ `poor`) and a count of passes within 1.5 km of the region during the audio window. Egelsbach 2023 should have been flagged before running.
* **Single-event verdicts.** With a ±10 min window and circuit traffic, a single event almost always finds some flight. Its `match` threshold should be stricter, or the result capped at `weak`.
* **Material.** Airfield live VODs are the best source of known-time, continuous audio, but the audio is full of speech, and many circuit aircraft are not in ADS-B at circuit height. Radio aporee (archive.org `radio-aporee-maps`, which has a geotag plus a minute-precision local time) is the best colsto-like source found: 379 aircraft-tagged items after 2023-03, but almost all are ≤ 12 min, often jets, and rarely contain 2 or more prop passes.

## 6. Files

* `fixtures/real/v2_*/` (6 cases + `_widewin` variant)
* `ref/validation_v2/`:
  * `overview.py`, `zoom.py`, `trace.py`: quick-look spectrograms and seeding
  * `mkblind.py`: offset region and blind.json
  * `fetch_all.sh`, `fetch_malvern.sh`: ADS-B fetches
  * `evaluate.py`: scoring and plots
  * `diag.py`, `passes.py`: truth-side diagnosis
* `docs/img/lane_v2_*_{map,overlay}.png`

Note: the KSMO fetch window ended at exactly 00:00Z, so 2023-08-27 was also streamed (about 5 min of wasted time).
