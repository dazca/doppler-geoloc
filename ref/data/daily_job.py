"""Daily data job for the deployed backend (Catalonia + Andorra): build + upload every missing recent UTC day.

Idempotent and catch-up by design: for each day in the last --days UTC days (default 30, ending yesterday), newest
first, it asks the live Worker whether <prod tag>/day.json AND <mlatonly tag>/day.json exist. Days that have both are
skipped (except a prod day.json with status "partial" younger than 7 days: rebuilt in case adsb.lol re-published it).
If the Worker cannot answer (429/5xx/network) the day is skipped this run, never rebuilt blindly. Any other day is
built and uploaded:
  1. stream the adsb.lol prod and mlatonly tars ONCE each (~3-5 GB in total; nothing is written to disk but the index),
     keeping only the region's tracks (non-jets whole; jets only as low baro+geom points for the baro calibration),
  2. tiles/<date>/<cell>.json.gz for every 0.5 deg region cell (non-jet tracks, contract format, same schema as
     build_tiles.py)  -> fast path + coverage baseline in web/engine/adsb.js,
  3. <tag>/<cell>.json index shards for the region cells + <tag>/day.json (build_index.py) -> generic search path
     (fetchTracks: shards + /adsb/range) and the archive completeness check (fetchDayStatus),
  4. upload to R2 (tiles, then shards, then day.json last = "day done" marker),
  5. delete the day's local files and the big day index (unless --keep-index); <tag>.counts.json is kept as the
     partial-day reference,
  6. add the day to the availability manifest meta/coverage.json in R2 ({updated, bbox, days[], from, to}; served by
     the Worker at /adsb/index/meta/coverage.json with a 60 s cache; the app's date gate reads it).
A day whose release is not published (or still uploading) is skipped and retried next run. A missing mlatonly release
is published as status "missing" once the day is > 2 days old; a missing prod release once the day is > 3 days old
(e.g. 2023-02-16..2023-03-09 have none), so it is not retried forever and the app can explain it; such a day is not
added to the manifest.

R2 access: Cloudflare REST API (requests, Bearer CLOUDFLARE_API_TOKEN with R2 edit, CLOUDFLARE_ACCOUNT_ID) when
CLOUDFLARE_API_TOKEN is set (CI); otherwise `wrangler r2 object ...` (local dev, wrangler OAuth login). At most
R2_CONCURRENCY requests at once; an authentication failure (401/403, "Authentication error", code 10000) aborts the
whole run (exit 2) instead of retrying every object.

  python ref/data/daily_job.py                    # normal daily run (catch-up of the last 30 days)
  python ref/data/daily_job.py --max-time 300     # stop cleanly before a day that would end after 300 min
  python ref/data/daily_job.py --date 2026-11-06  # one explicit day (rebuilds it even if present with --force)
  python ref/data/daily_job.py --no-upload --keep-files --date 2026-11-06   # local build only
  python ref/data/daily_job.py --rebuild-manifest # re-check recent/unknown days and merge them into the manifest
Needs: Python 3.11+ with numpy, requests, pyproj (CI: ref/data/requirements-ci.txt).
Optional GITHUB_TOKEN: authenticated GitHub API (release lookups, 5000 req/h instead of 60).
"""
import argparse
import datetime as dt
import gzip
import json
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

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
MANIFEST_SINCE = "2025-10-01"  # earliest day --rebuild-manifest looks for days missing from the manifest
RECHECK_DAYS = 35              # --rebuild-manifest re-probes manifest days this recent (older ones are trusted)
MISSING_MLAT_AFTER = 2         # days: a still-missing mlatonly release is published as "missing"
MISSING_PROD_AFTER = 3         # days: same for prod
PARTIAL_RECHECK_DAYS = 7       # a "partial" prod day younger than this is rebuilt on the next run
DEFAULT_DAY_MIN = 25.0         # --max-time: assumed minutes per day until one has been timed
WORK = os.path.join(fa.ROOT, ".cache", "daily")

