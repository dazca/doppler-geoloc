# Orchestrator status board
Started 2026-11-03 21:45 local. Deadline: 2026-11-05 21:45 local (48 h). Heartbeat every ~30 min (cron :13/:43).

## Phase plan
1. Understand & prototype (parallel): A theory+Python ref+synthetic fixtures | B ADS-B/types/DEM data | C browser DSP (FFT/STFT/audio/ridge/viewer) | R video research
2. Validate each lane (orchestrator reruns tests) → fix loops
3. Port: D JS geoloc engine (grid, delayed CPA, filters, Doppler sim, scoring, sweep, refine) in web/engine + worker pool, cross-checked vs fixtures/golden
4. UI: E full app (upload → spectrogram → mark events → time/region → fetch ADS-B → run → map results (Leaflet) → verify/StreetView links)
5. E2E: Playwright on synthetic scenarios (+ one real case), fix loops
6. Iterate: accuracy (auto fit, harmonics, likelihood), speed (coarse-to-fine, pruning, WASM/SIMD, GPU), UX polish, docs
7. Deploy: ONLY after user confirmation (Cloudflare Pages + Worker proxy)

## Lanes
| Lane | Scope | Status |
|---|---|---|
| A | theory+Python ref | VALIDATED (23/23 pytest rerun by orch). Synthetic err 25 m / 16 m. Fails: 1 event, no v/d filter, t err ±10 s, wrong CPA range. A2 DONE+verified (overlay checked): REAL colsto SOLVED 40.8762,-73.5251 (2.2 km from rounded label, within rounding), T_start 2026-09-08 20:49:11Z (consistent w/ video's 8:37pm UTC clip). Flights: PC-12 CST1219 @6.1 km, King Air EGE93 @3.7 km. Keys: physical bounds only, ±15 s, rank by ridge misfit, reach >4 km for turboprops |
| B | data | VALIDATED (42/42+2skip; KSMO 25/25 tails verified by orch). adsb.lol globe_history (ODbL). Fast path: per-day 0.5° non-jet tiles via Worker (0.1-0.45 s, local wrangler dev). Generic: index+range proxy 1-100 s. OWNER DECISIONS: daily tile build job, R2 bucket, Worker deploy, pre-2023 data, tar1090-db licence |
| F | KSMO real physics | VALIDATED visually by orch: 8/21 shots fit 0.2-0.6 Hz rms on real data (physics OK). Combined spot ~350 m NE of KSMO ARP, ±250-700 m. ADS-B speed lag ~3 s. DONE: Rmin~100 m is real (observer 104 m off centreline, aircraft on rollout/short final). ADS-B time shift absorbed by free T_start -> default 0 s (matters only when T_start known, e.g. live mode). Minor: smoothing dips at air/ground switch |
| C | browser DSP | VALIDATED (14/14 tests rerun by orch; FFT 2e-13, STFT 7.6e-6 dB vs scipy; ridge median 0.37 Hz). C6 DONE+validated (22/22 web tests): hum/impulse suppression opt-in, colsto ridges.json, CPA gap 927 s (913-934 by method), 1h decode ok but 3.7 GB peak mem (TODO: chunked/WebCodecs) |
| E | UI (E4 DONE+validated: live 'Record now' (web/live), deploy/build.mjs -> clean 19 MB bundle, _headers CSP, legal footer, worker live routes + clock-skew fix. E5 DONE+validated: demo m4a 4.6 MB (bundle 5.3 MB, demo 37.6 m), plain-language copy, error states, hero landing. Earlier E3 DONE: real engine default; E2E Firefox scen1 37.6 m (ambiguous vs 8.2 km alias in robust), scen2 27.6 m, 0 console errors. colsto: 1448 s robust, 582k survivors -> SCALE BUG sent to D) | VALIDATED on stub (screens reviewed, 0 console errors, full flow demo+colsto). Switch: web/ui/engine.js or ?engine=real. E2 DONE+validated (37/37 pass, 2 skip): one-click ridge colsto 200.5-277 s, auto-zoom, IndexedDB, explainer. Issue: stub fit gives implausible v/d on partial curves -> sent to D |
| D | JS engine | VALIDATED (44/44; orch reran scenarios: 25.3/16.1 m; faithful 0.6 s, robust 9 s 1-thread / ~2.5 s browser 16 workers). Robust fixes ±10 s, wrong CPA. Issue: scen1 alias 8.1 km margin 0.012. D8 DONE+validated: colsto full box 25 s Node (was 1448 s), scen1 margin 0.012->0.082 (loudness weighting), T_start metadata prior. colsto result still 17 km off, margin 0 (awaiting A diagnosis). D9 DONE+validated: colsto cold Firefox 10.5-18.7 s, Chromium 8.3-10.8 s; perf budget test. D10 DONE+validated by orch: JS engine reproduces real colsto from one-click events: 40.87611,-73.52338 (142 m from A), PC-12+King Air, T_start 20:49:11.03Z, clear margin vs next alt; 60/58 pass+2 skip; 60 s on loaded machine (18 s cold browser per D) |
| K | Catalonia | DONE: 3 blind cases, 0 located. ROOT CAUSE verified by orch: adsb.lol has ZERO low non-jet tracks within 5 km of LELL on those dates (vs 47 on 2026-11-01). Engine still returned confident wrong answers (Salou 12-15 km 'not ambiguous') -> need absolute null test + coverage warning + montage support + DEM retry. Most Catalan videos are montages/ground ops |
| B2 | fetch fixes + coverage check + DEM retry | DONE+validated (8 py + 10 node tests). LELL 2026-11-01 ok / 2023-12-17 poor / 2026-06-11 poor |
| L | live mode | DONE+validated (5/5 live unit tests, suite 49/49+2skip). FEASIBLE via adsb.lol trace_full/trace_recent (past ~24 h, ~3 s sampling) + small CORS Worker (not deployed). 1 event + known T_start: 5 m on real tracks + synthetic pass. OWNER: email adsb.lol for production OK |
| R | docs/VIDEO_NOTES.md | DONE (video facts + 4 related repos; findings sent to A,B,V) |
| V | real test videos | DONE: 4 cases; colsto_longisland verified by orchestrator (2 prop curves t~215s & ~1135s, 920s apart). Year 2025/2026 ambiguous, time unknown |

## Log
- 21:45 Phase 1 launched (A,B,C,R).
- 21:55 User: use FlightRadarScraper (or better) for small region+day, dev-only. Forwarded to B. Lane V launched (real videos w/ known location+date).
- 22:05 R done. Key: 200m/10km grid -> 100m, offset 920±5s, F0~130Hz, ~100m accuracy (Long Island). Prior clone hermes-aircraft-doppler reports most real clips FAIL -> robustness is the differentiator.
- 22:20 V done. Asked B to fetch tracks for colsto (Sept 8 2026, then 2025) + ksmo.
- 22:30 C validated. C6 (hum/impulse suppression, real ridges, 1h decode) dispatched.
- 22:20 heartbeat: A in progress (ref pkg, scenarios, golden, robustness exist; no report yet). B in progress: real colsto tracks fetched via adsb.lol globe_history: 4952 tracks (983 prop, 206 heli), median dt 2 s, geom alt 99%, 615 s fetch. C6 running.
- 22:45 C6 validated. E (UI shell) launched early, on stub engine. NOTE: measured offset is 913-934 s depending on CPA definition -> time-offset tolerance must be ~±10 s, or use curve-fit t_cpa.
- 22:50 USAGE LIMIT reached. Stopped A (ref pkg+scenarios+golden+MATH.md written, report pending; rerun pytest ref/tests to validate), B (DATA.md, fetch_adsb.py, colsto tracks_2026 done; ksmo/types/dem/worker status unverified), E (UI shell just started). Heartbeat cron deleted. RESUME: validate A -> launch D (JS engine vs fixtures/golden) -> finish E -> E2E on scenario1 + colsto.
- 06:15 Resumed after pause. A validated. D launched. A2 (real colsto), B, E resumed. Cron be7db4d6.
- 06:24 heartbeat: A2,B,D,E all active (D has geoloc/*.js + tests in progress; E has ui/*.js). Nothing to validate yet.
- 06:45 E validated; E2 dispatched. E owns spectrogram-view.js from now (C done).
- 07:05 E2 validated. Real-data finding: straight-line fit on partial ridge is ill-conditioned -> soft priors mandatory (sent to D).
- 07:20 B validated. F launched (KSMO per-clip physics validation).
- 06:54 heartbeat: A2 interim colsto map: 17652 survivors but HOLE at video answer -> sent diagnosis hints (2025 tracks, drop v/d gates, ±15 s, jets). D has geoloc.js. F segmenting KSMO.
- 07:30 D validated. Phase 3->4: E3 integration+E2E, D8 speed+alias.
- 07:45 User: add Catalonia lane -> K (blind cat cases) + L (live mode feasibility).
- 07:55-11:10 ALL lanes stopped by 5h rate limit. 11:12 resumed A2,E3,D8,K (tests green: 44 web, 23 py). F and L queued (resume when one of the 4 finishes) to avoid burning the limit.
- 11:40 E3 validated (screenshots). CRITICAL: real-scale perf (filters O(F^2 N)) -> D top priority. F resumed. L still queued.
- 11:55 F validated (overlays). L resumed.
- 11:24 heartbeat: A2,D8 (new cpa_sparse.js = scale fix in progress),K,F,L active. K has no cat_ fixtures yet.
- 12:05 F done.
- 12:20 L validated.
- 12:45 heartbeat: A2,D8,K running. E4 dispatched (live mode in app + deploy-ready bundle, no deploy).
- 13:05 D8 validated. D9 dispatched.
- 13:30 E4 validated. E5 dispatched.
- 13:55 A2 SOLVED real colsto (verified). D9 validated. D10 dispatched.
- 14:10 K done (negative, honest). B2 dispatched. Queue for D after D10: absolute null test/calibrated confidence, montage (per-clip T_start), coverage-aware warning, flyover vs ground-op filter.
- 12:24 heartbeat: D10, E5, B2 running; nothing new to validate.
- 14:30 E5 validated. perf test 2 budget fails = D10 in-progress widened reach (1.89M pairs > 1.5M); D10 to update budgets.
- 14:45 B2 validated. E6 dispatched (coverage warning UI).
- 15:00 D10 validated. USAGE LIMIT: E6 (coverage warning UI) stopped mid-way -> resume E agent. NEXT: E6 finish; D11 absolute null test/calibrated confidence + montage per-clip T_start + ground-op filter; rerun Catalonia/KSMO through final engine; final E2E Playwright.
- 16:12 Resumed after limit: E6 resumed, D11 dispatched (null test, montages, ground-op filter). Tests 58/60+2skip.
- 16:14 E6 validated (coverage poor/ok + partial-day + flat-terrain fallback; screenshot checked). D11 running.
- 16:24 heartbeat: D11 running; nothing to validate.
- 16:28 D11 validated (61/63+2skip; scenarios 25.3/16.1 m; Salou blind S0 weak (ratio 0.20 vs 0.15: borderline), S1/S2 no plausible match). Montage validated synthetic only (30 m). E7 dispatched: verdict/montage/ground-ops UI + final E2E (demo, colsto, terrace).
- 16:38 E7 validated: FULL E2E OK (demo match 24 m; colsto real in UI 40.87616,-73.52391 match 6.8 s; terrace no plausible match). D12 (KSMO real montage blind) + S (security review) dispatched.
- 16:43 S done: 0 critical/high; privacy claim verified by orch (no fetch carries media; innerHTML only in web/dev, excluded from bundle). M1 worker abuse -> B3; L1-L3 -> E8. D12 running.
- 16:49 E8 validated (security L1-L3).
- 16:50 B3 validated (7 worker tests; cache key, rate limits, CORS allow-list). NOTE: default origin assumes Pages project 'overhead'.
- 16:54 heartbeat: D12 running (KSMO montage blind).
- 17:21 D12 validated (64/66+2skip; no regression: scen 25.3/16.1 m, colsto same answer). KSMO montage blind: position 197 m OK, aircraft 0/19 (runway passes alike); with tail hints 16/19. E9 (reg hint UI) + V2 (more continuous real cases) dispatched.
- 17:24 E9 validated (reg hint UI, montage chrono checkbox).
- 17:24 heartbeat: V2 running.
- 17:54 heartbeat: V2 running.
- 21:11 V2 done: 5 real continuous blind cases, 0 located but 0 confident-wrong (safe failures). Cause: all-events-must-match; some flyovers have no ADS-B (orch verified Egelsbach coverage itself is good: 41 nonjet <3km). Oracle 733 m. D13 (outlier events, single-event cap) + B4 (coverage per-hour) dispatched. ~24 h to deadline.
- 21:14 B4 validated (per-hour coverage thresholds).
- 21:24 heartbeat: D13 running.
- 21:44 D13 validated (65/67+2skip; colsto same). V2 now all safe (single events capped weak; unexplained events). D14 (track gaps) + W (README, ACCURACY, LAUNCH_CHECKLIST) dispatched.
- 21:46 W validated: README run URL + demo asset serve 200 (orch checked), wrangler hint matches worker/README. Docs: README.md, docs/ACCURACY.md, docs/LAUNCH_CHECKLIST.md.
- 21:54 heartbeat: D14 running.
- 22:04 D14 validated+kept (gap interp; Egelsbach oracle 733->190 m weak; Teuge blind 1.2 km->90 m but truth ±700 m and T_start 376 s off -> likely same-runway alias, weak evidence; scen2 gap90 regressed to 3.7 km 'weak'). D15 dispatched (reported velocity in gaps). User asked if real new videos worked: answered honestly NO (0 blind real locates; colsto not blind).
- 22:15 D15 validated (reported velocity in gaps; synthetic gap trade-off fixed: scen2 gap90 3.7 km->293 m; real cases unchanged because key aircraft are MLAT-only w/o velocity). Teuge: true pass matched to wrong event -> no match is correct.
- 22:23 User: find a ~30 min Catalan video now. K2 dispatched (recent VODs, coverage-check first, blind).
- 22:24 heartbeat: K2 running.
- 22:42 K2 done: no suitable recent continuous Catalan recording found (AnnaMi channel only 2026-06-11/01-13; El Prat VOD poor coverage, commentary, no flyovers). Round-1 reruns: Patrona/Terrace no match (correct), Salou weak 15 km (too generous). Recommendation: own recording under LELL circuit.
- 02:11 Resumed after limit. D16 dispatched (montage verdict consistency: Salou weak->should be no match). Engine otherwise at diminishing returns; blocked on real ground-truth recording from owner.
- 02:21 D16 validated (Salou montage -> no plausible match; colsto unchanged).
- 02:24 heartbeat: idle, no lanes running; awaiting owner recording.
- 02:54 heartbeat: idle.
- 07:11 heartbeat: idle, awaiting owner recording.
- 07:24 heartbeat: idle.

## FINAL (written 2026-11-06, deadline 2026-11-05 21:45 passed; heartbeat cron deleted)
- Built: browser SaaS (web/) = audio decode + STFT + one-click ridge tracking + JS geoloc engine (worker pool) + Leaflet UI + live mode + verdicts + montage + coverage warnings; Worker proxy (worker/, hardened); deploy bundle (deploy/, NOT deployed); Python reference (ref/); docs (README, ACCURACY, LAUNCH_CHECKLIST, MATH, lane reports, SECURITY_REVIEW).
- Tests at close: web 65 pass / 0 fail / 2 skip; pytest 29 pass.
- Results: synthetic 25/16 m. Real: colsto (video's own example, NOT blind) solved 40.876,-73.523 + right aircraft + T_start; physics matches real KSMO clips 0.2-0.6 Hz. Blind new real recordings: 0 of 9 located (Catalonia 3, V2 5, KSMO montage aircraft-ID fail), all now end in honest 'no plausible match'/'weak'.
- Blocker: a ground-truth continuous recording (owner to record ~30-60 min near LELL circuit). Launch decisions: docs/LAUNCH_CHECKLIST.md.
