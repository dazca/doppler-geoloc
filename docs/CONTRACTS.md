# Shared contracts (all lanes MUST follow; orchestrator owns this file)

Goal: browser SaaS that geolocates a user's video from aircraft Doppler sounds + historical ADS-B,
following the OSINT method of https://www.youtube.com/watch?v=UytYrhYLOKI (6 stages: spectrogram ->
ADS-B fetch/filter -> grid + DEM + delayed CPA -> speed/CPA/offset/silence filters -> physical Doppler
simulation -> pixel-brightness scoring + sweep + refinement).

## Layout
- docs/      MATH.md (theory), DATA.md (data sources), VIDEO_NOTES.md, STATUS.md (orchestrator), lane reports
- ref/       Python reference implementation (ground truth for validation). pytest tests in ref/tests
- fixtures/  shared test data (synthetic scenarios, generated audio, expected outputs) — JSON/WAV/NPY
- web/       browser app: plain ES modules, NO build step, deployable as static site (Cloudflare Pages).
             web/engine/*.js (pure functions, run in Node too for tests), web/workers/, web/ui/
- worker/    optional Cloudflare Worker proxy for CORS-blocked data sources

## Units & conventions
- Positions: WGS84 lat/lon degrees, altitude meters MSL. Compute in local ENU meters around a reference point.
- Time: Unix seconds UTC (float). Audio time: seconds from start of recording (float). t_unix = t_audio + T_start (unknown!).
- Speed of sound c: default 343 m/s (allow temperature param: c = 331.3*sqrt(1+T/273.15)).
- Doppler (exact, moving source, still air): f_obs(t_rx) = F0 * c / (c - v_s · u), u = unit vector source->observer
  at EMISSION time t_e, where t_rx = t_e + |r_obs - r_src(t_e)|/c. (First-order: F0*(1+v_r/c).)

## Formats
Flight track JSON:
  {"id": str, "icao24": str, "callsign": str|null, "type": str|null (ICAO designator, e.g. "C172"),
   "category": "prop"|"jet"|"heli"|"unknown",
   "points": [[t_unix, lat, lon, alt_m_msl], ...]}   (sorted by t)
Spectrogram (JS & Python): {t0, dt, f0, df, nT, nF, data: Float32Array row-major index [iT*nF + iF], unit "dB"}
Doppler event (user-measured, from spectrogram): {t_cpa_audio, F0, v_mps:[min,max], cpa_m:[min,max]}
Candidate result: {lat, lon, elev_m, score, flights:[ids], t_start_unix}

Optional reported velocity (D15, backward compatible): a flight track may carry `"vel": [[gs_mps, track_deg_true, vrate_mps], ...]`,
aligned 1:1 with `points` (null where a field is missing). Consumers that ignore unknown keys are unaffected; `points` keeps
exactly 4 elements per point. Written by `ref/data/fetch_adsb.py` and `web/engine/adsb.js` from the readsb trace (gs kt,
track deg, geometric rate else baro rate ft/min). The report lags the position by ~2.75 s (Lane F); the engine shifts it.