_TYPES = None


# ----------------------------------------------------------------- parse worker
def region_batch(batch):
    """Pool worker (replaces fetch_adsb._process_batch): full footprint for the index, region legs only (lists of
    fa.Pt namedtuples).  Jets keep only points usable for the baro calibration (geom + baro < 10,000 ft)."""
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
                legs = [[q for q in leg if q.geom is not None and q.baro is not None
                         and q.baro < fa.CAL_MAX_BARO_FT] for leg in legs]
                legs = [leg for leg in legs if leg] or None
        out.append((off, len(data), fa.light_of(d), fp, legs))
        del d
    return out


def split_by_cell(found):
    """[(light, legs)] over the region -> {cell: [(light, legs clipped to that cell)]} (a cell exit ends a leg)."""
    per = {}
    for light, legs in found:
        mine = {}
        for leg in legs:
            run, rc = [], None
            for q in leg:
                c = fa.cell_id(q.lat, q.lon)
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


# ----------------------------------------------------------------- Worker probes
class WorkerUnavailable(RuntimeError):
    """The Worker could not say whether a key exists (429 / 5xx / network): never treated as 'missing'."""


def worker_json(worker, key, tries=4):
    """Parsed JSON the Worker serves at /adsb/index/<key>, None on 404; raises WorkerUnavailable otherwise."""
    for attempt in range(tries):
        try:
            r = requests.get(f"{worker}/adsb/index/{key}", timeout=30)
            if r.status_code == 404:
                return None
            if r.status_code == 200:
                try:
                    return r.json()
                except ValueError:
                    return {}
            wait = float(r.headers.get("Retry-After") or 5) if r.status_code == 429 else 3 * 2 ** attempt
            why = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            wait, why = 3 * 2 ** attempt, type(e).__name__
        if attempt + 1 < tries:
            time.sleep(min(wait, 60) * (0.5 + random.random()))
    raise WorkerUnavailable(f"cannot tell whether {key} exists ({why})")


def worker_has(worker, key, tries=3):
    return worker_json(worker, key, tries) is not None


def day_done(worker, day, today=None, tries=3):
    """True if both day.json are served (and prod is not a recent 'partial'). Raises WorkerUnavailable."""
    today = today or dt.datetime.now(dt.timezone.utc).date()
    prod = worker_json(worker, f"{fa.tag_for(day, 'prod')}/day.json", tries)
    if prod is None:
        return False
    if prod.get("status") == "partial" and day >= today - dt.timedelta(days=PARTIAL_RECHECK_DAYS):
        return False
    return worker_json(worker, f"{fa.tag_for(day, 'mlatonly')}/day.json", tries) is not None


def day_listed(worker, day, tries=8):
    """Manifest membership: True if both day.json are served and prod has data; False if not; raises if unknown."""
    prod = worker_json(worker, f"{fa.tag_for(day, 'prod')}/day.json", tries)
    if prod is None or prod.get("status") == "missing":
        return False
    return worker_json(worker, f"{fa.tag_for(day, 'mlatonly')}/day.json", tries) is not None


# ----------------------------------------------------------------- R2 access
class AuthError(RuntimeError):
    """Cloudflare rejected the credentials: abort the whole run."""


R2_CONCURRENCY = 3
_R2_SEM = threading.BoundedSemaphore(R2_CONCURRENCY)
AUTH_RE = re.compile(r"Authentication error|code:? ?10000\b|\b(?:HTTP|status)\D{0,3}(?:401|403)\b|Unauthorized|"
                     r"not logged in", re.I)
CF_API = "https://api.cloudflare.com/client/v4"


def _account():
    return os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")


def _api_url(bucket, key):
    return f"{CF_API}/accounts/{_account()}/r2/buckets/{bucket}/objects/{quote(key, safe='/')}"


