# Accuracy: what works and what does not

Evidence only. Section references point to the reports; STATUS.md is the summary board. The short version: the
physics and the engine are sound on clean data, one real video was solved, and most other real videos were not located.
In every failed real case the engine said "no plausible match" or returned nothing. After the D11/D13 fixes it gave no
confident wrong pin (V2 §4 item 6), though an earlier version did (K, Salou).

## Results by test

| test | result | source |
|---|---|---|
| Synthetic scenarios 1 and 2 | 25 m and 16 m error (JS engine reproduces: 25.3 / 16.1 m; faithful 0.6 s, robust ~2.5 s in browser with 16 workers) | LANE_A §3; STATUS (D, D11, D12) |
| Demo clip in the UI (end to end) | match at 24 m | STATUS 16:38 (E7) |
| **Real: colsto (Long Island, two prop passes 920 s apart)** | **Solved**: 40.8762, -73.5251, 2.1-2.2 km from the video's rounded label (40.87, -73.50), which is within that label's rounding. T_start 2026-09-08 20:49:11 UTC, consistent with the video's 8:37 pm UTC clip. Aircraft: PC-12 CST1219 and King Air EGE93. The JS engine from one-click events gives 40.87611, -73.52338 (142 m from the Python result) in 10-19 s in a cold browser. Caveat: the true spot is known only to the rounded label, so real precision is unproven | LANE_A §7; REAL_CASES; STATUS (A2, D10, D9) |
| Real: KSMO clips with known tail numbers (physics) | Fits 8 of 21 shots at 0.2-0.6 Hz rms on real tracks (physics validated). Combined spot ~350 m NE of the airport ARP, spread 250-700 m, because most good clips are runway passes abeam the observer. 7 shots fit poorly | LANE_F "Combined location", "Caveats"; STATUS (F) |
| Real: KSMO montage, blind | Position ~200 m (197 m). Aircraft identification 0/19 without tail numbers (runway passes look alike), 16/19 with registration hints | STATUS 17:21 (D12) |
| Real: Catalonia (Sabadell x2, Salou), blind | **0 of 3 located.** Sabadell: adsb.lol has no low GA/helicopter tracks near LELL on those dates. Salou: the engine of the time returned a confident wrong answer 6-15 km off (a sparse CN-235 track); after D11 it is borderline-weak or "no plausible match". Most Catalan videos are edited montages and ground operations | LANE_K Bottom line, §3, §4; STATUS 16:28 (D11) |
| Real: V2 continuous recordings (Egelsbach x2, Teuge, KSMO live, Malvern), blind | **0 of 5 located**, 0 confident-wrong. Cause: at least one marked pass has no ADS-B counterpart, and the search requires all events to match one T_start. An oracle run (not blind) with only the ADS-B-backed events of Egelsbach 2025 finds the true aircraft pair at 733 m, T_start -25 s. Failed runs were 1.7-20 km off and all flagged no plausible match or no candidate | LANE_V2 Bottom line, §3, §4 |
| Live mode ("Record now") | One event is enough when T_start is known from the device clock. 5 m on real live tracks with a synthetic pass (also 5 m with a +2 s clock bias); 3 km and the wrong flight with T_start unknown. Mic, polling, clock sync and backfill verified in headless Firefox with a fake mic. **No real outdoor recording has been tested.** Safari untested | LANE_L top, §3 "Not done" |

## When to expect it to work

* **Continuous recording**, not an edited montage. A montage needs one start time per clip; that support is validated only on
  synthetic data (30 m) and one KSMO case.
* **At least 2 audible flyovers** of **transponder-equipped** aircraft (ADS-B or MLAT), ideally propeller aircraft or
  helicopters with a clear harmonic comb, passing within a few km, with the recorder staying still.
* **An area with good low-altitude ADS-B coverage** for that date. The app shows a coverage verdict (poor/ok) before
  the search. adsb.lol had no usable low tracks near Sabadell on 2 of 3 tested dates (K §4). Egelsbach 2023 had 0.9 low
  tracks/h (V2 §2).
* **Known approximate date**, and ideally the start time to within minutes. Without a time, one event is ambiguous at
  km scale (LANE_A §8; LANE_L §3).
* Date in 2023 or later (free data). Earlier dates need paid sources (DATA §8).
* Audio clean enough to follow the tones. Wind, speech and music defeat the ridge tracker (V2 §1, the rejected Teuge case).

## Current limitations

1. **Aircraft without transponders are invisible**: gliders, many ULMs, some circuit traffic, some military. One unexplained
   pass sinks the all-events-must-match search (V2 §4-5). STATUS 21:44 records that D13 added outlier-event handling and a
   single-event cap, so V2 cases now fail safely. Full partial matching (drop up to k events, V2 §5) is not demonstrated.
2. **Low altitude and ground operations** are often missing from ADS-B (KSMO 2023: 6 tracks in 100 min where 4 or more departures were heard; V2 §4).
3. **Montages and ground operations** (taxi, run-up, rpm steps) are not Doppler flyovers. Most public spotting videos are montages (K).
4. **Single-event results** are capped at weak confidence unless T_start is known (live mode). Mirror positions on either side of the track remain possible (LANE_L §3).
5. **The coverage check is a heuristic.** Egelsbach 2023 passed it with zero nearby passes; per-hour thresholds were added afterwards (STATUS B4) and were not re-run on that case.
6. **Real precision is proven only coarsely**: one solved real case, whose truth is a rounded label. Synthetic accuracy is tens of metres. On real data expect hundreds of metres at best (KSMO 250-700 m).
7. The search region is limited to about 24 km around a user-given centre; there is no global search (LANE_A §8).
8. ADS-B timestamps lag by about 3 s. A free T_start absorbs this, but it matters when T_start is fixed (LANE_F; LANE_L §4).
9. Decoding a 1 h file peaked at 3.7 GB of memory (STATUS, C6). Chunked decoding is a TODO, so long files need a desktop browser.
10. All data comes from one provider (adsb.lol), whose production terms are unconfirmed (LANE_L §4; DATA §8).
11. Live mode sends position at about 11 m precision to the relay (SECURITY_REVIEW L3).
12. Results are probabilistic and are not proof of location. Keep that message in the product copy.
