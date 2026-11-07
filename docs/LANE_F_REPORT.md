# Lane F report: KSMO per-clip real-physics validation

Real audio montage recorded near Santa Monica (KSMO), 2024-07-09 14:00Z to 07-10 03:00Z, with 21 prop/heli shots and
ADS-B tracks for each tail number. The question: can the reference Doppler physics (`ref/doppler_ref`) fit each
clip against the real ADS-B track of the right aircraft, and do the per-clip fits agree on one observer location?

## Method (`ref/validation/search_ksmo.py`, `analyze_maps.py`)

* Candidate observers: 50 m ENU grid within 2 km of runway 03/21, at DEM + 1.5 m.
* Candidate passes: every span where the tail number is within 4 km / 900 m AGL of the ARP.
* Per observer and pass: simulate rho(t) = c/(c - v_r(t_e)) with exact retarded time, using a Hermite track with
  15 s local-quadratic smoothing and c = 343 m/s. Sweep the clip's absolute start time over the whole pass, solve F0
  in closed form, and score k*F0*rho(t) (k = 1..4) on the whitened spectrogram.
* Combined map: sum of per-shot maps. Two variants:
  * **unconstrained**: each shot takes its best pass;
  * **chronological**: passes are forced to follow the montage order.

Bug fixed during the lane: negative start-time shifts were clipped after the window offset was added, so their
windows could fall outside the track and produce invalid matches. This affected 14a (fake 6.7 km fit). Shifts are
now clipped first. After the fix, map scores match the independent `doppler_ref` re-score to within about 0.01 for
every shot.

## Per-shot results (chronological assignment, at the combined estimate)

| shot | pass | T (UTC) | score | rms (% of f) | F0 (Hz) | fit |
|---|---|---|---|---|---|---|
| 01a_N796SP | N796SP_p3 | 18:27:08 | 1.98 | 0.55 | 80.5 | good |
| 03a_N201XQ | N201XQ_p0 | 18:45:49 | 2.02 | 0.60 | 86.6 | good |
| 04a_N6409U | N6409U_p0 | 18:51:05 | 1.16 | 1.72 | 83.3 | good (distant, 790 m) |
| 05a_N67CM | N67CM_p0 | 18:56:01 | 0.56 | 10.28 | 62.4 | poor |
| 06a_N338DK | N338DK_p0 | 19:00:55 | 0.12 | 32.10 | 79.3 | poor |
| 07a_N44GN | N44GN_p0 | 19:09:57 | 0.90 | 5.86 | 74.0 | weak |
| 10a_N355JS | N355JS_p0 | 19:26:26 | 0.04 | 16.22 | 84.1 | poor |
| 12a_N67CM | N67CM_p1 | 19:52:07 | 2.06 | 0.41 | 129.0 | good |
| 13a_N2918 | N2918_p0 | 19:54:09 | 0.40 | 12.86 | 106.7 | poor |
| 14a_N819MM | N819MM_p1 | 19:58:47 | 1.17 | 2.88 | 138.7 | fair |
| 16b_N148AC | N148AC_p1 | 20:40:27 | 2.28 | 0.23 | 89.6 | good |
| 18a_N2902S | N2902S_p2 | 20:41:38 | 1.94 | 0.30 | 81.5 | good |
| 19a_N58504 | N58504_p0 | 20:47:54 | 0.51 | 7.09 | 79.0 | weak |
| 21a_N81497 | N81497_p0 | 20:54:30 | 0.29 | 14.14 | 104.0 | poor |
| 23a_N201XQ | N201XQ_p2 | 22:23:54 | 1.79 | 0.63 | 87.9 | good |
| 27b_N36PJ | N36PJ_p0 | 22:29:43 | 1.27 | 3.93 | 134.7 | fair |
| 28a_N353DS | N353DS_p1 | 23:07:43 | 0.26 | 6.95 | 70.9 | weak |
| 29a_N201XQ | N201XQ_p3 | 23:14:55 | 1.51 | 0.24 | 47.8 | suspect (2 km range, low F0) |
| 32a_N204LP | N204LP_p0 | 23:51:34 | 1.44 | 4.07 | 66.5 | fair |
| 33a_N785AM | N785AM_p2 | 00:18:32 | 2.79 | 0.29 | 135.0 | good |
| 34b_N283AF | N283AF_p0 | 00:45:14 | 0.52 | 4.65 | 127.2 | weak |

The model curves for the good shots overlay the observed harmonics convincingly
(`docs/img/lane_f_overlays_combined.png`). Per-shot score maps are in `docs/img/lane_f_score_maps.png`.

