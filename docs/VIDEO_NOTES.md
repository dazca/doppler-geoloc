# Video notes: aircraft Doppler audio geolocation

## Sources
- Video: https://www.youtube.com/watch?v=UytYrhYLOKI  "I discovered a sound that leaks your exact location (and it's everywhere)", channel colsto, ~29 min, uploaded about 2026-11-02 (channel/date per Digg https://digg.com/ai/7wr4rmyp and the cbonitz README).
- Full auto-transcript was downloaded with youtube-transcript-api; it is at a local temp file (not in the repo).
- Independent check: https://github.com/cbonitz/doppler-experiments (synthetic data only; good derivations in docs/ and scripts/).
- TechRadar coverage (only the headline could be fetched): https://www.techradar.com/computing/cyber-security/youtuber-discovers-aircraft-noise-trick-that-can-geolocate-your-videos-to-within-100m-doppler-effect-pinpoints-locations-from-just-60-seconds-of-audio
- Reimplementations: https://github.com/amintt2/flyover-locator , https://github.com/mojomast/hermes-aircraft-doppler-geolocation , https://github.com/1337isnot1337/DOPPLERGEIST

## CONFIRMED (transcript, or cbonitz README where marked)
The description says no code or tools will be released. The author says it took months, >5,000 lines, 50 GB parquet files, 3D physics, country-wide DEMs.

Test case: security-camera video, only known "filmed Sept 8, somewhere in the continental US". Answer approx (40.87, -73.5) (Long Island NY), confirmed in Street View (tree line, and the camera on a pole). Claimed accuracy: "a couple hundred feet" / ~100 m.

