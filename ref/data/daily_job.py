"""Daily data job for the deployed backend (Catalonia + Andorra): build + upload every missing recent UTC day.

Idempotent and catch-up by design: for each day in the last --days UTC days (default 30, ending yesterday), newest
first, it asks the live Worker whether <prod tag>/day.json AND <mlatonly tag>/day.json exist. Days that have both are
skipped. Any other day is built and uploaded:
  1. stream the adsb.lol prod and mlatonly tars ONCE each (~3-5 GB in total; nothing is written to disk but the index),
     keeping only the region's tracks (non-jets whole; jets only as low baro+geom points for the baro calibration),
  2. tiles/<date>/<cell>.json.gz for every 0.5 deg region cell (non-jet tracks, contract format, same schema as
     build_tiles.py)  -> fast path + coverage baseline in web/engine/adsb.js,
  3. <tag>/<cell>.json index shards for the region cells + <tag>/day.json (build_index.py) -> generic search path
     (fetchTracks: shards + /adsb/range) and the archive completeness check (fetchDayStatus),
  4. upload to R2 with `wrangler r2 object put` (tiles, then shards, then day.json last = "day done" marker),
  5. delete the day's local files and the big day index (unless --keep-index); <tag>.counts.json is kept as the
     partial-day reference,
  6. add the day to the availability manifest meta/coverage.json in R2 ({updated, bbox, days[], from, to}; served by
     the Worker at /adsb/index/meta/coverage.json with a 60 s cache; the app's date gate reads it).
A day whose prod release is not published yet is skipped (retried next run). A missing mlatonly release is accepted
(published as status "missing") only once the day is > 2 days old.

  python ref/data/daily_job.py                    # normal daily run (catch-up of the last 30 days)
  python ref/data/daily_job.py --date 2026-11-06  # one explicit day (rebuilds it even if present with --force)
  python ref/data/daily_job.py --no-upload --keep-files --date 2026-11-06   # local build only
  python ref/data/daily_job.py --rebuild-manifest # rewrite the manifest from the days whose 2 day.json are served
Needs: Python 3.10+ with numpy, requests, pyproj; Node + wrangler logged in (or CLOUDFLARE_API_TOKEN with R2 edit +
CLOUDFLARE_ACCOUNT_ID in the environment).
"""
import argparse
import datetime as dt
import gzip
import json
import os
import random
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_adsb as fa  # noqa: E402
import build_index  # noqa: E402

# Catalonia + Andorra (lat 40.45-42.95, lon 0.10-3.40), rounded out to whole 0.5 deg cells: 6 x 7 = 42 cells.
REGION = (40.0, 0.0, 43.0, 3.5)
REGION_BBOX = (REGION[0], REGION[1], REGION[2] - 1e-9, REGION[3] - 1e-9)
REGION_CELLS = fa.cells_for_bbox(*REGION_BBOX)
REGION_SET = set(REGION_CELLS)
BBOX_ARG = ",".join(str(x) for x in REGION_BBOX)
FEEDS = ("prod", "mlatonly")
BUCKET = "doppler-adsb-index"
WORKER = "https://doppler-data.azemar.eu"
MANIFEST_KEY = "meta/coverage.json"
COVERAGE_BBOX = [40.45, 0.10, 42.95, 3.40]  # advertised area (Catalonia + Andorra), same as web/config.js
MANIFEST_SINCE = "2025-10-01"  # earliest day --rebuild-manifest probes
WORK = os.path.join(fa.ROOT, ".cache", "daily")

_TYPES = None


def region_batch(batch):
    """Pool worker (replaces fetch_adsb._process_batch): full footprint for the index, region legs only.
    Jets keep only points usable for the baro calibration (geom + baro < 10,000 ft) to bound memory."""
    global _TYPES
    if _TYPES is None:
        _TYPES = fa.load_types()
    W = fa._W
    out = []
    for off, data in batch:
        try:
            d = json.loads(gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data)
        except (ValueError, OSError, MemoryError):
            out.append((off, len(data), None, None, None))
            continue
        fp = fa.footprint(d)
        legs = None
        if any(c in REGION_SET for c in fp):
            legs = fa.extract(d, W["bbox"], W["t0"], W["t1"], False)
            if legs and (_TYPES.get(d.get("t")) or ["unknown"])[0] == "jet":
                legs = [[q for q in leg if q["geom"] is not None and q["baro"] is not None
                         and q["baro"] < fa.CAL_MAX_BARO_FT] for leg in legs]
                legs = [leg for leg in legs if leg] or None
        out.append((off, len(data), fa.light_of(d), fp, legs))
    return out