## Combined location

| variant | best ENU (m) | lat, lon | score | spread |
|---|---|---|---|---|
| chronological | (157, 313) | 34.01862, -118.44960 | 25.02 | within 0.5 of max: 250 m; within 1.0: 510 m; within 2.0: 962 m |
| unconstrained | (107, 313) | 34.01862, -118.45014 | 25.88 | second peak 1.1 km away within 0.5 of max |

The chronological estimate is 350 m NE of the ARP and 104 m NW of the runway centreline.

Robustness (passes fixed to the chronological assignment):
* 9 good shots alone: best point (257, -187), 510 m from the all-shot estimate.
* Leave-one-out among those 9: the best point moves between (157, 313) and (307, 13).
* The 12 poor/weak shots alone: (407, 513), with a broad peak.

Conclusion: the physics fits individual clips well, but the combined location is coarse, about 250 to 700 m. Most
good clips are runway or short-final passes abeam the observer. These pin down the distance from the runway
centreline well but say little about position along the runway.

## Check 1: closest-range cluster (101 to 117 m)

`ref/validation/checks_rmin_lag.py`, written to `out/checks_rmin_lag.json`. Closest-approach (CPA) geometry at the
chronological estimate:

| shot | Rmin | horizontal | height above observer | altitude source |
|---|---|---|---|---|
| 01a | 113 | 105 | 41 | geom |
| 03a | 116 | 113 | 28 | baro |
| 14a | 104 | 103 | 14 | baro |
| 16b | 117 | 108 | -45 (see below) | ground |
| 18a | 108 | 103 | 32 | baro |
| 23a | 110 | 105 | 33 | baro |
| 33a | 101 | 101 | 0 | ground |

The cluster is not a model floor. There is no altitude clip, minimum AGL or geoid artefact. The horizontal miss
distance is 101 to 113 m in every case, which equals the estimated observer's 104 m offset from the runway
centreline. Heights at CPA are 0 to 45 m, which is consistent with ground roll or low final. The smoothed track
altitude also matches the raw ADS-B altitude at CPA to within a few metres.

One anomaly: on 16b the smoothed track dips to 5 m MSL, against about 49 m raw (ground). This looks like a
smoothing artefact at the air-to-ground transition, where altitude sources mix (geom minus N, baro, DEM + 2 m). Its
effect on the fit is small, since that shot's rms is 0.23%.

## Check 2: ADS-B consistency and time shift

`ref/validation/adsb_check.py`, written to `out/adsb_check.json`. Across 2,449 airborne reports, track-derived speed
minus reported ground speed:
* with 15 s smoothing: median -0.34 m/s, MAD 0.65;
* with no smoothing: median -0.09 m/s, 5th to 95th percentile -3.3 to +3.6.

The best lag between the two speed series is -2.75 s (rms 1.62 m/s against 2.02 at 0 s), so the reported
velocity trails the position-derived speed by about 3 s.

Shifting the ADS-B timestamps by -3 to +3 s leaves per-shot rms identical on all 9 good shots (pooled 1.187% at
every shift). The fitted clip start time absorbs the shift exactly (dT = shift). This is expected for two reasons:
the model uses only positions, not reported velocity, and the clip's absolute start time is a free parameter. A
global position-time shift is therefore unobservable here. **Recommended product default: 0 s.** Revisit this only
if audio timestamps become trusted absolutely, or if reported gs/track are used as velocity. In that second case
the -2.75 s gs lag should be compensated.

## Caveats

* 29a_N201XQ matches a pass 2 km away at F0 48 Hz. This is probably a spurious low-harmonic fit; exclude it.
* 7 shots (05a, 06a, 10a, 13a, 21a, 28a, 34b) fit poorly, at 5 to 32% rms, and carry little information.
* Without the chronological constraint, several shots pick passes hours away, and the combined peak becomes
  ambiguous.
* The 50 m grid and the fixed c = 343 m/s are both small compared with the 250 m spread. The F4 check found c of
  about 344.4 m/s on the day.

## Files

`ref/validation/`:
* scripts: `search_ksmo.py`, `analyze_maps.py`, `plot_maps.py`, `overlay.py`, `adsb_check.py`,
  `checks_rmin_lag.py`
* outputs in `out/`: `summary_base*.json`, `combined_base.npz`, `maps_base/`, `adsb_check.json`,
  `checks_rmin_lag.json`

`docs/img/`: `lane_f_score_maps.png`, `lane_f_overlays_combined.png`