Method as narrated:
1. Spectrogram: x=time, y=frequency; zoom to the right frequency band and raise resolution to see a faint curve. Boosting frequencies helps listening. Prop fundamental on screen ~130 Hz (109.9 Hz at v_r=62.7 m/s; also 96.07 Hz, 141 m). Curve lasts almost 2 min. Event 1 is faint, event 2 louder with visible harmonics; a third curve exists but was not used. FFT size/window NOT stated.
2. ADS-B: downloaded ALL continental-US flights for the day with a Python scraping package (ran a few hours); a paid API is the alternative. Whole flight paths come down (flights to Hawaii appear). Stored as ~50 GB parquet. Provider not named in the transcript.
3. Aircraft type: ADS-B type code plus a lookup table saying prop vs jet. Table has gaps, so they EXCLUDE known jet types and keep unknowns.
4. Grid: 200 m grid, 10 km radius ("conservative") around each flight. For each point and flight compute CPA time and DELAYED CPA time = CPA + slant distance / c. Slant distance uses ADS-B altitude (MSL) minus DEM ground elevation at the grid point (DEM unspecified, "country-wide"). Example: CPA 22:46:34 -> delayed 22:46:46.
5. Time-offset filter: keep points with a delayed CPA of some flight and another delayed CPA 920 s later. The offset is measured between curve midpoints (CPAs); about +-5 s wiggle room. In a small test area (<0.05% of CONUS) 35,000 points survive.
6. Measure each curve: constant-velocity Doppler fit gives speed (size of drop), CPA slant distance (steepness), CPA time. Fit is manual (slide f0 and time). Right side fits ideal curve, left doesn't (turning/accel). They use GENEROUS ranges (event 1 ~100 m/s, "not 70"). Time uncertainty a couple of seconds (e.g. 151.15 vs 151.13 s on audio timeline), f0 also uncertain.
7. Speed filter, then candidate points laid only on the measured slant-distance ring around matching-speed flight segments: ~73,000 points, mostly near airports.
8. Silence filter: drop any point that would hear another flight between event 1 and 2 (~15 min of silence). Thresholds "conservative", not given. 73k -> ~15k points.
9. Exact modelling: for every candidate point and flight, simulate the Doppler curve from the real trajectory (turns, speed changes). Use RETARDED time: frequency heard at t uses radial velocity at emission time te with t = te + r(te)/c; f = f0*c/(c+v_r). The naive "evaluate at t then shift" is wrong, "not just a delayed copy", and "would make the search fail" (cbonitz finds it degrades but does not fully break).
10. Scoring: draw the modelled curve on the spectrogram and SUM the brightness of the pixels it covers. Sweep a few seconds of time offset and f0 for event 1, keep best. Event 2: sweep f0 only; its time placement is LOCKED to event 1 by flight geometry (a bad geometric offset genuinely penalises the candidate). Example top score 20.48 vs runner-up ~15 (runner-up's event 1 ~9.5/10.6, event 2 clearly off).
11. 200 m grid can miss truth by up to 141 m (score drops), so the 15k survivors are expanded to 100 m resolution (~30-40k points scored). Best point per flight pair, scatter event1 vs event2 scores, winner clearly separated. Then re-run finer with just that flight pair; heatmaps per event and combined, viewed in QGIS.
12. Single-flight variant: known UTC time (8:37 pm UTC) plus one faint ~1 min curve: restrict to flights at that time; scored against a hand-traced line instead of brightness. Same coordinates came out first. Need either two events or a tight time (or a known city so time can be loose).
13. Countermeasures: high-pass fails (curve returns after boost; band overlaps voice), loud speech doesn't mask, curve survives phone codec; cuts in the video destroy the time offset.
Runtime: not given in the video.

NOT stated: FFT size, frequency range, DEM name, ADS-B provider, type DB name, silence thresholds, score normalisation, sweep ranges.

## cbonitz verification (synthetic)
- t_r = t_e + r(t_e)/c, f = f0*c/(c+v_r) reproduces a propagation-only waveform to 0.026 Hz.
- 2-min trace, 0.4 Hz noise: v +-0.3 m/s, d +-20 m.
- Two-event search, 6 synthetic worlds (242 flights, 6 h, 40x40 km): right pair first 6/6; observer 85-465 m (one 830 m); 4 m with no model error. Funnel: offset filter keeps 98%, speed+distance 4%, silence 1.2%.
- Single flight: +-1 min clock -> right flight first 5/6; 1-hour window -> 0/6 (near ties).
- Mirror ambiguity: a straight pass cannot tell sides; turning breaks it (0.7 Hz at 0.1 deg/s, 6.3 Hz at 1 deg/s).
- Caveats: low-level GA may not broadcast ADS-B; silence filter can exclude the truth; phone codecs remove the fundamental but harmonics carry the curve.
- Compute: naive full grid ~60 GB; two-event search 5-10 min on a laptop; one CONUS day of non-jet ADS-B 0.3-3 GB.
- Suggested data: adsb.lol globe_history (free), OpenSky Trino, ADS-B Exchange (paid); USGS 3DEP / Copernicus DEM; ICAO Doc 8643.

## Reimplementations (self-reported claims, not run by us)
- flyover-locator (dopplergeo; Python/uv/FastAPI): noise-floor-normalised spectrogram; auto ridge tracking + exact Doppler fit with delay; adsb.lol daily archive (3-4 GB/day) filtered to <6000 m, no known jets, one point per 4 s -> ~280 MB/day index (6-7 min per day); 200 m coarse then 100 m fine grid; SRTM via AWS skadi; date discovery across days. Closest clone of the video pipeline.
- hermes plugin: whitened 1 s spectrogram, harmonic sum k<=6, CFAR, Viterbi multi-ridge, F-test vs constant tone; grid 1000/200/50 m; Copernicus GLO-30; tar1090-db types; Open-Meteo temperature. Honest eval: median ~12 km on solved clips, most unseen clips fail.
- DOPPLERGEIST: Python 3.11, adsb.lol archive, FFmpeg; self-described early beta; 21.9 m synthetic, 44 m / 357 m / 476 m on real replays.

## Prior work
- Ferguson (DSTO): single-sensor Doppler of propeller blade rate -> speed, CPA range, rest frequency (ASA 1995 https://auditory.org/asamtgs/asa95stl/4pSP/4pSP10.html ; Ferguson & Speechley 2009 IEEE JOE; Lo & Ferguson wide-aperture array). NPS thesis on Doppler/df-dt CPA detection (calhoun.nps.edu). UPC "Passive acoustic method for aircraft localization" https://upcommons.upc.edu/handle/2117/95089. adsb2dd (30hours) maps ADS-B to delay-Doppler for passive radar.
- colsto's earlier thunder video reached ~5 km. No Bellingcat write-up on aircraft Doppler was found.

## Reusable (INFERENCE, not tested)
- ADS-B history: adsb.lol daily/globe_history tars (free, ODbL) simplest; `traffic` (xoolive) with OpenSky Trino as alternative; pyModeS only for raw Mode S decoding (not needed with archives).
- Ridge tracking: scipy.signal.stft, per-bin median normalisation, Viterbi ridge (hermes plugin logic as template).
- DEM: Copernicus GLO-30 or SRTM via AWS.
- Types: tar1090-db or ICAO 8643; exclude jets, keep unknowns.
- Retarded-time curve: solve te by fixed-point iteration (2-3 iterations since v<<c) on an interpolated ENU trajectory; vectorise over candidates.