def _use_api():
    return bool(os.environ.get("CLOUDFLARE_API_TOKEN"))


def _backoff(attempt):
    time.sleep(min(60, 3 * 2 ** attempt) * (0.5 + random.random()))


def _api(method, bucket, key, tries=9, **kw):
    """One Cloudflare R2 object API call with backoff (rate limit 1200 req / 5 min). Returns the response (2xx or
    404); raises AuthError on 401/403, RuntimeError after `tries` failures."""
    hdr = {"Authorization": f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}", **kw.pop("headers", {})}
    err = ""
    for attempt in range(tries):
        try:
            with _R2_SEM:
                r = requests.request(method, _api_url(bucket, key), headers=hdr, timeout=120, **kw)
            if r.status_code in (401, 403):
                raise AuthError(f"Cloudflare API {r.status_code} on {method} {key}: {r.text[:300]}")
            if r.ok or r.status_code == 404:
                return r
            err = f"HTTP {r.status_code}: {r.text[:300]}"
            if r.status_code < 500 and r.status_code != 429:
                break  # 400 etc.: retrying will not help
        except requests.RequestException as e:
            err = f"{type(e).__name__}: {e}"
        if attempt + 1 < tries:
            _backoff(attempt)
    raise RuntimeError(f"{method} {key} failed: {err}")


def _wrangler(args, tries, text=True):
    cmd = [_npx(), "wrangler", "r2", "object", *args, "--remote"]
    out = ""
    for attempt in range(tries):
        try:
            with _R2_SEM:
                r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                   cwd=fa.ROOT, timeout=300)
            out = (r.stderr or "") + (r.stdout or "") if r.returncode else ""
            if r.returncode == 0:
                return r
            if "does not exist" in out:
                return None
            if AUTH_RE.search(out):
                raise AuthError(f"wrangler: {out[-400:]}")
        except subprocess.TimeoutExpired:
            out = "timed out after 300 s"
        if attempt + 1 < tries:
            _backoff(attempt)
    raise RuntimeError(f"wrangler r2 object {args[0]} {args[1]} failed: {out[-400:]}")


def _npx():
    return shutil.which("npx") or shutil.which("npx.cmd") or "npx"


def _ctype(key):
    return "application/json" if key.endswith(".json") else "application/octet-stream"


def r2_put(bucket, key, path):
    if _use_api():
        with open(path, "rb") as f:
            body = f.read()
        _api("PUT", bucket, key, data=body, headers={"Content-Type": _ctype(key)})
        return
    if _wrangler(["put", f"{bucket}/{key}", "--file", path, "--content-type", _ctype(key)], 9) is None:
        raise RuntimeError(f"upload {key}: bucket does not exist")


def r2_get_json(bucket, key):
    """Object straight from R2 (not via the cached Worker): parsed JSON, or None if the key does not exist."""
    if _use_api():
        r = _api("GET", bucket, key, tries=5)
        return None if r.status_code == 404 else json.loads(r.content)
    r = _wrangler(["get", f"{bucket}/{key}", "--pipe"], 4)
    return None if r is None else json.loads(r.stdout)


def r2_delete(bucket, key):
    if _use_api():
        _api("DELETE", bucket, key, tries=5)
    else:
        _wrangler(["delete", f"{bucket}/{key}"], 4)


def upload(bucket, items, log, par=R2_CONCURRENCY):
    t = time.time()
    with ThreadPoolExecutor(par) as ex:
        list(ex.map(lambda kp: r2_put(bucket, *kp), items))
    log(f"  uploaded {len(items)} objects ({sum(os.path.getsize(p) for _, p in items)/1e6:.1f} MB) "
        f"in {time.time()-t:.0f}s")


