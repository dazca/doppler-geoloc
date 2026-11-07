# Overhead (working name)

Geolocate a video from the Doppler sound of passing aircraft. The app extracts the engine-tone sweeps from the
audio, then matches them against historical (or just-recorded) ADS-B flight tracks to find where the recorder stood
and when it was recorded. Everything about the media runs in the browser: audio and video never leave the device
(verified in docs/SECURITY_REVIEW.md).

**Status:** working prototype, deploy-ready but NOT deployed. Read [docs/ACCURACY.md](docs/ACCURACY.md) before
promising anything to users: it works on clean, continuous recordings with transponder-equipped aircraft, and it
fails safely (reports "no plausible match") on many real videos.

## Architecture

```
 browser (static web app, web/)                    Cloudflare Worker (worker/)           adsb.lol
 upload / "Record now"                             CORS + cache + rate-limit relay
  -> STFT, ridge tracking (DSP workers)  --fetch-> /adsb/tile|index|range  ----------->  globe_history (ODbL)
  -> user marks events, region, date               /v2/point, /data/traces (live)  ---->  live API
  -> JS search engine (worker pool):                R2 bucket: per-day 0.5 deg
     grid x delayed-CPA x Doppler sim x scoring     non-jet track tiles (built offline)
  -> Leaflet map, verdict, Street View links
```

* **Static web app** (`web/`): DSP, engine, UI. No backend for media.
* **Worker** (`worker/`): thin CORS/cache relay so the browser can read adsb.lol; allow-listed origins and rate limits.
* **ADS-B data**: adsb.lol daily history, pre-sliced into tiles in R2 by an offline job (`ref/data/`); live mode uses
  adsb.lol trace files.
* **Python reference** (`ref/`): the original physics/search implementation and golden fixtures the JS engine is
  checked against.

## Repository layout

| path | contents |
|---|---|
| `web/index.html`, `web/ui/` | app shell and UI (`ui/app.js`, map, spectrogram view, live panel) |
| `web/engine/` | FFT/STFT, ridge tracking, DEM, ADS-B parsing, `geoloc/` search engine (API: `engine/geoloc-api.md`) |
| `web/workers/` | DSP worker and geolocation worker pool |
| `web/live/` | "Record now" mode: recorder, server clock, backfill, geoid |
| `web/demo/`, `web/data/` | bundled demo clip and aircraft-type table |
| `web/tests/` | Node tests and runner scripts (`*.test.mjs` are the suite) |
| `web/dev/` | dev-only pages (excluded from the bundle) |
| `worker/` | Cloudflare Worker source, `wrangler.toml`, tests, README |
| `deploy/` | `build.mjs` (bundle builder) and the deploy guide |
| `ref/` | Python reference (`doppler_ref/`), ADS-B/DEM data tools (`data/`), validation scripts, pytest suite |
| `fixtures/` | synthetic scenarios, golden outputs, real test cases (`real/`, untrusted downloads, not for redistribution) |
| `docs/` | reports and guides (below) |

## Run locally

```bash
python -m http.server 8000          # from the project root
# open http://localhost:8000/web/    -> "Try the demo"
```
Historical ADS-B fetches need a Worker. Run `npx wrangler dev` in `worker/` and pass its URL as the proxy (see
`worker/README.md`), or use the bundled demo/fixtures, which need no network.

Tests:
```bash
node --test web/tests/*.test.mjs    # JS: DSP, engine, adsb, live, security (65 pass, 2 skip at last STATUS entry)
python -m pytest ref/tests          # Python reference (23 tests at validation)
node --test worker/test/worker.test.mjs
```
Build the deployable bundle (does not deploy): `node deploy/build.mjs https://data.<your-domain>`.

## Documentation

* [docs/ACCURACY.md](docs/ACCURACY.md): what works, what does not, evidence
* [docs/LAUNCH_CHECKLIST.md](docs/LAUNCH_CHECKLIST.md): owner decisions before launch
* [deploy/README.md](deploy/README.md): Pages + Worker + R2 deployment
* [docs/STATUS.md](docs/STATUS.md): orchestrator board and log
* [docs/MATH.md](docs/MATH.md): physics (retarded time, Doppler, scoring)
* [docs/DATA.md](docs/DATA.md): data sources, licences, tile pipeline
* [docs/CONTRACTS.md](docs/CONTRACTS.md): data formats between modules
* [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md): security review
* [docs/VIDEO_NOTES.md](docs/VIDEO_NOTES.md), [docs/REAL_CASES.md](docs/REAL_CASES.md): the method's origin and real test material
* Lane reports: [A](docs/LANE_A_REPORT.md) theory/reference, [C](docs/LANE_C_REPORT.md) DSP, [D](docs/LANE_D_REPORT.md) engine,
  [E](docs/LANE_E_REPORT.md) UI, [F](docs/LANE_F_REPORT.md) KSMO, [K](docs/LANE_K_REPORT.md) Catalonia,
  [L](docs/LANE_L_REPORT.md) live mode, [V2](docs/LANE_V2_REPORT.md) more real cases
