# Lane E report: application UI

The single-page app is in `web/index.html`. It uses plain ES modules, has no build step, and needs only a static host. Leaflet 1.9.4 is loaded from unpkg with SRI. Since E3 the app runs on **Lane D's real engine** (`web/engine/geoloc.js`) by default. `?engine=stub` switches back to the UI stub, which simulates search results and is labelled as such.

Run it by serving the project root (`python -m http.server 8766`) and opening `http://127.0.0.1:8766/web/index.html`. Serving the root makes `/fixtures` reachable for the demo and for the stub engine.

## Files
| file | role |
|---|---|
| `web/index.html` | page structure: top bar, five-step sidebar, spectrogram pane, map pane, shortcuts dialog |
| `web/ui/styles.css` | design tokens in OKLCH (graphite neutrals, one cobalt accent, amber for signal), components, responsive and reduced-motion rules |
| `web/ui/app.js` | app shell: state, rendering, event marking, flights, search, results, keyboard, drag-drop, draft restore |
| `web/ui/spec-panel.js` | wraps `SpectrogramView`: STFT presets in the DSP worker, one-click ridge tracking in the track worker, synced `<audio>` playback, line and band overlay layers, ridge options per aircraft class |
| `web/ui/spectrogram-view.js` | Lane C's viewer, taken over in E2: added `setOverlays()` and a filled `band` overlay type |
| `web/engine/ridge-extend.js` | E2: `extendRidge`, one-click ridge auto-extension on top of `trackRidge` |
| `web/workers/track.worker.js` | E2: holds one copy of the spectrogram and runs `extendRidge` per click |
| `web/ui/track-cache.js` | E2: optional IndexedDB cache of fetched flight tracks |
| `web/tests/ridge_extend.test.mjs` | E2: Node tests for scenario1 accuracy and the colsto one-click span |
| `web/ui/map-panel.js` | Leaflet: circle and rectangle search area with drag handles, flight tracks (canvas renderer), score heat map (image overlay), ranked candidate pins |
| `web/ui/store.js` | project JSON (`format: "overhead-project", version: 1`), normalising, localStorage draft (every access wrapped in try/catch) |
| `web/ui/export.js` | GeoJSON and CSV export, Google Maps and Street View URLs |
| `web/ui/time-utils.js` | time-zone conversions using only Intl (wall time in a zone ↔ UTC), formatting |
| `web/ui/engine.js` | **the only import of the engine; the stub/real switch is one line here** |
| `web/engine/geoloc-api.md` | the interface the UI needs from Lane D |
| `web/engine/geoloc-stub.js` | stub that implements that API |