def split_by_cell(found):
    """[(light, legs)] over the region -> {cell: [(light, legs clipped to that cell)]} (a cell exit ends a leg)."""
    per = {}
    for light, legs in found:
        mine = {}
        for leg in legs:
            run, rc = [], None
            for q in leg:
                c = fa.cell_id(q["lat"], q["lon"])
                if run and c != rc:
                    mine.setdefault(rc, []).append(run)
                    run = []
                rc = c
                run.append(q)
            if run:
                mine.setdefault(rc, []).append(run)
        for c, ls in mine.items():
            per.setdefault(c, []).append((light, ls))
    return per


def worker_has(worker, key):
    try:
        return requests.get(f"{worker}/adsb/index/{key}", timeout=30).status_code == 200
    except requests.RequestException:
        return False


def day_done(worker, day):
    return all(worker_has(worker, f"{fa.tag_for(day, f)}/day.json") for f in FEEDS)


def r2_put(bucket, key, path):
    cmd = [_npx(), "wrangler", "r2", "object", "put", f"{bucket}/{key}", "--file", path, "--remote",
           "--content-type", "application/json" if key.endswith(".json") else "application/octet-stream"]
    for attempt in range(9):  # Cloudflare API rate limit (1200 req / 5 min): back off up to ~5 min in total
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=fa.ROOT)
        if r.returncode == 0:
            return
        time.sleep(min(60, 3 * 2 ** attempt) * (0.5 + random.random()))
    raise RuntimeError(f"upload {key} failed: {(r.stderr or r.stdout)[-400:]}")


def _npx():
    return shutil.which("npx") or shutil.which("npx.cmd") or "npx"


def r2_get_json(bucket, key):
    """Object straight from R2 (not via the cached Worker): parsed JSON, or None if the key does not exist."""
    cmd = [_npx(), "wrangler", "r2", "object", "get", f"{bucket}/{key}", "--remote", "--pipe"]
    for attempt in range(4):
        r = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace", cwd=fa.ROOT)
        if r.returncode == 0:
            return json.loads(r.stdout)
        if "does not exist" in (r.stderr + r.stdout):
            return None
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"get {key} failed: {(r.stderr or r.stdout)[-400:]}")