# ----------------------------------------------------------------- manifest
def write_manifest(bucket, days, log):
    days = sorted(set(days))
    doc = {"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "bbox": COVERAGE_BBOX,
           "days": days, "from": days[0] if days else None, "to": days[-1] if days else None}
    os.makedirs(WORK, exist_ok=True)
    p = os.path.join(WORK, f"coverage.{os.getpid()}.{threading.get_ident()}.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    try:
        r2_put(bucket, MANIFEST_KEY, p)
    finally:
        os.remove(p)
    log(f"manifest: {len(days)} day(s), {doc['from']} .. {doc['to']}")
    return doc


def manifest_update(bucket, log, add=(), remove=(), min_keep_ratio=None, tries=4, settle_s=2.0):
    """Read-merge-write of the manifest, then read back: if a concurrent writer (another job) overwrote our change
    it is merged again (up to `tries` times).  Days are only ever removed explicitly (`remove`).
    min_keep_ratio: refuse to write a manifest smaller than this fraction of the current one."""
    add, remove = {str(d) for d in add}, {str(d) for d in remove}
    for attempt in range(tries):
        cur = r2_get_json(bucket, MANIFEST_KEY) or {}
        old = set(cur.get("days") or [])
        new = (old | add) - remove
        if min_keep_ratio and old and len(new) < min_keep_ratio * len(old):
            raise RuntimeError(f"refusing to shrink the manifest from {len(old)} to {len(new)} days")
        if cur and new == old:
            log(f"manifest: unchanged ({len(old)} day(s))")
            return cur
        doc = write_manifest(bucket, new, log)
        time.sleep(settle_s)
        back = set((r2_get_json(bucket, MANIFEST_KEY) or {}).get("days") or [])
        if add <= back and not (remove & back):
            return doc
        log(f"manifest: concurrent write detected, merging again ({attempt + 1}/{tries})")
        time.sleep(settle_s * (1 + 2 * random.random()))
    raise RuntimeError("manifest: could not land the update (concurrent writers)")


def manifest_add(bucket, day, log):
    return manifest_update(bucket, log, add=[day])


def rebuild_manifest(worker, bucket, since, until, log, par=4, recheck_days=RECHECK_DAYS):
    """Merge the served days into the manifest without ever losing knowledge:
    probe only days in [since, until] NOT in the current manifest, plus the last `recheck_days` days (few hundred
    requests at most, the Worker's index rate limit is 240/min); a day the Worker definitely does not serve (404) is
    removed, a day whose probe fails keeps its previous state, and days older than `since` are kept as they are."""
    t = time.time()
    cur = r2_get_json(bucket, MANIFEST_KEY) or {}
    known = set(cur.get("days") or [])
    recent = until - dt.timedelta(days=recheck_days)
    days = [since + dt.timedelta(days=k) for k in range((until - since).days + 1)]
    cand = [d for d in days if str(d) not in known or d >= recent]

    def check(d):
        try:
            return day_listed(worker, d)
        except Exception as e:
            log(f"  {d}: probe failed ({e}); keeping previous state")
            return None

    with ThreadPoolExecutor(par) as ex:
        res = list(ex.map(check, cand))
    add = [str(d) for d, ok in zip(cand, res) if ok]
    remove = [str(d) for d, ok in zip(cand, res) if ok is False and str(d) in known]
    unknown = sum(ok is None for ok in res)
    log(f"probed {len(cand)} day(s) in {time.time()-t:.0f}s: +{len(set(add) - known)} -{len(remove)}"
        + (f", {unknown} unknown (kept as before)" if unknown else ""))
    if remove:
        log("  no longer served: " + ", ".join(remove))
    return manifest_update(bucket, log, add=add, remove=remove, min_keep_ratio=0.5)


# ----------------------------------------------------------------- one day
def build_day(day, a, log):
    """Stream + build one day into <WORK>/<date>/. Returns (uploads list, stats) or None if not ready yet."""
    s = requests.Session()
    s.headers.update(fa.UA)
    today = dt.datetime.now(dt.timezone.utc).date()
    out = os.path.join(a.work, str(day))
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    os.makedirs(a.cache, exist_ok=True)
    d0 = dt.datetime(day.year, day.month, day.day, tzinfo=dt.timezone.utc).timestamp()
    # check both releases exist (and are fully uploaded) before downloading anything; the asset list is memoised
    present = {}
    for feed in FEEDS:
        try:
            fa.find_release(day, feed, s)
            present[feed] = True
        except fa.MissingRelease as e:
            grace = MISSING_PROD_AFTER if feed == "prod" else MISSING_MLAT_AFTER
            if isinstance(e, fa.IncompleteRelease) or day >= today - dt.timedelta(days=grace):
                log(f"{day}: {fa.tag_for(day, feed)} not published yet ({e}); will retry next run")
                return None
            log(f"{day}: {feed} release missing ({e}); publishing status 'missing'")
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
    per = {}
    for f in FEEDS:
        per[f] = split_by_cell(found.pop(f))
    del found
    uploads, ntr, tile_bytes = [], 0, 0
    os.makedirs(os.path.join(out, "tiles"))
    for c in REGION_CELLS:
        merged = fa.merge_feeds([per[f].pop(c, []) for f in FEEDS])  # pop: free each cell's legs once written
        tracks, _ = fa.to_contract(merged, types, geoid, None) if merged else ([], None)
        del merged
        tracks = [tr for tr in tracks if tr["category"] != "jet"]
        for tr in tracks:
            tr.pop("sources", None)
        p = os.path.join(out, "tiles", f"{c}.json.gz")
        with gzip.open(p, "wt", encoding="utf-8", compresslevel=9) as f:
            json.dump({"date": str(day), "cell": c, "cell_deg": fa.CELL, "source": "adsb.lol globe_history (ODbL 1.0)",
                       **fa.LICENSE, "tracks": tracks}, f, separators=(",", ":"))
        ntr += len(tracks)
        tile_bytes += os.path.getsize(p)
        uploads.append((f"tiles/{day}/{c}.json.gz", p))
    del per
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


# ----------------------------------------------------------------- main
def r2_selftest(bucket, log, key="meta/_ci_probe.json"):
    """PUT + GET + DELETE of a harmless key: proves the credentials before a long run."""
    os.makedirs(WORK, exist_ok=True)
    p = os.path.join(WORK, f"probe.{os.getpid()}.json")
    body = {"probe": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    with open(p, "w", encoding="utf-8") as f:
        json.dump(body, f)
    try:
        r2_put(bucket, key, p)
        back = r2_get_json(bucket, key)
        r2_delete(bucket, key)
        gone = r2_get_json(bucket, key) is None
    finally:
        os.remove(p)
    ok = back == body and gone
    log(f"R2 self-test via {'Cloudflare API' if _use_api() else 'wrangler'}: "
        f"put/get {'ok' if back == body else 'MISMATCH'}, delete {'ok' if gone else 'FAILED'}")
    return ok


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--days", type=int, default=30, help="catch-up window: the last N UTC days ending yesterday")
    ap.add_argument("--date", action="append", help="explicit UTC day YYYY-MM-DD (repeatable; replaces --days)")
    ap.add_argument("--force", action="store_true", help="rebuild even if the Worker already serves the day")
    ap.add_argument("--max-days", type=int, default=0, help="stop after building this many days (0 = no limit)")
    ap.add_argument("--max-time", type=float, default=0, metavar="MINUTES",
                    help="do not start a day that would not finish within MINUTES of the job start (0 = no limit); "
                         "the days left are printed as REMAINING")
    ap.add_argument("--worker", default=WORKER, help="Worker origin used for the 'already done' check")
    ap.add_argument("--bucket", default=BUCKET)
    ap.add_argument("--cache", default=fa.DEFAULT_CACHE)
    ap.add_argument("--work", default=WORK)
    ap.add_argument("--workers", type=int, default=None, help="parse processes (default: by CPU and free RAM)")
    ap.add_argument("--no-upload", action="store_true")
    ap.add_argument("--keep-files", action="store_true", help="keep the day's tiles/shards in --work")
    ap.add_argument("--keep-index", action="store_true", help="keep the ~30 MB day index in --cache")
    ap.add_argument("--rebuild-manifest", action="store_true",
                    help=f"only merge the days the Worker serves into {MANIFEST_KEY} (see rebuild_manifest), then exit")
    ap.add_argument("--since", default=MANIFEST_SINCE, help="first day --rebuild-manifest looks for unknown days")
    ap.add_argument("--r2-selftest", action="store_true", help="PUT/GET/DELETE meta/_ci_probe.json, then exit")
    a = ap.parse_args(argv)
    os.environ.setdefault("CLOUDFLARE_ACCOUNT_ID", "a1cd2a86a35ae7d3f0d9ec23c95ac31e")
    log = lambda *x: print(*x, flush=True)  # noqa: E731
    t_job = time.time()
    today = dt.datetime.now(dt.timezone.utc).date()
    try:
        if a.r2_selftest:
            return 0 if r2_selftest(a.bucket, log) else 1
        if a.rebuild_manifest:
            doc = rebuild_manifest(a.worker, a.bucket, dt.date.fromisoformat(a.since),
                                   today - dt.timedelta(days=1), log)
            have, gaps = set(doc.get("days") or []), []
            if have:
                d0, d1 = dt.date.fromisoformat(doc["from"]), dt.date.fromisoformat(doc["to"])
                gaps = [str(d0 + dt.timedelta(days=k)) for k in range((d1 - d0).days + 1)
                        if str(d0 + dt.timedelta(days=k)) not in have]
            log("gaps: " + (", ".join(gaps) if gaps else "none"))
            return 0
        return run_days(a, log, today, t_job)
    except AuthError as e:
        log(f"ABORT: R2 authentication failed, check CLOUDFLARE_API_TOKEN / wrangler login: {e}")
        return 2


def run_days(a, log, today, t_job):
    days = ([dt.date.fromisoformat(x) for x in a.date] if a.date
            else [today - dt.timedelta(days=k) for k in range(1, a.days + 1)])
    built, failed, unsure, durations = 0, [], [], []
    for i, day in enumerate(days):
        if a.max_time:
            est = max(durations) if durations else DEFAULT_DAY_MIN * 60
            left = a.max_time * 60 - (time.time() - t_job)
            if est > left:
                rest = [str(d) for d in days[i:]]
                log(f"--max-time: {left/60:.0f} min left < ~{est/60:.0f} min per day; stopping before {day}")
                log(f"REMAINING ({len(rest)}): {' '.join(rest)}")
                break
        if not a.force:
            try:
                if day_done(a.worker, day, today):
                    log(f"{day}: already served, skip")
                    continue
            except WorkerUnavailable as e:
                unsure.append(str(day))
                log(f"{day}: {e}; skipped this run")
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
                if stats.get("prod_status") != "missing":
                    try:
                        manifest_add(a.bucket, day, log)
                    except AuthError:
                        raise
                    except Exception as e:  # the day itself is uploaded; the next --rebuild-manifest lists it
                        log(f"{day}: manifest update failed ({type(e).__name__}: {e})")
            stats["total_s"] = round(time.time() - t)
            durations.append(time.time() - t)
            log("DAY " + json.dumps(stats))
            built += 1
        except AuthError:
            raise
        except Exception as e:  # one bad day must not stop the catch-up
            failed.append(str(day))
            durations.append(time.time() - t)
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
    log(f"done: {built} day(s) built" + (f", FAILED: {', '.join(failed)}" if failed else "")
        + (f", Worker unsure (skipped): {', '.join(unsure)}" if unsure else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