Reused unchanged: `engine/audio.js` (decode and creation-time metadata), `engine/ridge.js`, `engine/stft.js`, and `workers/dsp-client.js` with `dsp.worker.js`. The only change to a Lane C file is the additive E2 change to `spectrogram-view.js`; the earlier API is unchanged. The suite still passes: `node --test web/tests/*.test.mjs` reports **31 pass, 2 skipped, 0 fail** (Lane C's tests plus 2 new ones).

## Screens (`docs/img/`)
| screenshot | shows |
|---|---|
| `lane_e_empty.png` | new project: drop zone, demo button, privacy statement |
| `lane_e_demo_loaded.png` | demo recording decoded; time window and search area pre-filled |
| `lane_e_how_it_works.png` | E2: "How it works" explainer, 5 plain-language steps and a small diagram (also reachable from the top bar and the empty state) |
| `lane_e_events_marked.png` | two events tracked (ridge, dashed fit curves on harmonics 1–4, CPA markers, Δt between events), a silence band drawn on the canvas, and the view auto-zoomed to the events' band |
| `lane_e_large_file.png` | E2: large-recording panel with the memory estimate and the time-range option (forced with `?largeMin=10`) |
| `lane_e_colsto_oneclick.png` | E2: colsto, cropped to 3:00–21:00, one click per pass; event 1 spans 200.5–277.0 s |
| `lane_e_manual_mark_silence.png` | an event marked with a real mouse click and a silence interval dragged in Silence mode |
| `lane_e_run_progress.png` | per-stage progress with survivor counts and a Cancel button |
| `lane_e_results.png` | ranked candidates, heat map, the assigned flights highlighted, simulated Doppler curves (white, dashed) over the spectrogram |
| `lane_e_upload_colsto_flights.png`, `lane_e_upload_colsto_results.png` | the real Long Island recording uploaded through the file input: 747 adsb.lol tracks on the map, then results |
| `lane_e_imported_reattach.png` | a project file re-opened without its media, with the prompt to re-attach the file |
| `lane_e_shortcuts.png` | keyboard shortcuts dialog |
| `lane_e_mobile.png` | 390 px wide: everything stacks into one column, no horizontal overflow |

Not retaken in E2 (still accurate apart from the old frequency zoom and the missing "How it works" button): `lane_e_demo_loaded`, `lane_e_manual_mark_silence`, `lane_e_run_progress`, `lane_e_upload_colsto_*`, `lane_e_imported_reattach`, `lane_e_shortcuts`.

## Flow
1. **Recording.** Drag a file anywhere on the page, or choose one; the file is decoded locally at 8 kHz.
   * The panel shows duration, size and channels, plus the creation time from metadata (Apple `creationdate`, `mvhd` or `©day`) and where it came from. The UI notes that this time may mark the end of the recording rather than the start.
   * The window for the recording start is set with a time zone (IANA names, typed with suggestions) and earliest/latest wall times. Chips set ±1 h, ±3 h, ±12 h or the whole day around the creation time; the earlier bound also subtracts the duration. The equivalent UTC window is shown.
2. **Search area.** The area is a circle or a rectangle.
   * Click the map to place it. Drag the centre handle to move it and the edge or corner handles to resize it.
   * Chips set 2, 5, 10 or 25 km. Lat, lon and size can also be typed, which is the keyboard-accessible path.
   * The panel shows the area in km² and the grid-point count at the chosen spacing.
3. **Spectrogram and events.**
   * Presets: standard (2048/4096/hop 512 at 8 kHz, roughly 1.95 Hz × 64 ms cells), fine, and a fast overview. The band is fixed at 30–2000 Hz and frequency whitening is always on.
   * Options: **Hum** (running median over 120 s) and **Impulses** (dB clip, plus `impulseDb` and `emClip` in the tracker).
   * Display controls: contrast, colour map, Fit.
   * Playback uses an `<audio>` element on the original file. The cursor is synced, with a Follow toggle and a scrubber.
   * **Mark mode** (`M`): clicking a curve runs `trackRidge` in the worker. Harmonic stacking depends on the class: prop [1,2,3], heli [1,2], jet [1] with a larger slope limit; prop and jet tracks are monotonic.
     * Alt+click adds another click to the selected event; the tracks are merged frame by frame.
     * If the clicked line is harmonic n, the card's "Clicked line" selector divides by n.
   * `fitEvent` then returns t_cpa (the delayed CPA), F0, v and CPA-distance ranges.
   * Each event card has editable fields, a class selector, "Use fit" to revert edits, Zoom and Delete (with Undo). The Δt between consecutive events is shown.
   * **Silence mode** (`S`): drag across a stretch to record a silence interval. Overlapping intervals merge, and each is shown as a band and as a removable chip.
4. **Flights.** "Fetch flights" (cancellable, with progress) calls `fetchFlights`.
   * Tracks are drawn by category colour, with a tooltip giving callsign, type and category.
   * Per-category toggles show counts and filter both the map and the search input. Jets are off by default.
   * The source and the adsb.lol ODbL attribution are shown. A warning appears when the area or time window has changed since the last fetch.
5. **Search.** Settings: grid spacing, air temperature (giving the speed of sound), time tolerance, top N.
   * The panel says exactly what is missing before a search can run.
   * One row per stage (grid, delayed CPA, filters, Doppler simulation, scoring, refinement), each with progress, survivor count and message. Cancel is available.
   * **Results:**
     * on the map: the heat map and numbered pins;
     * in the list: rank, coordinates, score, the inferred recording start (in the chosen zone, with its UTC offset), matched flights (callsign and type) and ground elevation;
     * actions: copy coordinates, Google Maps, Street View (`map_action=pano`), zoom the map;
     * GeoJSON export (points, plus the search polygon) and CSV export.
   * Selecting a candidate highlights its flights and overlays `simulateCurves` on the spectrogram.
6. **State.**
   * The project is autosaved to localStorage (debounced, plus on `beforeunload`). On reload a banner offers "Draft restored … Start over".
   * Save project (`Ctrl+S`) and Open project are available. Media and flight tracks are not stored, so the app asks you to re-attach the file. For the demo, "Reload demo audio" does it in one click.
   * New, Demo and import keep an Undo snapshot.
   * The Demo loads `fixtures/scenario1/audio.wav` with a ±2 h window (America/New_York) and a 5 km area. "Mark both for me" clicks the `events_measured.json` positions, skipping passes the user has already marked.

Accessibility:
* semantic sections, labelled inputs, `aria-pressed`/`aria-checked` toggles, live regions for status, toasts and progress;
* `:focus-visible` rings, a skip link, a native `<dialog>`, and keyboard paths for every action except dragging the map handles (typed inputs cover that);
* `prefers-reduced-motion` respected.

Shortcuts: `V M S` modes, `Space` play, `←/→` seek (Shift for 30 s), `[ ]` previous/next event, `1–4` class, `Z` zoom, `Del` delete, `Enter` (Mark mode) marks at the crosshair, `Ctrl+S` save, `?` help.

## Browser verification (Playwright MCP, Firefox, served with `http.server`)
* **Demo:** decode and STFT of 1150 s took about 2.7 s (17,965 × 1009 cells).
  * Tracking and the stub fit put the two passes at t_cpa **102.36 s** and **1023.94 s** (truth 102.18 and 1023.70). F0 was 127.8 and 111.8 Hz (truth 128 and 112); v 57.3 and 54.1 m/s (truth 57.5 and 56.5); d 754 and 1110 m (truth 748 and 1212). Fit RMS was 0.32 and 0.42 Hz.
  * Fetch returned 6 fixture tracks, and the search ran with progress, cancel and re-run.
  * The top candidate is the scenario answer (the stub peaks there on purpose). Its **simulated curves for N172AB and N28PA lie on the measured ridges**: the stub's simulation uses real retarded-time physics.
* **Upload:** `fixtures/real/colsto_longisland/audio.wav` (48 MB, 25 min) went in through the file input.
  * Zone set to America/New_York, window 2026-09-08 16:00–23:00, area 8 km around 40.87, −73.50.
  * One real click per pass gave events at 261.4 s and 1163.4 s (Δ 902 s; event 2: F0 149 Hz, v 56 m/s, d 836 m).
  * Fetch loaded **747 real adsb.lol tracks** from the 24 MB fixture (prop 130, heli 7, jet 583, unknown 27). The search and results worked.
  * `meta_apple.mov` showed its creation time correctly (07:08:10Z = 03:08 EDT) and pre-filled the window.
* **Also checked:**
  * GeoJSON and CSV downloads (validated: 10 points plus the polygon) and the project round-trip (export, clear, import, re-attach the demo, draft restore);
  * keyboard modes, Delete followed by Undo, and playback;
  * the 390 px mobile layout (`scrollWidth − clientWidth = 0`).
* **Console: 0 errors and 0 warnings across the whole session.**

## E2: UX polish (after validation)
1. **Default frequency view.** After decoding, the view shows 30–700 Hz instead of the full 30–2000 Hz. Once events exist it fits their band instead: 0.7 × the lowest fundamental up to 3.4 × the highest, which shows three harmonics. The same band is used after "Mark both for me" and by **Fit**. Recomputing after a settings change keeps the current view.
2. **`setOverlays(entries)` and band overlays** in `spectrogram-view.js`.
   * `setOverlays` replaces every overlay in a single redraw and accepts a Map, an object or `[[id, ov]]`.
   * `{type: 'band', t0, t1, f0?, f1?, fill, stroke, label}` draws a filled region underneath the line overlays.
   * Silence intervals now use band overlays. The DOM layer and its CSS are gone.
3. **One-click auto-extension** (`web/engine/ridge-extend.js#extendRidge`, run in `track.worker.js`).
   * A single `trackRidge` call only searches `f_click·(1±0.25)` and keeps the confident piece around the click, so a 172→97 Hz sweep gets cut short.
   * `extendRidge` re-seeds at each end with the band re-centred there. If a step finds nothing, it jumps 3 s and then 6 s along the local (falling) slope to cross gaps.
   * Each new piece must join the extrapolated line within tolerance and must not rise.
   * Pieces found across a gap must also last at least 3 s and have a mean SNR of at least 0.6 × the track's median (minimum 4 dB). This gate stopped drift onto noise.
   * It uses Lane C's C6 real-audio options: harmonics [1,2,3], `monotonic:'down'`, robust null at z = 1.5, `maxGapS` 4, `snap` 6; plus `emClip` 15 and `impulseDb` 6 when Impulses is on.
   * **Colsto event 1:** one click at 230 s, or anywhere on the curve, spans **200.5–277.0 s, 172 → 97 Hz** (Lane C's three clicks gave 201.2–276.0 s). The fit is F0 113.0 Hz, v 138 m/s, d 6.25 km, matching Lane C's 113.06 Hz, 139 m/s and 6.22 km. Event 2: 1142.5–1190.5 s.
   * **Scenario1:** the median error is 0.41 Hz against the exact simulation, and t_cpa is 102.3 s and 1024.3 s (truth 102.18 and 1023.70).
   * Each click costs 70–330 ms in Node. The spectrogram is cloned to the worker once per STFT, not once per click.
4. **Re-tracking.** Changing Hum, Impulses or the preset recomputes the spectrogram and re-tracks every event that came from clicks and was not hand-edited. A toast reports it. Scenario1: 910 → 906 → 910 points as Impulses went off and back on.
5. **Large files.** The duration comes from the MP4/MOV header, or from the browser's own demuxer (`<audio>` metadata, ~4 s timeout).
   * Above **1 GB or 60 min** an inline panel in step 1 shows the size, the duration and the **estimated peak memory**. The estimate assumes the browser decodes at 48 kHz stereo (Lane C measured 2.5–3.7 GB for 1 h), plus three spectrogram copies.
   * The options are: *Analyse this range* (From/Until as m:ss or h:mm:ss, with a live estimate), *Analyse everything*, or *Cancel*.
   * The whole file is decoded, then cropped **before the STFT**. The spectrogram keeps the original time axis (`spec.t0 += crop start`), so playback, events and t_cpa are all in recording time.
   * The crop is stored in the project. "Change range… / Analyse a range…" is available for any file.
   * The thresholds can be overridden with `?largeMB=` and `?largeMin=`, for testing.
6. **IndexedDB track cache.** Every successful fetch is cached under (source, bbox, window); the newest 6 entries are kept. On reload, project import or undo, the tracks are restored automatically, the selected candidate is re-highlighted and its curves re-simulated. Every IndexedDB call fails silently. Verified: after a reload the app reported "747 flights restored from this browser's cache" and the search was ready with no refetch.
7. **Onboarding.** A "How it works" button in the top bar and a compact 5-step card beside the drop zone (hidden on phones) open a dialog. It has a small inline-SVG diagram (a plane passing near you; the falling high→low curve with the closest-approach marker) and five plain-language steps, plus a note on what works best.

E2 browser re-test (Playwright Firefox): the full demo flow; colsto through a forced large-file panel with a 3:00–21:00 crop, one-click marking, fetch, search, and reload with restore from IndexedDB; re-tracking on toggle; the explainer; and 390 px mobile with no horizontal overflow. **Console: 0 errors and 0 warnings.**

## E3: real-engine integration and end-to-end results
**Wiring**
* `web/ui/engine.js` defaults to `real`; `?engine=stub` keeps the stub.
* The top-bar badge reads "ENGINE 1.0.0".
* **Event cards:**
  * When `fitEvent` sets `poorly_constrained`, the card shows an amber "Loosely measured" note listing `quality.reasons` in plain words, and says the ranges are soft hints.
  * A **Lock ranges** checkbox sends `locked: true`, which turns the ranges into hard gates.
  * The fit's `t_sigma_s` is passed to the search.
* **Search settings:**
  * a **Robust / Faithful** toggle, each with a one-line explanation;
  * **Terrain**: Automatic, real (Terrarium), or the synthetic terrain of scenario 1 or 2. Automatic picks the scenario terrain when the flights came from that scenario's fixture (new `web/ui/scenario-dem.js`, a port of Lane D's analytic DEM);
  * **ADS-B proxy URL** (developer; empty means the built-in fixture/synthetic data). It is passed as `query.worker`.
* **Engine inputs:**
  * The search now receives the engine's own **reference spectrogram** (`referenceSpectrogram(samples, 8000)`, the validated 4096/1024 settings), computed once per decode and shifted to recording time for crops. The display spectrogram is not used for scoring.
  * Defaults follow Lane D's validated setup: grid 200 m, time tolerance 8 s. The demo region is a ±12 km rectangle.
* **Results:**
  * A **confidence panel** appears above the candidate list.
    * When the result is clear, it reads "Clear winner. The best place scores N % above the next distinct alternative".
    * When `confidence.ambiguous` is set, it reads **"Two places fit almost equally well"**, followed by a table comparing the best and the runner-up: position (km apart), flights, recording start (± s) and score. It has **Show #1 curves** and **Show runner-up curves** buttons.
    * A line underneath gives the mode, executor, worker count, wall time and grid size.
  * Each candidate shows its margin below the best (−x %). A runner-up that is not in the top list is appended and labelled "R".
* **Progress:** each stage row shows the survivor count and the **wall time measured in the UI**. Cancel goes through `AbortSignal`.
* **Stub fixture map:** `fixtures/scenario2/tracks.json` was added to the stub's fixture table, which the real engine falls back to when no ADS-B proxy is set.
* **Demo:** "Mark both for me" now also copies the speed and distance ranges from `events_measured.json`, as a user who read the curves would. See finding 1 below.
* A **slow-search warning** appears in the Search step when a robust search will be slow: more than 150 flights, or a window longer than 6 h.

**End-to-end in Playwright (Firefox 158, 16 hardware threads, worker pool ×16).** Times come from the UI's stage rows; screenshots are `docs/img/lane_e_e2e_*.png`.

| case | how | top candidate vs truth | flights | T_start error | confidence | wall (UI) |
|---|---|---|---|---|---|---|
| scenario1 demo, robust | Demo; one-click tracking + measured ranges | **37.6 m** | P1 + P2 ✓ | −0.42 s | **ambiguous**, margin 0.2 % (alias 8.2 km away: P1 + P5, −148 s) | 9.2 s cold / **2.9 s** warm |
| scenario1 demo, faithful | same | **37.6 m** | P1 + P2 ✓ | −0.42 s | clear, 56 % | **1.9 s** |
| scenario2 upload, robust | `audio.wav` through the file input; Europe/Zurich, 10:00–13:00 local; ±12 km; 3 one-click events + typed measured ranges; fixture tracks; scenario terrain picked automatically | **27.6 m** | Q1 + Q2 + Q3 ✓ | −0.17 s | clear, 53 % | **3.3 s** |
| scenario2 upload, faithful | same | **27.6 m** | Q1 + Q2 + Q3 ✓ | −0.09 s | clear, 100 % | **2.2 s** |
| colsto upload, robust | one click per pass; window 2026-09-07 20:00 → 09-09 02:00 EDT (30 h); ±12 km around 40.87, −73.50; real terrain; 779 non-jet fixture tracks | 40.7848, −73.4978: about **9.5 km S** of the rough reference point (whose own uncertainty is 1.5 km) | a99f31 + ab67f6 | T_start 2026-09-08 22:02:27Z | ambiguous, 3.0 %: #2 is 5.2 km N with the same flights | **1448 s** |

Per-stage UI times (seconds):

| case | grid | CPA | filters | sim | score | refine |
|---|---|---|---|---|---|---|
| s1 robust, warm | 1.90 | 0.23 | 0.03 | 0.00 | 0.26 | 0.48 |
| s1 faithful | 1.56 | 0.05 | 0.04 | 0.00 | 0.03 | 0.18 |
| s2 robust | 2.62 | 0.06 | 0.02 | 0.00 | 0.17 | 0.44 |
| s2 faithful | 1.99 | 0.05 | 0.00 | 0.00 | 0.03 | 0.16 |
| colsto robust | 4.40 | 5.47 | **1184.8** | 2.79 | 228.1 | 22.6 |

* The "grid" row covers everything before the first CPA progress message. That includes the engine's per-event ridge refits (`fitPass`), whitening, DEM evaluation and worker start-up. The engine's own `timings.init + grid_dem` is only 0.3–0.4 s warm, so most of the 1.5–2.6 s is the ridge refits.
* The cold first run (9.2 s) also includes module loading and worker spawn for 16 workers.
* **Console: 0 errors, 0 warnings** across all E2E runs.

**Findings for Lane D / the orchestrator**
1. **With pure one-click events, scenario1 picks the alias.** The real `fitEvent` honestly flags event B as poorly constrained (77 % of the swing seen) and returns v 27–83 m/s, which admits P5 at 70 m/s. Robust mode then ranks the 8.2 km alias (N172AB + N5E) first by 1.1 %, and the truth comes second; the UI says "ambiguous". With the measured ranges, the truth wins by 0.2 %. The UI handles this honestly by showing both places and their curves.
2. **Robust mode does not scale to real traffic.** colsto, with 779 flights × 14,400 grid points over a 30 h window, produced 582k (point, flight) survivors. The filters stage took **1185 s** and scoring 228 s, 24 min in total. (The browser stayed responsive, but the run finished while system memory was low.) A narrower time window, faithful mode, or an engine-side prefilter (for example, keeping only flights whose delayed CPA can fall inside the window for each event) is needed before real cases are usable. The UI now warns before such runs.
3. Colsto result: the top two candidates share the same flight pair and differ along that geometry (5 km apart). Both colsto events are flagged "Loosely measured" (69 % and 74 % of the swing seen). Event A's free fit (v 140 m/s, d 6.4 km) lies outside the prop envelope, so the prior dominates.

## E4: live mode in the app, deploy-ready bundle, legal footer
**Live mode ("Record now")**
* **Modules:** Lane L's modules moved from `web/dev/live/` to **`web/live/`** (`recorder`, `session`, `adsb-live`, `clock`, `geoid`). Imports were updated in `web/dev/live.html`, `web/tests/live_unit.test.mjs` and `live_e2e.mjs`, and Lane L's 5 unit tests still pass. The new UI is `web/ui/live-panel.js`.
* **Entry points:** "Record now" in step 1, "Or record a pass now" in the empty state, and "Record new…" once a file is loaded.
* **When there's no ADS-B proxy:** all of them are disabled, with the explanation "Live recording needs the ADS-B proxy … Set its URL under Search settings → ADS-B proxy URL" and an "Open search settings" button. They are also disabled, with a reason, on insecure (http) pages or browsers without AudioWorklet.
* **Where the proxy URL comes from:** Search settings, `?proxy=`, or `config.js` in production. New and Demo keep it, because it is an environment setting rather than project data.
* **Flow:**
  1. The live panel explains what is sent and that the sound stays on the device.
  2. The user gives a rough area: click the map to place a 6 km circle, or type it. No geolocation is needed; "Use my device location (optional)" is offered.
  3. Microphone permission, with readable errors: blocked, no microphone, device busy.
  4. While recording: a timer, a level meter, and "N aircraft seen nearby · k updates · clock synced to ±x ms". Polling runs every 15 s through the proxy.
  5. On "Stop and analyse": the audio is saved as a WAV file and decoded like an upload. **T_start = audio anchor + server clock offset, ±3 s**, and step 1 then shows it in place of the time inputs. The tracks of nearby low aircraft are backfilled (`finishTracks`), cached in IndexedDB and drawn on the map. A banner says "one pass is enough".
  6. The search runs with `time = T_start ± 3 s`.
* **Worker live routes** (`worker/src/index.js`): `/v2/point/<lat>/<lon>/<nm>` (5 s edge cache per 0.05° cell) and `/data/traces/<xx>/trace_{full|recent}_<hex>.json` (60 s / 10 s cache, hex regex). Every response gets **`X-Server-Time-Ms`**, a fresh `Date` and the exposed headers. The browser (`web/live/session.js`) syncs its clock to `X-Server-Time-Ms`.
  * This **fixes a bug found while testing**: through a caching proxy, a snapshot's JSON `now` can be up to 5 s stale, which would have biased T_start beyond the ±3 s tolerance.
  * The routes were tested in Node with a mocked fetch and Cache API. Two nearby users produced one upstream call, malformed paths were rejected, and the CORS headers were correct.
* **Fake-microphone end-to-end test:** `PW=<playwright-core> node web/tests/live_app_browser.mjs`. It uses Firefox headless with the fake mic, against the main app, through Lane L's dev proxy, with **real adsb.lol live data** around Sabadell.

  | | run 1 | run 2 |
  |---|---|---|
  | recorded | 38.8 s | 39.6 s |
  | aircraft seen | 30 | 30 |
  | clock offset (min RTT) | −615 ms (189 ms) | −615 ms (184 ms) |
  | anchor after the click | 1425 ms | — |
  | tracks backfilled | 3 prop (6/6 requests OK) | 3 prop + 1 jet |

  * In both runs the time panel read "Known from the live recording … ±3 s".
  * A hand-entered event was added, because the fake mic has no Doppler curve. The search then ran with **`time` = 6 s wide (T_start ± 3)** in **1.4 s** and returned 10 candidates. Stage times: grid 1.09, CPA 0.02, filters 0.00, score 0.07, refine 0.12 s.
  * **0 console errors or warnings.**
  * Screenshots: `docs/img/lane_e_e4_live_setup.png`, `lane_e_e4_live_recording.png`, `lane_e_e4_live_done.png`, `lane_e_e4_live_search.png`.
  * The location quality of a real outdoor recording is not tested here. Lane L's synthetic pass on real live tracks gave 5 m.
* **Bugs found and fixed by the test:**
  * New and Demo wiped the proxy URL.
  * The live panel did not refresh when the area was typed.
  * A blur-triggered `change` event re-rendered the panel and swallowed the Start click. The panel now re-renders only when the area really changes.

**Deploy-ready bundle (not deployed):** `deploy/README.md`, `deploy/build.mjs`, `web/_headers` and `web/config.js`.
* `node deploy/build.mjs <worker-origin>` builds `deploy/dist/`: 50 files, 19.0 MB.
  * It excludes `web/tests`, `web/dev`, `*.md` and dotfiles; `fixtures/` and `ref/` are never included.
  * The demo uses only `web/demo/scenario1/`: audio, tracks, measured events and `scenario.json` (terrain).
  * It writes the Worker origin into `config.js` and into the CSP `connect-src`.
* **Demo paths:** the demo audio, the stub's fixture fallback and the scenario terrain now try `web/demo/…` first and fall back to `fixtures/` in development.
* **Served from `web/` alone** (`python -m http.server` in `web/`, so no `../fixtures`): the demo, fetch (from the demo copy) and a faithful search all worked, with the top candidate at 40.79385, −72.88262, P1 + P2, ground 240 m, which means the scenario terrain was used. There were **no 4xx responses** and 0 console errors or warnings.
* **CSP** without `unsafe-inline` or `unsafe-eval`; `blob:` for the AudioWorklet; unpkg for Leaflet; tiles; DEM; the Worker. `Permissions-Policy` limits the microphone and geolocation to self. Caching: `no-cache` for `index.html` and `config.js`, a 5-minute revalidating cache for code, one day for `data/` and one week for `demo/`.
* **COOP/COEP are not set.** The engine uses SharedArrayBuffer only opportunistically and copies Z otherwise. `require-corp` would break the Esri/OSM tiles. `credentialless` is a documented opt-in; it does not work in Safari.

**Legal footer and dialog:** the sidebar footer now holds:
* "Private by design" (media processed locally; only the area and time window, or the rough area when live, are sent);
* "Results are probabilistic" (verify independently);
* the adsb.lol **ODbL 1.0** attribution with a link, AWS Terrain Tiles, Esri and OSM tile attributions, and tar1090-db;
* a **"Data, privacy & licences"** dialog with the full text.

The map keeps Leaflet's own attribution control. Screenshot: `docs/img/lane_e_e4_bundle_footer.png`.

**Tests:** `node --test web/tests/*.test.mjs` reports **49 pass, 2 skipped, 0 fail**.

## E5: polish
**Demo audio as AAC.**
* `web/demo/scenario1/audio.m4a` is 32 kbps AAC-LC, mono, 8 kHz, with faststart: 4.6 MB, down from the 18.4 MB WAV. The WAV was removed from `web/demo/`. The bundle is now 5.3 MB in total.
* The "~1 MB at 64 kbps" target is not physically possible for 19 min: 64 kbps × 1150 s ≈ 9 MB. AAC at 8 kHz gives 3.5 MB (24 kbps), 4.6 MB (32) or 5.4 MB (48, already at the encoder's ceiling).
* **Validation:** each bitrate was decoded back with ffmpeg and run through the app's pipeline in Node: one-click `extendRidge`, the real `fitEvent`, the measured ranges, and the real `runSearch` with the analytic terrain.

  | audio | faithful | robust |
  |---|---|---|
  | WAV, 24, 32 and 48 kbps | **15.5 m**, P1 + P2 | **15.5 m**, P1 + P2 |

  * The ridge SNR is unchanged (10.3–10.8 / 6.2–6.3 dB), so the faint harmonics survive. 32 kbps keeps the score closest to the WAV (2.581 vs 2.597; 24 kbps gives 2.521).
  * In the browser (Firefox decoding the .m4a, served from `web/` alone), the demo finished in robust mode at **37.6 m** with P1 + P2 and T_start −0.24 s. The ridges match the Node run (t_cpa 102.38 / 1024.30 s), so AAC priming was trimmed correctly.
  * Node and browser differ (15.5 vs 37.6 m) because the browser uses the worker pool, the full UI flow and the ±2 h time prior. Both are well under 50 m.

**Critique and audit (impeccable).**
* The bundled detector on `index.html` and `styles.css` found one issue: an animated `width` on the live level meter. It now uses `transform: scaleX`.
* My design review found the following; all are fixed:
  1. **The five steps had no clear next step.** The first unfinished step is now tinted and gets a primary ring and a "Next" label (`aria-current="step"`). Steps that are neither done nor current are dimmed.
  2. **Jargon replaced with plain words for non-experts**, keeping the technical term in tooltips:
     * steps: "Rough area", "Aircraft you can hear", "Flight history", "Find the location";
     * event fields: "Pass A", "Closest at (s)", "Engine tone (Hz)", "Closest distance (m)";
     * settings: "Timing slack", "Test-point spacing";
     * search stages: "Laying out places to test", "When each plane was closest", "Ruling out mismatches", "Simulating each plane's sound", "Comparing with your recording", "Zooming in on the best places";
     * "Only part of this pass is visible" instead of "poorly constrained".
  3. **Empty and error states:**
     * *No flights found*: a warning note in step 4 suggests widening the window or the area, and explains that transponder-less planes never appear.
     * *ADS-B proxy unreachable*: "Can't reach the flight-data relay at <url> …" appears in step 4. During a live recording, the panel shows the same message after 2 failed polls with no successes.
     * *Nothing plausible*: "No place fits these sounds", with four concrete fixes, plus a plain-language toast.
     * Tested in Firefox: an unreachable `http://127.0.0.1:9` proxy showed the message, and a jets-only faithful search returned 0 candidates and showed the panel.
  4. **Focus order:** mobile no longer reorders the workspace visually (it was `order: -1`), so visual order matches DOM and focus order: skip link → top bar → hero → steps → spectrogram → map.
  5. **Contrast and touch targets:**
     * placeholders now use `--ink-3`, about 5.9:1 on the surface;
     * on screens ≤ 860 px or with a coarse pointer, buttons, segmented controls and inputs are ≥ 42 px tall and chips ≥ 36 px;
     * on 390 px, no horizontal overflow. The remaining small targets are inline footer links and checkboxes, which sit inside larger labels.

**First-visit hero.** On a first visit with no media and no events, a hero shows above the tool:
* a one-sentence headline, "Find where a video was filmed, from the planes you can hear in it.", and a short plain explanation;
* **Try the demo** (primary), Use my own video…, How it works;
* the privacy line, and a small spectrogram-style picture of a falling engine tone with its simulated match;
* "Go to the tool".

It collapses as soon as a file, the demo or a recording is loaded, or when dismissed (remembered in localStorage, wrapped in try/catch). While it shows, the duplicate "How it works" card in the empty state is hidden.

Screenshots: `docs/img/lane_e_e5_hero.png`, `lane_e_e5_mobile_hero.png`, `lane_e_e5_events.png` (current-step highlight on "Flight history"), `lane_e_e5_results.png`, `lane_e_e5_no_result.png`, `lane_e_e5_proxy_error.png`.

**Browser console:** 0 errors and 0 warnings across all E5 runs, and no 4xx responses when served from `web/` alone.

**Tests:** `node --test web/tests/*.test.mjs` reports 51 pass, 2 skipped, and **1 failing file, `geoloc_perf.test.mjs`**. That is a new Lane D test still being tuned during profiling: its work and pairs budgets fail. It is not touched by E5. All Lane C, D (functional), E and L tests pass.

## E6: flight-coverage check, partial days and terrain fallback
**Coverage verdict.** As soon as flights are fetched, the Flights step shows the verdict from Lane B's checks (`adsb.js#coverage` and `coverageVerdict`, DATA.md §9). It counts light aircraft (non-jets) below 1500 m MSL within 5 km of the area centre, over the window the recording can span (earliest start to latest start + duration).
* **With an ADS-B proxy:** the verdict is refined in the background with `coverageBaseline` (other days at the same time) and `fetchDayStatus` (archive completeness), with 15–20 s timeouts.
* **Without a proxy:** dev fixtures come from `web/ui/dev-fixtures.js`. The `geoloc*` files were not touched. For terrace, Lane B's measured day status (DATA.md §9) is included so the partial-day warning can be tested offline.

What each verdict shows:
* **ok:** green, with the counts and any partial/missing-feed notes.
* **weak:** amber.
* **poor:** a red box, "Results unlikely: low-flying aircraft weren't received here on that date", with a plain explanation, Lane B's messages (including partial-archive and empty-feed lines), **Search anyway** and *Change the date or time*. The search is blocked until the user chooses *Search anyway*.

**Terrain fallback.**
* For real terrain, the UI now creates its own `createDem({retries: 3})`. A tile failure shows "Terrain data could not be loaded …" with **Continue with flat terrain (less accurate)** and *Try again*.
* Flat terrain uses `createDem({retries: 1, fallbackElevation: 0})`. The result line then says "flat terrain (less accurate)".

**Tests (Playwright, Firefox):**

| case | result |
|---|---|
| LELL 2026-11-01, 08–16 local, 8 km | **ok**: 21 light aircraft, 5.88 per hour (matches DATA.md) |
| Terrace 2026-06-11, 16–18 local | **poor**: 0 light aircraft, prod archive partial (42,314 traces), mlatonly empty. Run blocked; after *Search anyway* the blocker cleared |
| Demo with real terrain, DEM tiles blocked | the note appeared; the flat fallback gave P1 + P2, 186 m (the scenario's 240 m hills flattened to 0) |

* The only console errors were Firefox's network messages for the tiles the test deliberately blocked.
* Screenshots: `docs/img/lane_e_e6_coverage_ok.png`, `lane_e_e6_coverage_poor.png`, `lane_e_e6_dem_failed.png`, `lane_e_e6_flat_terrain.png`.

## E7: absolute verdict, montages, ground operations, final end-to-end
**Absolute verdict first.** `confidence.absolute` (Lane D §11.1) now opens the Results section, above the candidate list.
* **match** (green): "The sounds match the flight data."
* **weak** (amber): "A possible match, but not a convincing one … treat it as a lead to verify, not as an answer."
* **no plausible match** (red): "No place fits these sounds well. The planes you hear are probably not in the flight data", with plain likely causes. The candidates, the map pins and the heat map stay hidden behind **"Show the closest candidates anyway (N, unreliable)"**.
* Each verdict lists every pass in plain words: "Pass B: matches its predicted sound only loosely (EGE93)", "… the matching flight's track does not cover the moment you heard it", "no flight in the data could have made this sound here". With no candidate at all, the engine's reason is shown instead. The engine's technical reasons sit in a "Technical details" disclosure.

**Montages.** In step 3, the checkbox "This video is edited (several clips)" opens a panel.
* Cuts are added with a **Cut** pointer mode (`C`, then click), or by **Detect cuts automatically**.
* `web/ui/segment.js` is a JS port of Lane F's `ref/validation/segment.py`: 64 ms frames, 24 log bands, 1 s novelty × abrupt jump, threshold 8, at least 4 s apart. On KSMO it reproduces the Python cut times (1.0, 25.7/26.2, 43.7, 71.8, 101.4 s …) in about 0.3 s. Cuts scoring under 12 are shown as "weak ?" chips so false positives are easy to remove.
* Cuts are drawn on the spectrogram ("clip 2 ▸"). Each pass gets a "clip n" badge from its time, and the search receives `events[].clip` and `clips[]`.
* Results list, per clip, when that clip was filmed: the engine's T_start plus the clip start.

**Ground operations.** `fitEvent`'s `flyover` flag is shown on the event card: "Not a flyover. No Doppler swing (1.4 %): static tone / ground run. Ground operations … are left out of the search." There is a **Use it anyway** checkbox. Excluded passes are dimmed and not sent, and the run hint counts only passes that are sent. "Use it anyway" sends the pass with `keepGroundOps`. Tested on a terrace run-up tone (1095 s), which was classed `static`.

**Final end-to-end** (Firefox, worker pool ×16, Lane D's engine as of D11). UI stage times are in seconds: grid / CPA / filters / sim / score / refine.

| case | flow | result | verdict | search time, stages |
|---|---|---|---|---|
| Demo scenario1 (AAC) | demo, "Mark both", fetch, robust | **24.1 m**, P1 + P2 | **match** | 1.1 s: 0.59 / 0.03 / 0 / 0 / 0.17 / 0.09 |
| **colsto (real)** upload | one click per pass (ridges 196.6–277.1 s and 1142.3–1190.9 s, both flyovers); 30 h window; ±12 km; real terrain; 779 non-jet tracks; coverage ok | **40.87616, −73.52391**, 78 m from the expected 40.876, −73.523; flights a1dfeb (CST1219) + ace391 (EGE93); T_start 2026-09-08 20:49:11Z; margin 1.86 | **match** (both passes "matches well") | **7.5 s** (was 1448 s in E3): 1.91 / 0.91 / 0.00 / 0.00 / 3.01 / 0.19. Engine: init 0.36, grid+DEM 0.99, CPA 0.59, filters 0.17, veto 0.13, score 3.01, refine 0.18 |
| cat_lell_terrace upload | 2 one-click passes plus a run-up (excluded as `static`); coverage **poor**; *Search anyway* | 0 candidates ("No flight in the data passes within audible range of the region") | **no plausible match** | 1.3 s |
| Synthetic montage (scenario2 cut into C, A, B with level changes) | upload; montage on; **auto-detected cuts** 3:00 (weak) and 5:42.3; 3 one-click passes (clips 1, 2, 3) + measured ranges | **27.6 m**, Q3 + Q1 + Q2; per-clip T_start errors −0.33 / −0.22 / +0.43 s | **match** | 12.3 s |

* **Console: 0 errors and 0 warnings** in all E7 runs. Firefox's network messages for deliberately blocked tiles appear only in the E6 test.
* Node suite: **61 pass, 2 skipped, 0 fail** (63 tests).
* Screenshots: `docs/img/lane_e_e7_demo_match.png`, `lane_e_e7_colsto_match.png`, `lane_e_e7_terrace_nomatch.png`, `lane_e_e7_ground_ops.png`, `lane_e_e7_montage_marked.png`, `lane_e_e7_montage_result.png`.

## E8: security fixes (docs/SECURITY_REVIEW.md L1–L3)
* **L1: proxy URL is not taken from links or files without consent.**
  * `importProject` keeps the current proxy URL and ignores the file's. `exportProject` drops `run.settings.adsbWorker`; verified, the exported file contains no proxy.
  * A `?proxy=` link only shows a banner ("This link asks to use a different flight-data relay: <origin> … Only accept links from people you trust", with **Use this relay** and **Ignore**). Nothing is saved before *Use this relay*: the draft kept `''` and "Record now" stayed disabled.
  * Only the http(s) origin is used; invalid URLs are rejected.
* **L2: no HTML from flight data, and a narrower CSP.**
  * The map tooltip is a `<span>` with `textContent`.
  * In `web/_headers`, `script-src` and `style-src` are pinned to `https://unpkg.com/leaflet@1.9.4/dist/leaflet.js` and `/leaflet.css` (SRI stays in `index.html`); images remain host-wide for Leaflet's icons.
* **L3: live position is rounded before it is sent.** `pointUrl` rounds lat/lon to 0.05°, about 5 km (`roughDeg`), on the client. Local track selection still uses the precise centre. The live panel, the footer and the legal dialog now say "rounded to about 5 km (0.05°)".
* **Build:** `deploy/build.mjs` still excludes `web/dev/`, `web/tests/`, `*.md` and dotfiles. Re-checked: the rebuilt bundle has no `dev`/`tests` and carries the pinned CSP.
* **Tests:** new `web/tests/security_e8.test.mjs` covers L3 rounding and checks for L2's tooltip/CSP. The suite reports **63 pass, 2 skipped, 0 fail**.
* **Smoke test** (Firefox, `web/` served alone): the demo solved at 24.1 m, P1 + P2, verdict match. "Record now" is disabled with no proxy, still disabled while a `?proxy=` link waits for confirmation, enabled after *Use this relay*, and disabled again after clearing. 0 console errors. Screenshot: `docs/img/lane_e_e8_proxy_confirm.png`.

## E9: registration hints and chronological clips (Lane D §12)
* **Registration hint on each event card:** an optional field, "Aircraft registration (if known) · from the video description, e.g. N819MM". It is upper-cased, spaces are removed, and it is sent as `event.reg`, which limits that pass to tracks with that registration or callsign.
* **Montage panel:**
  * a plain warning: "Edited airport videos are hard. Next to a runway, every landing and take-off sounds almost the same … type each pass's registration";
  * a **"Clips are in chronological order"** checkbox, which sends `settings.config.montage_chrono`.
* **Results:** each clip shows the aircraft matched to it, as registration or callsign plus type, and when it was filmed. Example: "Clip 2 (3:00–5:42): HBABC (DR40) · filmed from 11:46:39".
* **Smoke test (Firefox):**
  * The demo solved at 24.1 m (match).
  * The synthetic scenario2 montage, with auto-detected cuts and registrations typed as HB-QQ / hbabc / HBXYZ, solved at **27.6 m**, Q3 + Q1 + Q2, verdict match, with the per-clip aircraft shown.
  * 0 console errors.
  * Screenshots: `docs/img/lane_e_e9_registration.png`, `lane_e_e9_montage_regs.png`.

## Interface contract summary (full text: `web/engine/geoloc-api.md`)
* `ENGINE_INFO {name, version, fake}`
* `fitEvent(points[[t,f]] /*fundamental*/, {c, cls}) → {t_cpa_audio /*= t_c + d/c*/, t_c, F0, v_mps:[a,b], cpa_m:[a,b], point:{v,d}, rms_hz, n, curve}`
* `fetchFlights({bbox, t0, t1, duration_s, padS}, {signal, onProgress}) → {tracks /*contract*/, source, attribution, counts, notes}`
* `runSearch({events[{t_cpa_audio,F0,v_mps,cpa_m,cls,ridge}], silences, region{shape,center,radius_m,bbox}, time{t0,t1}, duration_s, tracks, spec, settings{grid_m,c,topN,offsetTolS,refine}}, {signal, onProgress({stage, frac, survivors, total, message})}) → {candidates[contract + assignments, F0], field{bbox,nLat,nLon,values,min,max}, stats}`
  * The stage ids are fixed: `grid, cpa, filters, sim, score, refine`.
  * Abort must reject with an `AbortError`.
* `simulateCurves(candidate, {events, tracks, c, harmonics}) → [{event, flight, harmonic, points[[t,f]]}]`

**Engine switch:** `DEFAULT_ENGINE = 'real'` in `web/ui/engine.js` (since E3). `?engine=stub` selects the stub. If the real engine fails to load, the app falls back to the stub with a console warning.

## Known gaps / requests
1. **Stub engine.** Search candidates and the score field are fake. `fetchFlights` serves only the two fixtures (scenario1 and colsto 2026-09-08) and returns synthetic random tracks anywhere else. `fitEvent` and `simulateCurves` are real but simple (Nelder–Mead on eq. 3.2; flat-earth ENU).
2. **Basemap licensing.** The basemaps are Esri dark grey canvas (default), Esri imagery and OSM. CARTO now requires an API key. A paid SaaS must choose a tile provider with commercial terms; OSM's own tile servers and the free Esri basemaps are not meant for heavy commercial use.
3. **Region handles can only be dragged with a mouse or touch.** Keyboard users must use the lat/lon/size inputs.
4. **Large files.** Decoding still goes through `decodeAudioData`, so the whole file is decoded even when only a range is analysed (Lane C limitation 1). The warning and the crop limit the spectrogram's size, not the decode peak. Real chunked decoding needs WebCodecs with a demuxer. The memory estimate is deliberately pessimistic for mono or low-rate files.
5. **Auto-extension limits.** Extension needs a falling, mostly continuous line. Helicopters are tracked without the monotonic constraint, but jump-extension still assumes a falling slope. Very weak far-field plateaus are cut where the SNR gate stops. Alt+click remains available to add pieces by hand.
6. **Track cache scope.** The IndexedDB cache is per browser and per origin, and stores up to 6 fetches (the colsto window is about 3 MB as structured data). Nothing is cached when IndexedDB is unavailable, for example in private mode.
7. **Colsto event 2** (F0 136 Hz, v 88 m/s, d 1.9 km) still differs from Lane C's fit (139 Hz, 76 m/s, 1.37 km). Its curve is short and burst-ridden, and the straight-line fit is poorly constrained there.
8. Flight tracks are still left out of the project *file* because of its size. A reload in the same browser restores them from IndexedDB; opening the file on another machine needs a refetch, and the UI says so.