def write_manifest(bucket, days, log):
    days = sorted(set(days))
    doc = {"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "bbox": COVERAGE_BBOX,
           "days": days, "from": days[0] if days else None, "to": days[-1] if days else None}
    os.makedirs(WORK, exist_ok=True)
    p = os.path.join(WORK, f"coverage.{os.getpid()}.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    try:
        r2_put(bucket, MANIFEST_KEY, p)
    finally:
        os.remove(p)
    log(f"manifest: {len(days)} day(s), {doc['from']} .. {doc['to']}")
    return doc


def manifest_add(bucket, day, log):
    """Read-modify-write of the manifest after a day is fully uploaded. A rare concurrent writer can drop a day; the
    --rebuild-manifest at the end of each GitHub run repairs that."""
    cur = r2_get_json(bucket, MANIFEST_KEY) or {}
    return write_manifest(bucket, list(cur.get("days") or []) + [str(day)], log)


def probe(worker, key, tries=8):
    """True/False = the Worker serves/does not serve <key>; raises if it cannot tell (never guesses 'missing')."""
    for attempt in range(tries):
        try:
            r = requests.get(f"{worker}/adsb/index/{key}", timeout=30)
            if r.status_code in (200, 404):
                return r.status_code == 200
            wait = float(r.headers.get("Retry-After") or 5) if r.status_code == 429 else 3 * (attempt + 1)
        except requests.RequestException:
            wait = 3 * (attempt + 1)
        time.sleep(min(wait, 60))
    raise RuntimeError(f"cannot probe {key}")


def rebuild_manifest(worker, bucket, since, until, log, par=8):
    """Manifest = every day in [since, until] whose prod AND mlatonly day.json are served (prod probed first)."""
    t = time.time()
    days = [since + dt.timedelta(days=k) for k in range((until - since).days + 1)]
    with ThreadPoolExecutor(par) as ex:
        prod = [d for d, ok in zip(days, ex.map(lambda d: probe(worker, f"{fa.tag_for(d, 'prod')}/day.json"), days)) if ok]
        both = [d for d, ok in zip(prod, ex.map(lambda d: probe(worker, f"{fa.tag_for(d, 'mlatonly')}/day.json"), prod)) if ok]
    log(f"probed {len(days) + len(prod)} day.json in {time.time()-t:.0f}s")
    return write_manifest(bucket, [str(d) for d in both], log)


def upload(bucket, items, log, par=8):
    t = time.time()
    with ThreadPoolExecutor(par) as ex:
        list(ex.map(lambda kp: r2_put(bucket, *kp), items))
    log(f"  uploaded {len(items)} objects ({sum(os.path.getsize(p) for _, p in items)/1e6:.1f} MB) "
        f"in {time.time()-t:.0f}s")


def build_day(day, a, log):
    """Stream + build one day into <WORK>/<date>/. Returns (uploads list, stats) or None if not ready yet."""
    s = requests.Session()
    s.headers.update(fa.UA)
    today = dt.datetime.now(dt.timezone.utc).date()
    out = os.path.join(a.work, str(day))
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    d0 = dt.datetime(day.year, day.month, day.day, tzinfo=dt.timezone.utc).timestamp()
    # check both releases exist before downloading anything
    present = {}
    for feed in FEEDS:
        try:
            fa.part_urls(day, feed, s)
            present[feed] = True
        except fa.MissingRelease as e:
            if feed == "prod" or day >= today - dt.timedelta(days=2):
                log(f"{day}: {fa.tag_for(day, feed)} not published yet ({e}); will retry next run")
                return None
            present[feed] = False
            with open(os.path.join(a.cache, f"{fa.tag_for(day, feed)}.missing"), "w", encoding="utf-8") as f:
                f.write(str(e))
    stats = {"day": str(day), "gb": 0.0}
    found = {}
    for feed in FEEDS:
        if not present[feed]:
            found[feed] = []
            continue
        t = time.time()
        found[feed] = fa.stream_day(s, day, feed, REGION_BBOX, d0, d0 + 86400 - 1e-3, a.cache, log, False,
                                    workers=a.workers, process=region_batch)
        n, size = fa.index_counts(os.path.join(a.cache, f"{fa.tag_for(day, feed)}.idx.json.gz"))
        stats[f"{feed}_s"] = round(time.time() - t)
        stats[f"{feed}_traces"] = n
        stats["gb"] += round((size or 0) / 1e9, 2)
    # tiles
    t = time.time()
    types, geoid = fa.load_types(), fa.Geoid()
    per = {f: split_by_cell(found[f]) for f in FEEDS}
    del found
    uploads, ntr, tile_bytes = [], 0, 0
    os.makedirs(os.path.join(out, "tiles"))
    for c in REGION_CELLS:
        merged = fa.merge_feeds([per[f].get(c, []) for f in FEEDS])
        tracks, _ = fa.to_contract(merged, types, geoid, None) if merged else ([], None)
        tracks = [tr for tr in tracks if tr["category"] != "jet"]
        for tr in tracks:
            tr.pop("sources", None)
        p = os.path.join(out, "tiles", f"{c}.json.gz")
        with gzip.open(p, "wt", encoding="utf-8", compresslevel=9) as f:
            json.dump({"date": str(day), "cell": c, "cell_deg": fa.CELL, "source": "adsb.lol globe_history (ODbL 1.0)",
                       "tracks": tracks}, f, separators=(",", ":"))
        ntr += len(tracks)
        tile_bytes += os.path.getsize(p)
        uploads.append((f"tiles/{day}/{c}.json.gz", p))
    stats.update(tiles=len(REGION_CELLS), tile_tracks=ntr, tiles_mb=round(tile_bytes / 1e6, 2),
                 tiles_s=round(time.time() - t))
    # shards + day.json
    shard_dir = os.path.join(out, "shards")
    day_jsons = []
    for feed in FEEDS:
        tag = fa.tag_for(day, feed)
        src = os.path.join(a.cache, f"{tag}.idx.json.gz" if present[feed] else f"{tag}.missing")
        build_index.main([src, "--out", shard_dir, "--bbox", BBOX_ARG, "--cache", a.cache])
        for fn in sorted(os.listdir(os.path.join(shard_dir, tag))):
            (day_jsons if fn == "day.json" else uploads).append((f"{tag}/{fn}", os.path.join(shard_dir, tag, fn)))
        with open(os.path.join(shard_dir, tag, "day.json"), encoding="utf-8") as f:
            stats[f"{feed}_status"] = json.load(f)["status"]
    return uploads + day_jsons, stats  # day.json last


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--days", type=int, default=30, help="catch-up window: the last N UTC days ending yesterday")
    ap.add_argument("--date", action="append", help="explicit UTC day YYYY-MM-DD (repeatable; replaces --days)")
    ap.add_argument("--force", action="store_true", help="rebuild even if the Worker already serves the day")
    ap.add_argument("--max-days", type=int, default=0, help="stop after building this many days (0 = no limit)")
    ap.add_argument("--worker", default=WORKER, help="Worker origin used for the 'already done' check")
    ap.add_argument("--bucket", default=BUCKET)
    ap.add_argument("--cache", default=fa.DEFAULT_CACHE)
    ap.add_argument("--work", default=WORK)
    ap.add_argument("--workers", type=int, default=None, help="parse processes (default: by CPU and free RAM)")
    ap.add_argument("--no-upload", action="store_true")
    ap.add_argument("--keep-files", action="store_true", help="keep the day's tiles/shards in --work")
    ap.add_argument("--keep-index", action="store_true", help="keep the ~30 MB day index in --cache")
    ap.add_argument("--rebuild-manifest", action="store_true",
                    help=f"only rewrite {MANIFEST_KEY} from the days the Worker serves (since --since), then exit")
    ap.add_argument("--since", default=MANIFEST_SINCE, help="first day probed by --rebuild-manifest")
    a = ap.parse_args(argv)
    os.environ.setdefault("CLOUDFLARE_ACCOUNT_ID", "a1cd2a86a35ae7d3f0d9ec23c95ac31e")
    log = lambda *x: print(*x, flush=True)  # noqa: E731
    today = dt.datetime.now(dt.timezone.utc).date()
    if a.rebuild_manifest:
        doc = rebuild_manifest(a.worker, a.bucket, dt.date.fromisoformat(a.since), today - dt.timedelta(days=1), log)
        have, gaps = set(doc["days"]), []
        if have:
            d0, d1 = dt.date.fromisoformat(doc["from"]), dt.date.fromisoformat(doc["to"])
            gaps = [str(d0 + dt.timedelta(days=k)) for k in range((d1 - d0).days + 1)
                    if str(d0 + dt.timedelta(days=k)) not in have]
        log("gaps: " + (", ".join(gaps) if gaps else "none"))
        return 0
    days = ([dt.date.fromisoformat(x) for x in a.date] if a.date
            else [today - dt.timedelta(days=k) for k in range(1, a.days + 1)])
    built, failed = 0, []
    for day in days:
        if not a.force and day_done(a.worker, day):
            log(f"{day}: already served, skip")
            continue
        if a.max_days and built >= a.max_days:
            log(f"{day}: --max-days reached, leaving it for the next run")
            continue
        t = time.time()
        try:
            r = build_day(day, a, log)
            if r is None:
                continue
            items, stats = r
            if not a.no_upload:
                upload(a.bucket, items, log)
                try:
                    manifest_add(a.bucket, day, log)
                except Exception as e:  # the day itself is uploaded; the next --rebuild-manifest lists it
                    log(f"{day}: manifest update failed ({type(e).__name__}: {e})")
            stats["total_s"] = round(time.time() - t)
            log("DAY " + json.dumps(stats))
            built += 1
        except Exception as e:  # one bad day must not stop the catch-up
            failed.append(str(day))
            log(f"{day}: FAILED {type(e).__name__}: {e}")
            continue
        finally:
            if not a.keep_files:
                shutil.rmtree(os.path.join(a.work, str(day)), ignore_errors=True)
        if not a.keep_index:
            for feed in FEEDS:
                p = os.path.join(a.cache, f"{fa.tag_for(day, feed)}.idx.json.gz")
                if os.path.exists(p):
                    os.remove(p)
    log(f"done: {built} day(s) built" + (f", FAILED: {', '.join(failed)}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
