# Launch checklist (owner decisions and steps)

Deployed so far (2026-11-07): the data backend only (rows 3-4). Pages is not deployed. Do the rest before a public launch. Deployment commands are in [deploy/README.md](../deploy/README.md).

| # | Decision / step | Why | Where in the repo |
|---|---|---|---|
| 1 | **Email adsb.lol for production OK** (offer attribution, caching, a feeder; ask about API keys) | The data is free (ODbL), but they ask production users to get in touch, and the app depends on this one provider. adsb.fi, airplanes.live and OpenSky are non-commercial. Polling every 2 s drew 429 on 66% of requests | deploy/README.md §0; docs/LANE_L_REPORT.md §4; docs/DATA.md §1, §8 |
| 2 | **Pick a commercial map-tile provider** and replace Esri/OSM | The defaults are fine for testing, not for a paid SaaS | URLs in `web/ui/map-panel.js`; `img-src` in `web/_headers`; deploy/README.md §0 |
| 3 | **DONE (backfill) / scheduling OPEN: daily data job + R2 bucket** (`doppler-adsb-index`). Bucket created 2026-11-07 and filled for Catalonia + Andorra (42 cells, lat 40-43, lon 0-3.5) for the last ~30 UTC days: tiles, index shards, `day.json`. `ref/data/daily_job.py` builds + uploads yesterday and any missing day (idempotent catch-up). **Owner: choose a schedule** (Task Scheduler or GitHub Actions, deploy/README.md §1b); without it, new days stop appearing | Days that are not built return 404 from `/adsb/tile/...` / `/adsb/index/...` and the app reports them as unavailable. Each day streams ~4-5 GB once | deploy/README.md §1, §1b; `ref/data/daily_job.py`; `deploy/github-daily.yml.example`; docs/DATA.md §3, §8 |
| 4 | **DONE: Worker on a custom domain** `https://doppler-data.azemar.eu` (`doppler-geoloc-data`, `workers_dev = false`), `ALLOWED_ORIGINS` = `https://doppler.azemar.eu` + localhost, ratelimit `namespace_id`s 91301-91304. Verified: /health, CORS allowed vs other origins, edge cache HIT | On `*.workers.dev` the Cache API does nothing (M1). If Pages ends up on another origin, add it to `ALLOWED_ORIGINS` | `worker/wrangler.toml`; deploy/README.md §2; docs/SECURITY_REVIEW.md M1 |
| 5 | Build the bundle against the Worker origin, deploy Pages, run the post-deploy checklist | The Worker origin goes into `config.js` and the CSP `connect-src` | `deploy/build.mjs`; deploy/README.md §3, §4 |
| 6 | **tar1090-db licence check** | `web/data/types.json` comes from tar1090-db, which has no LICENSE file. Its data derives from the Mictronics aircraft database | docs/DATA.md §5 (Licence line) |
| 7 | **Decide on pre-2023 data** (paid source or unsupported) | There is no free source (e.g. the 2022 LFMD case). Options: ADSBx paid backfill, FlightAware AeroAPI, OpenSky research (non-commercial) | docs/DATA.md §8 item 3; docs/REAL_CASES.md |
| 8 | **Real outdoor live-mode test** on a phone and a laptop | Only synthetic passes and a fake mic have been tested; there is no real Doppler recording from live mode | docs/LANE_L_REPORT.md §3 "Not done" |
| 9 | **Safari test** (desktop and iOS) | Untested: AudioWorklet `getOutputTimestamp` fallback, no `credentialless` support. The demo audio is AAC for Safari | docs/LANE_L_REPORT.md §3; docs/LANE_E_REPORT.md (COOP/COEP note); deploy/README.md |
| 10 | **Legal: terms of service and privacy page** | The app has a footer and a "Data, privacy & licences" dialog (ODbL, attributions, disclaimer), but no formal ToS or privacy policy. Live mode sends rough location (~11 m) to the Worker; disclose it | `web/index.html` footer/dialog; docs/SECURITY_REVIEW.md L3; docs/DATA.md §8 |
| 11 | Set expectations in the product copy | Most real videos failed in testing | docs/ACCURACY.md |
| 12 | Optional: partial-event matching and a stricter coverage verdict | Highest-value accuracy fix found in V2 | docs/LANE_V2_REPORT.md §5 |

Rollback: see deploy/README.md (promote a previous Pages deployment; `npx wrangler rollback` for the Worker).
