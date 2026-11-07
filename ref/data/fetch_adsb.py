"""Historical ADS-B tracks for a bbox + UTC window -> contract flight-track JSON.

Source: adsb.lol globe_history daily dumps (ODbL 1.0, no account):
  https://github.com/adsblol/globe_history_<YYYY>/releases/download/<tag>/<tag>.tar.aa (.ab ...)
  tag = v<YYYY>.<MM>.<DD>-planes-readsb-<feed>-0,  feed = prod (main) | mlatonly | staging
  The tar (uncompressed, split every 2,000,000,000 bytes) holds ./traces/<xx>/trace_full_<icao>.json,
  each member a gzip JSON readsb trace (see docs/DATA.md for the point layout).

Two access modes, chosen automatically:
  1. STREAM (first time a day/feed is seen): stream the whole day (~3-3.5 GB, ~2-5 min on a fast line),
     keep the matching tracks AND write a byte-offset + spatial index of every trace to the cache
     (<cache>/<tag>.idx.json.gz, ~5-15 MB).
  2. INDEX (day already indexed): look up which traces visited the bbox cells at low altitude during
     the window, then fetch only those members with HTTP Range requests (typ. 1-10 MB total).
  The same index is what a Cloudflare Worker / the browser would use (see worker/).

Usage:
  python ref/data/fetch_adsb.py --bbox 41.3,1.8,41.8,2.4 --start 2026-11-01T08:00Z --end 2026-11-01T12:00Z \
      --out fixtures/real/lell/tracks.json
  python ref/data/fetch_adsb.py --meta fixtures/real/<case>/meta.json      (bbox/window/out from meta)

Altitude -> MSL (contract alt_m_msl):
  * geometric altitude (GNSS, readsb alt_geom: feet above the WGS84 ELLIPSOID) minus EGM96 geoid
    undulation N(lat,lon) (pyproj + PROJ network grid us_nga_egm96_15.tif).  Preferred.
  * baro-only points (MLAT, old transponders): pressure altitude (1013.25 hPa ref) + a regional offset
    = median(geom_msl - baro) of all points in the bbox that carry both, within +-30 min.  If no
    calibration pair exists the raw pressure altitude is used (error ~8 m per hPa of QNH deviation).
"""
import argparse
import glob
import re
from array import array
from collections import deque, namedtuple
import datetime as dt
import gzip
import json
import math
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor

# No multi-threaded BLAS here (only small vector ops): one OpenBLAS thread avoids per-thread buffers being committed in
# the main process and in every parse worker (a worker died at import with "OpenBLAS: Memory allocation failed" when
# the machine was low on RAM).  Must be set before numpy is imported; child processes inherit it.
for _v in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import numpy as np
import requests

os.environ.setdefault("PROJ_NETWORK", "ON")  # needed to fetch the EGM96 grid on first use

FT = 0.3048
PART = 2_000_000_000  # split size of the .tar.aa/.ab parts
CELL = 0.5            # index cell size, degrees
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_CACHE = os.path.join(ROOT, ".cache", "adsb")
UA = {"User-Agent": "doppler-geoloc-research (ref/data/fetch_adsb.py)"}
LICENSE = {"license": "ODbL-1.0", "license_url": "https://opendatacommons.org/licenses/odbl/1-0/"}  # adsb.lol data
LEG_GAP_S = 300.0
CAL_MAX_BARO_FT = 10000  # geom-baro offset grows with height (temperature): calibrate on low traffic only


# ----------------------------------------------------------------- helpers
def parse_time(s):
    s = s.strip().replace("Z", "+00:00")
    if s.replace(".", "").isdigit():
        return float(s)
    d = dt.datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.timestamp()


def cell_id(lat, lon):
    return int((math.floor(lat / CELL) + 180) * 1000 + (math.floor(lon / CELL) + 360))


def cells_for_bbox(la0, lo0, la1, lo1):
    out = []
    for i in range(math.floor(la0 / CELL), math.floor(la1 / CELL) + 1):
        for j in range(math.floor(lo0 / CELL), math.floor(lo1 / CELL) + 1):
            out.append((i + 180) * 1000 + (j + 360))
    return out


class MissingRelease(RuntimeError):
    """The release for this day/feed does not exist (e.g. no mlatonly feed before ~2024-03, or not published yet)."""


class IncompleteRelease(MissingRelease):
    """The release exists but is still being uploaded (an asset not 'uploaded' yet, or the last part is exactly
    PART bytes so more parts may follow).  Always retried later, never published as 'missing'."""


# Release tags end in -0 normally; adsb.lol occasionally publishes -0tmp or -1 (re-runs).  Our cache files and R2 keys
# always use the canonical -0 tag (tag_for); the real release tag is kept in the index / day.json as "release".
TAG_RE = re.compile(r"-(\d|0tmp)$")
TAG_SUFFIXES = ("0", "0tmp", "1")
GH_API = "https://api.github.com"
GH_DL = "https://github.com/adsblol"


def tag_for(day, feed, suffix="0"):
    return f"v{day:%Y.%m.%d}-planes-readsb-{feed}-{suffix}"


def feed_of_tag(tag):
    return TAG_RE.sub("", tag.split("-readsb-")[1])


def repo_years(day):
    """globe_history_<year> repos that may hold the day's release, in order: a day's release normally lives in its
    own year's repo, but Dec 31 is published into next year's repo and some early-January (staging) days into the
    previous year's repo."""
    return (day.year, day.year + 1, day.year - 1)


def gh_headers():
    h = {"Accept": "application/vnd.github+json"}
    tok = os.environ.get("GITHUB_TOKEN")
    if tok:
        h["Authorization"] = f"Bearer {tok}"
    return h


_RELEASE_CACHE = {}       # (day, feed) -> (time, [(url, size)], release_tag, repo_year)
RELEASE_CACHE_S = 3600


def assert_servable(release, names):
    """Every tar asset must be <release>.tar or <release>.tar.a[a-z]: the Worker's /adsb/range builds exactly that
    download URL from the release tag (+ part), so an index over any other asset name could never be served.
    Raises IncompleteRelease (the day is retried later, never published)."""
    bad = [n for n in names if not re.fullmatch(re.escape(release) + r"\.tar(\.a[a-z])?", n)]
    if bad:
        raise IncompleteRelease(f"release {release}: asset name(s) {', '.join(bad)} not servable by the Worker "
                                f"(expected {release}.tar[.aX])")


def _check_assets(tag, assets):
    tars = sorted((a for a in assets if ".tar" in a["name"]), key=lambda a: a["name"])
    if not tars:
        raise IncompleteRelease(f"release {tag} has no tar assets yet")
    assert_servable(tag, [a["name"] for a in tars])
    bad = [a["name"] for a in tars if a.get("state", "uploaded") != "uploaded"]
    if bad:
        raise IncompleteRelease(f"release {tag}: assets still uploading ({', '.join(bad)})")
    if tars[-1].get("size") == PART:
        raise IncompleteRelease(f"release {tag}: last part {tars[-1]['name']} is exactly {PART} bytes "
                                f"(more parts are probably still being uploaded)")
    return tars


def find_release(day, feed, session):
    """-> ([(url, size)], release_tag, repo_year) of the day's release.  Raises MissingRelease / IncompleteRelease.
    GitHub API first (60 req/h unauthenticated, 5000 with GITHUB_TOKEN); falls back to probing when rate-limited.
    Memoised for RELEASE_CACHE_S so the daily job's precheck and the stream share one lookup."""
    key = (day, feed)
    hit = _RELEASE_CACHE.get(key)
    if hit and time.time() - hit[0] < RELEASE_CACHE_S:
        return hit[1:]
    api_ok = True
    for suf in TAG_SUFFIXES:
        tag = tag_for(day, feed, suf)
        for y in repo_years(day):
            if api_ok:
                try:
                    r = session.get(f"{GH_API}/repos/adsblol/globe_history_{y}/releases/tags/{tag}",
                                    headers=gh_headers(), timeout=30)
                except requests.RequestException:
                    r = None
                if r is not None and r.status_code == 404:
                    continue
                if r is not None and r.ok:
                    tars = _check_assets(tag, r.json().get("assets", []))
                    out = ([(f"{GH_DL}/globe_history_{y}/releases/download/{tag}/{a['name']}", a.get("size"))
                            for a in tars], tag, y)
                    _RELEASE_CACHE[key] = (time.time(), *out)
                    return out
                api_ok = False  # rate-limited / API down: probe the download URLs from here on
            out = _probe_release(session, y, tag)
            if out:
                res = (out, tag, y)
                _RELEASE_CACHE[key] = (time.time(), *res)
                return res
    raise MissingRelease(f"release {tag_for(day, feed)} not found in globe_history_{'/'.join(map(str, repo_years(day)))}"
                         f" (also -0tmp/-1; no such feed that day, or not published yet: days appear on D+1 "
                         f"~00:20-03:30 UTC)")


def _probe_release(session, year, tag):
    """[(url, size)] by HEAD-probing .tar, .tar.aa, .tar.ab ... (no asset state available: size check only)."""
    base = f"{GH_DL}/globe_history_{year}/releases/download/{tag}/{tag}.tar"
    out = []
    for suf in ["", ".aa", ".ab", ".ac", ".ad", ".ae", ".af"]:
        try:
            h = session.head(base + suf, allow_redirects=True, timeout=30)
        except requests.RequestException:
            h = None
        if h is not None and h.ok:
            out.append((base + suf, int(h.headers.get("Content-Length") or 0) or None))
            if suf == "":
                break
        elif suf:
            if out or suf != ".aa":
                break
    if out and out[-1][1] == PART:
        raise IncompleteRelease(f"release {tag}: last part is exactly {PART} bytes (more parts probably pending)")
    return out


def part_urls(day, feed, session):
    """Ordered [(url, size)] of the day's tar parts (see find_release)."""
    return find_release(day, feed, session)[0]


def resolve(session, url):
    """Follow GitHub's 302 to the signed blob URL (valid ~1 h) and get its size."""
    r = session.head(url, allow_redirects=True, timeout=30)
    r.raise_for_status()
    return r.url, int(r.headers["Content-Length"])


class Geoid:
    def __init__(self):
        from pyproj import Transformer
        self.t = Transformer.from_crs("EPSG:4979", "EPSG:4326+5773", always_xy=True)

    def N(self, lat, lon):
        lat = np.asarray(lat, float)
        lon = np.asarray(lon, float)
        _, _, h = self.t.transform(lon, lat, np.full(lat.shape, 1000.0))
        n = 1000.0 - np.asarray(h)
        if not np.all(np.isfinite(n)) or np.allclose(n, 0):
            raise RuntimeError("EGM96 grid unavailable (set PROJ_NETWORK=ON, needs internet once)")
        return n


# ----------------------------------------------------------------- trace parsing
def footprint(d):
    """Per-cell [tmin, tmax, min_alt_ft] for the index (airborne points only; ground -> alt 0)."""
    base = d.get("timestamp", 0.0)
    fp = {}
    for p in d.get("trace", ()):
        lat, lon = p[1], p[2]
        if lat is None:
            continue
        a = p[3]
        alt = 0 if a == "ground" else (a if isinstance(a, (int, float)) else 99999)
        c = cell_id(lat, lon)
        t = int(base + p[0])
        e = fp.get(c)
        if e is None:
            fp[c] = [t, t, int(alt)]
        else:
            if t < e[0]: e[0] = t
            if t > e[1]: e[1] = t
            if alt < e[2]: e[2] = int(alt)
    return fp


# One raw point of a leg.  A namedtuple (not an 11-key dict): ~5x smaller in RAM and in the worker->parent pickle.
Pt = namedtuple("Pt", "t lat lon geom baro ground src cs gs trk vr")


def extract(d, bbox, t0, t1, keep_ground=False):
    """readsb trace dict -> list of raw legs (each a list of Pt) inside bbox/window."""
    la0, lo0, la1, lo1 = bbox
    base = float(d.get("timestamp", 0.0))
    legs, cur, last_t = [], [], None
    callsign = None
    for p in d.get("trace", ()):
        t = base + p[0]
        flags = p[6] if len(p) > 6 and isinstance(p[6], int) else 0
        if len(p) > 8 and isinstance(p[8], dict) and p[8].get("flight"):
            callsign = p[8]["flight"].strip() or callsign
        lat, lon = p[1], p[2]
        inside = (t0 <= t <= t1 and lat is not None and la0 <= lat <= la1 and lo0 <= lon <= lo1)
        if inside:
            a = p[3]
            ground = a == "ground"
            if ground and not keep_ground:
                inside = False
        if not inside:
            if cur:
                legs.append(cur)
                cur = []
            last_t = None
            continue
        if last_t is not None and t <= last_t:
            continue                               # duplicate / out-of-order timestamp (seen with TIS-B)
        if cur and ((flags & 2) or (last_t is not None and t - last_t > LEG_GAP_S)):
            legs.append(cur)
            cur = []
        geom = p[10] if len(p) > 10 and isinstance(p[10], (int, float)) else None
        baro = p[3] if isinstance(p[3], (int, float)) else None
        if baro is not None and (flags & 8):       # altitude field itself is geometric
            geom, baro = (geom if geom is not None else baro), None
        src = p[9] if len(p) > 9 else None
        if isinstance(src, str):
            src = sys.intern(src)                  # one shared object per source name (RAM + pickle memo)
        if isinstance(src, str) and src.startswith("tisb") and baro is not None:
            geom = None                            # TIS-B (radar) "geometric" alt is unreliable: use baro
        if geom is None and baro is None and p[3] != "ground":
            continue                               # no altitude at all: unusable
        # reported velocity (D15, optional): ground speed kt, track deg, vertical rate ft/min (geom rate, else baro rate)
        gs = p[4] if len(p) > 4 and isinstance(p[4], (int, float)) else None
        trk = p[5] if len(p) > 5 and isinstance(p[5], (int, float)) else None
        vr = p[11] if len(p) > 11 and isinstance(p[11], (int, float)) else (p[7] if len(p) > 7 and isinstance(p[7], (int, float)) else None)
        cur.append(Pt(t, lat, lon, geom, baro, p[3] == "ground", src, callsign, gs, trk, vr))
        last_t = t
    if cur:
        legs.append(cur)
    return legs


# ----------------------------------------------------------------- tar streaming / index
class TruncatedTar(RuntimeError):
    """The tar stream ended mid-member or before the end-of-archive marker (two zero blocks)."""


class CorruptTar(TruncatedTar):
    """Too much of the release could not be parsed (corrupt tar headers, > MAX_TAR_LOSS of its bytes)."""


MAX_TAR_LOSS = 0.20      # fraction of a release's bytes lost to tar corruption above which the day fails
PARTIAL_LOSS = 0.005     # fraction of traces (or bytes) lost to corruption above which a day is "partial"


def tar_header_ok(h):
    """512-byte ustar/v7 header with a valid checksum (unsigned or signed sum, header checksum field as spaces)."""
    if len(h) < 512:
        return False
    try:
        chk = int(bytes(h[148:156]).strip(b"\0 ") or b"x", 8)
    except ValueError:
        return False
    rest = bytes(h[:148]) + b" " * 8 + bytes(h[156:512])
    return chk == sum(rest) or chk == sum(b - 256 if b > 127 else b for b in rest)


class TarStreamer:
    """Iterate (global_offset, name, data) over the concatenated parts of a split tar.
    urls: [url] or [(url, expected_size or None)].  A dropped download is resumed with a Range request (up to
    MAX_RESUMES times per part); a part shorter than its expected size, or a stream that ends mid-member or without the
    two zero blocks, raises TruncatedTar instead of silently producing a short index."""
    MAX_RESUMES = 3

    def __init__(self, session, urls, log):
        self.s, self.log = session, log
        self.urls = [u if isinstance(u, (tuple, list)) else (u, None) for u in urls]
        # corruption accounting (members()): bad headers met, bytes skipped while resynchronising, and whether the
        # last resync reached the end of the stream without finding another valid header
        self.resyncs, self.skipped_bytes, self.resync_failed = 0, 0, False

    def chunks(self):
        for u, size in self.urls:
            got, resumes = 0, 0
            while True:
                hdr = {"Range": f"bytes={got}-"} if got else {}
                try:
                    with self.s.get(u, stream=True, timeout=120, headers=hdr) as r:
                        if r.status_code >= 500:  # GitHub / CDN hiccup: retried like a dropped connection
                            raise requests.HTTPError(f"HTTP {r.status_code}", response=r)
                        r.raise_for_status()
                        if got and (r.status_code != 206 or
                                    not (r.headers.get("Content-Range") or "").startswith(f"bytes {got}-")):
                            raise TruncatedTar(f"server did not honour the resume Range request for {u} "
                                               f"(HTTP {r.status_code}, Content-Range {r.headers.get('Content-Range')!r})")
                        for c in r.iter_content(chunk_size=1 << 22):
                            got += len(c)
                            yield c
                    if size is None or got >= size:
                        break
                    err = f"part ended at {got} of {size} bytes"
                except (requests.ConnectionError, requests.Timeout,
                        requests.exceptions.ChunkedEncodingError) as e:
                    err = f"{type(e).__name__}: {e}"
                except requests.HTTPError as e:
                    if e.response is None or e.response.status_code < 500:
                        raise
                    err = f"HTTP {e.response.status_code}"
                if resumes >= self.MAX_RESUMES:
                    raise TruncatedTar(f"{u}: download dropped {resumes + 1} times ({err})")
                resumes += 1
                self.log(f"  download dropped at {got/1e9:.2f} GB ({err}); resuming ({resumes}/{self.MAX_RESUMES})")
                time.sleep(2 * resumes)

    def members(self):
        buf = bytearray()
        pos = 0          # global offset of buf[0]
        t_start = time.time()
        next_log = 250e6
        it = self.chunks()
        eof = False

        def fill(n):
            nonlocal buf, eof
            while len(buf) < n and not eof:
                try:
                    buf += next(it)
                except StopIteration:
                    eof = True
            return len(buf) >= n

        def resync():
            """Drop bytes until buf starts with the next valid ustar header (never the current one).  Returns the
            number of bytes skipped, or None if the stream ended first (buf is then empty)."""
            nonlocal buf, pos
            p0, lo = pos, 1
            while True:
                k = buf.find(b"ustar", lo + 257)
                if k != -1:
                    hs = k - 257
                    if fill(hs + 512) and tar_header_ok(buf[hs:hs + 512]):
                        del buf[:hs]
                        pos += hs
                        return pos - p0
                    lo = hs + 1
                    continue
                if eof:
                    pos += len(buf)
                    buf.clear()
                    return None
                drop = max(0, len(buf) - 1024)  # keep a tail: a header may straddle the next chunk
                del buf[:drop]
                pos += drop
                lo = max(0, lo - drop)
                fill(len(buf) + (1 << 20))

        while True:
            if not fill(512):
                raise TruncatedTar(f"tar ended at {pos + len(buf)} bytes without the end-of-archive marker")
            h = bytes(buf[:512])
            if h == b"\0" * 512:
                if not fill(1024) or bytes(buf[512:1024]) != b"\0" * 512:
                    raise TruncatedTar(f"tar ended at {pos + len(buf)} bytes after a single zero block")
                return
            if not tar_header_ok(h):
                # Corrupt / misaligned upstream tar (seen 2026-04-30 and 2026-05-04: the .tar.ab part does not
                # continue .tar.aa, so the member spanning the split is garbage and the next "header" is random
                # bytes).  Resynchronise on the next valid ustar header; the caller accounts for the loss.
                self.resyncs += 1
                at = pos
                n = resync()
                if n is None:
                    self.skipped_bytes += pos - at
                    self.resync_failed = True
                    self.log(f"  corrupt tar header at {at}: no valid header until the end ({(pos - at)/1e6:.1f} MB "
                             f"unparsed)")
                    return
                self.skipped_bytes += n
                self.log(f"  corrupt tar header at {at}: resynchronised {n} bytes later")
                continue
            name = h[0:100].rstrip(b"\0").decode("utf-8", "replace")
            prefix = h[345:500].rstrip(b"\0").decode("utf-8", "replace")
            if prefix:
                name = prefix + "/" + name
            sz = h[124:136]
            size = int.from_bytes(sz[1:], "big") if sz[0] & 0x80 else int(sz.strip(b"\0 ") or b"0", 8)
            typ = h[156:157]
            hdr_off = pos
            del buf[:512]
            pos += 512
            pad = ((size + 511) // 512) * 512
            if not fill(pad):
                raise TruncatedTar(f"tar ended inside member {name!r} at {pos + len(buf)} bytes")
            data = bytes(buf[:size]) if typ in (b"0", b"\0") else None  # skip dirs etc.
            del buf[:pad]
            pos += pad
            if data is None:
                continue
            if pos > next_log:
                el = time.time() - t_start
                self.log(f"  {pos/1e9:.2f} GB streamed, {pos/1e6/el:.0f} MB/s")
                next_log += 250e6
            yield hdr_off + 512, name, data


_W = {}


def _init_worker(bbox, t0, t1, keep_ground):
    _W.update(bbox=bbox, t0=t0, t1=t1, keep_ground=keep_ground)


def light_of(d):
    return {"icao": d.get("icao"), "t": d.get("t"), "r": d.get("r"), "desc": d.get("desc"),
            "A7": any(len(p) > 8 and isinstance(p[8], dict) and p[8].get("category") == "A7"
                      for p in d.get("trace", ()))}


def _process_batch(batch):
    out = []
    for off, data in batch:
        try:
            d = json.loads(gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data)
        except Exception:  # noqa: BLE001 - zlib.error / EOFError / bad JSON: counted, not fatal
            out.append((off, len(data), None, None, None))
            continue
        legs = extract(d, _W["bbox"], _W["t0"], _W["t1"], _W["keep_ground"])
        out.append((off, len(data), light_of(d), footprint(d), legs))
    return out


def free_ram_gb():
    """Available physical RAM (GB), or None if unknown.  Windows via ctypes, Linux via /proc/meminfo."""
    try:
        if os.name == "nt":
            import ctypes

            class MS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            m = MS()
            m.dwLength = ctypes.sizeof(MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return m.ullAvailPhys / 1e9
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable"):
                    return int(line.split()[1]) / 1e6
    except Exception:
        return None
    return None


WORKER_GB = 0.4   # per parse worker: json of the largest traces (~0.25 GB transient) + interpreter/numpy/pyproj
MAIN_GB = 1.5     # main process: index arrays + region legs + in-flight batches


def default_workers():
    n = max(1, min(4, (os.cpu_count() or 2) - 1))
    ram = free_ram_gb()
    if ram is not None:
        n = max(1, min(n, int((ram - MAIN_GB) / WORKER_GB)))
    return n


class PoolFailure(RuntimeError):
    """A parse worker died (OOM kill, MemoryError while receiving a task, crash) or a batch timed out."""


def ordered_pool_map(fn, items, workers, initializer=None, initargs=(), timeout=600, max_tasks_per_child=200):
    """Yield fn(item) in order using worker processes, with at most 2*workers tasks in flight (bounded memory: the
    items generator is consumed lazily, unlike ProcessPoolExecutor.map before py3.14).  A dead worker
    (BrokenProcessPool) or a task slower than `timeout` s raises PoolFailure promptly instead of hanging forever
    (multiprocessing.Pool.imap waits forever for the result of a task whose worker died)."""
    kw = {"max_tasks_per_child": max_tasks_per_child} if sys.version_info >= (3, 11) and max_tasks_per_child else {}
    ex = ProcessPoolExecutor(workers, initializer=initializer, initargs=initargs, **kw)
    q = deque()
    ok = False
    try:
        for it in items:
            q.append(ex.submit(fn, it))
            while len(q) >= 2 * workers:
                yield _result(q.popleft(), timeout)
        while q:
            yield _result(q.popleft(), timeout)
        ok = True
    finally:
        if ok:
            ex.shutdown(wait=True)
        else:  # error, timeout or the consumer stopped early: do not wait for (possibly hung) workers
            for f in q:
                f.cancel()
            procs = list((getattr(ex, "_processes", None) or {}).values())
            ex.shutdown(wait=False, cancel_futures=True)
            for p in procs:
                try:
                    p.kill()
                except Exception:
                    pass


def _result(fut, timeout):
    from concurrent.futures import TimeoutError as FTimeout
    from concurrent.futures.process import BrokenProcessPool
    try:
        return fut.result(timeout=timeout)
    except BrokenProcessPool as e:
        raise PoolFailure(f"a parse worker died ({e}); out of memory? retry with fewer --workers") from e
    except FTimeout as e:
        raise PoolFailure(f"a parse batch took more than {timeout} s") from e


def stream_day(session, day, feed, bbox, t0, t1, cache, log, keep_ground, workers=None, process=None):
    """Stream one day/feed once and write its byte-offset index to the cache.
    Memory is bounded: at most 2*workers batches (64 members) are in flight (ordered_pool_map); the index is packed.
    A dead/hung worker or a truncated download raises (PoolFailure / TruncatedTar) instead of hanging or indexing a
    short day.
    process: optional module-level replacement for _process_batch (same return shape), e.g. ref/data/daily_job.py.
    Also writes <tag>.counts.json (trace count + size), the partial-day reference that survives deleting the index."""
    workers = workers or default_workers()
    tag = tag_for(day, feed)
    parts, release, repo = find_release(day, feed, session)
    if not TAG_RE.search(release) or not release.startswith(tag[:-1]):
        raise IncompleteRelease(f"{tag}: release tag {release!r} not servable by the Worker")
    assert_servable(release, [u.rsplit("/", 1)[-1] for u, _ in parts])
    resolved = [resolve(session, u) for u, _ in parts]
    sizes = [rs for _, rs in resolved]
    for (u, s_api), s_head in zip(parts, sizes):
        if s_api and s_api != s_head:
            raise IncompleteRelease(f"{u}: API says {s_api} bytes, download is {s_head} (asset being replaced?)")
    log(f"{tag}: streaming {len(parts)} part(s) of {release} (globe_history_{repo}), {sum(sizes)/1e9:.2f} GB")
    traces, cells, found = [], {}, []
    n_bad = 0

    # original github.com URLs (each (re)connect follows the redirect: a fresh signed URL for Range resumes)
    ts = TarStreamer(session, [(u, sz) for (u, _), sz in zip(parts, sizes)], log)

    def batches():
        b = []
        for off, name, data in ts.members():
            if "trace_full_" in name:
                b.append((off, data))
                if len(b) >= 64:
                    yield b
                    b = []
        if b:
            yield b

    ram = free_ram_gb()
    log(f"  {workers} parse workers (free RAM {ram if ram is not None else float('nan'):.1f} GB)")
    for res in ordered_pool_map(process or _process_batch, batches(), workers, _init_worker,
                                (bbox, t0, t1, keep_ground)):
        for off, size, light, fp, legs in res:
            if light is None:
                n_bad += 1
                continue
            ti = len(traces)
            traces.append([light["icao"], off, size, light.get("t")])
            for c, (a, b, m) in fp.items():
                arr = cells.get(c)
                if arr is None:
                    arr = cells[c] = array("q")
                arr.extend((ti, a, b, m))   # packed: ~32 B per (trace, cell)
            if legs:
                found.append((light, legs))
        del res
    total = sum(sizes) or 1
    if ts.skipped_bytes > MAX_TAR_LOSS * total:
        raise CorruptTar(f"{release}: {ts.skipped_bytes/1e6:.0f} MB of {total/1e6:.0f} MB unparseable "
                         f"({ts.resyncs} corrupt tar header(s)); more than {MAX_TAR_LOSS:.0%}, not publishing")
    head = {"tag": tag, "day": str(day), "day0": int(dt.datetime(day.year, day.month, day.day,
                                                                tzinfo=dt.timezone.utc).timestamp()),
            "cell_deg": CELL, "release": release, "repo": f"globe_history_{repo}",
            "parts": [[u, s] for (u, _), s in zip(parts, sizes)],
            "n_bad_members": n_bad, "n_corrupt": n_bad, "tar_resyncs": ts.resyncs,
            "tar_skipped_bytes": ts.skipped_bytes, "tar_resync_failed": ts.resync_failed, "traces": traces}
    os.makedirs(cache, exist_ok=True)
    p = os.path.join(cache, f"{tag}.idx.json.gz")
    with gzip.open(p + ".tmp", "wt", encoding="utf-8") as f:  # cells written one by one (no giant list copy)
        f.write(json.dumps(head, separators=(",", ":"))[:-1] + ',"cells":{')
        for i, (k, v) in enumerate(cells.items()):  # flat [ti, tmin, tmax, minalt_ft]*n
            f.write(("," if i else "") + f'"{k}":' + json.dumps(v.tolist(), separators=(",", ":")))
        f.write("}}")
    os.replace(p + ".tmp", p)
    with open(os.path.join(cache, f"{tag}.counts.json"), "w", encoding="utf-8") as f:
        json.dump({"n_traces": len(traces), "bytes": sum(sizes)}, f)
    log(f"{tag}: indexed {len(traces)} traces -> {p} ({os.path.getsize(p)/1e6:.1f} MB)"
        + (f", {n_bad} unreadable members" if n_bad else "")
        + (f", {ts.resyncs} corrupt tar header(s) ({ts.skipped_bytes/1e6:.1f} MB skipped)" if ts.resyncs else ""))
    return found


def range_get(session, url, start, end):
    for attempt in range(4):
        try:
            r = session.get(url, headers={"Range": f"bytes={start}-{end}"}, timeout=60)
            if r.status_code == 206:
                return r.content
            if r.status_code in (401, 403):  # signed URL expired
                raise PermissionError
            r.raise_for_status()
        except requests.RequestException:
            time.sleep(1 + attempt)
    raise RuntimeError(f"range {start}-{end} failed")


def index_day(session, idx, bbox, t0, t1, max_alt_ft, log, keep_ground):
    """Use a cached index: select traces then fetch them with Range requests."""
    want = {}
    for c in cells_for_bbox(*bbox):
        flat = idx["cells"].get(str(c), ())
        for ti, a, b, m in zip(flat[0::4], flat[1::4], flat[2::4], flat[3::4]):
            if b >= t0 and a <= t1 and m <= max_alt_ft:
                want[ti] = True
    sel = sorted(want)
    log(f"{idx['tag']}: index selects {len(sel)} traces")
    if not sel:
        return []
    starts = [0]
    for _, s in idx["parts"][:-1]:
        starts.append(starts[-1] + s)
    signed = [resolve(session, u)[0] for u, _ in idx["parts"]]

    def get(ti):
        icao, off, size, _ = idx["traces"][ti]
        out = b""
        lo, hi = off, off + size  # global [lo, hi)
        for k, (st, (_, ps)) in enumerate(zip(starts, idx["parts"])):
            a, b = max(lo, st), min(hi, st + ps)
            if a < b:
                out += range_get(session, signed[k], a - st, b - st - 1)
        return out

    t = time.time()
    found, nbytes = [], 0
    with ThreadPoolExecutor(8) as ex:
        for data in ex.map(get, sel):  # parsed as they arrive, raw blobs released one by one
            nbytes += len(data)
            d = json.loads(gzip.decompress(data))
            legs = extract(d, bbox, t0, t1, keep_ground)
            if legs:
                found.append((light_of(d), legs))
    log(f"  fetched {nbytes/1e6:.2f} MB in {len(sel)} range requests, {time.time()-t:.1f}s")
    return found


# ----------------------------------------------------------------- contract conversion
def load_types():
    p = os.path.join(ROOT, "web", "data", "types.json")
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except OSError:
        return {}


def to_contract(found, types, geoid, max_alt_m):
    # 1) geoid + calibration pairs (geom_msl - baro) for baro-only points
    allpts = [q for _, legs in found for leg in legs for q in leg]
    if not allpts:
        return [], {"alt_src": {}, "baro_offset_median_m": None, "n_cal_pairs": 0}
    lat = np.array([q.lat for q in allpts])
    lon = np.array([q.lon for q in allpts])
    N = np.asarray(geoid.N(lat, lon), float).tolist()  # same order as allpts (consumed in the loop below)
    del lat, lon
    pairs_t, pairs_d = [], []
    for q, n in zip(allpts, N):
        if q.geom is not None and q.baro is not None and q.baro < CAL_MAX_BARO_FT:
            pairs_t.append(q.t)
            pairs_d.append(q.geom * FT - n - q.baro * FT)
    pairs_t = np.array(pairs_t)
    pairs_d = np.array(pairs_d)
    order = np.argsort(pairs_t)
    pairs_t, pairs_d = pairs_t[order], pairs_d[order]

    def baro_offset(t):
        if len(pairs_t) < 5:
            return None
        i0, i1 = np.searchsorted(pairs_t, [t - 1800, t + 1800])
        if i1 - i0 < 5:
            return float(np.median(pairs_d))
        return float(np.median(pairs_d[i0:i1]))

    del allpts
    nit = iter(N)
    off_cache = {}
    tracks, stats = [], {"alt_src": {"geom": 0, "baro_cal": 0, "baro_raw": 0, "ground": 0}}
    for d, legs in found:
        icao = d.get("icao")
        typ = d.get("t") or None
        cat = (types.get(typ) or ["unknown"])[0] if typ else "unknown"
        if cat == "unknown":  # fall back on ADS-B emitter category A7 = rotorcraft
            if d.get("A7"):
                cat = "heli"
        for leg in legs:
            pts, srcs, vel = [], set(), []
            for q in leg:
                n = next(nit)
                if q.ground:
                    alt = None  # on ground: no altitude; caller adds DEM if needed
                    stats["alt_src"]["ground"] += 1
                elif q.geom is not None:
                    alt = q.geom * FT - n
                    stats["alt_src"]["geom"] += 1
                else:
                    k = int(q.t // 300)
                    if k not in off_cache:
                        off_cache[k] = baro_offset(q.t)
                    o = off_cache[k]
                    alt = q.baro * FT + (o or 0.0)
                    stats["alt_src"]["baro_cal" if o is not None else "baro_raw"] += 1
                if alt is None:
                    continue
                if q.src:
                    srcs.add(q.src)
                pts.append([round(q.t, 2), round(q.lat, 6), round(q.lon, 6), round(alt, 1)])
                g, tk, v = q.gs, q.trk, q.vr
                vel.append([round(g * 0.514444, 2) if g is not None else None, round(tk, 1) if tk is not None else None,
                            round(v * 0.00508, 2) if v is not None else None])
            if len(pts) < 2:
                continue
            if max_alt_m is not None and min(p[3] for p in pts) > max_alt_m:
                continue
            cs = next((q.cs for q in reversed(leg) if q.cs), None)
            tracks.append({"id": f"{icao}_{int(pts[0][0])}", "icao24": icao, "callsign": cs, "type": typ,
                           "category": cat, "points": pts,
                           # extras (not in contract, ignorable)
                           "reg": d.get("r"), "desc": d.get("desc"), "sources": sorted(srcs),
                           # D15 optional: reported velocity per point [gs m/s, track deg true, vrate m/s] (nulls allowed)
                           **({"vel": vel} if any(x[0] is not None for x in vel) else {})})
    tracks.sort(key=lambda tr: tr["points"][0][0])
    stats["baro_offset_median_m"] = float(np.median(pairs_d)) if len(pairs_d) else None
    stats["n_cal_pairs"] = int(len(pairs_d))
    return tracks, stats


def merge_feeds(found_lists):
    """found_lists in feed order (prod first).  A later feed (mlatonly) only contributes aircraft that the
    earlier feeds did not have in the bbox/window (same rule as web/engine/adsb.js)."""
    seen, out = set(), []
    for found in found_lists:
        new = set()
        for d, legs in found:
            if d.get("icao") in seen:
                continue
            out.append((d, legs))
            new.add(d.get("icao"))
        seen |= new
    return out


def summarize(tracks, log):
    if not tracks:
        log("no tracks")
        return {}
    dts = np.concatenate([np.diff([p[0] for p in tr["points"]]) for tr in tracks if len(tr["points"]) > 1])
    alts = np.array([p[3] for tr in tracks for p in tr["points"]])
    cats = {}
    for tr in tracks:
        cats[tr["category"]] = cats.get(tr["category"], 0) + 1
    s = {"n_tracks": len(tracks), "n_points": int(alts.size), "categories": cats,
         "dt_s_percentiles_10_50_90_99": [round(float(x), 2) for x in np.percentile(dts, [10, 50, 90, 99])],
         "alt_m_msl_min_median_max": [round(float(x)) for x in (alts.min(), np.median(alts), alts.max())],
         "n_tracks_below_1500m": sum(1 for tr in tracks if min(p[3] for p in tr["points"]) < 1500)}
    log(json.dumps(s))
    return s


# ----------------------------------------------------------------- day completeness
# Prod trace counts of complete days measured 2026-11 (used only when no neighbouring day is cached).
NOMINAL_PROD_TRACES = [("2023-12-17", 41515), ("2024-02-17", 43867), ("2024-07-09", 61584), ("2025-09-08", 73316),
                       ("2026-05-16", 64489), ("2026-09-08", 79049), ("2026-11-01", 56670)]
PARTIAL_RATIO = {"prod": 0.65, "mlatonly": 0.2, "staging": 0.65}  # mlatonly size varies a lot from day to day
_COUNT_CACHE = {}


def index_counts(path):
    """(n_traces, total_bytes) of a cached index, memoised."""
    if path not in _COUNT_CACHE:
        try:
            with gzip.open(path, "rt", encoding="utf-8") as f:
                d = json.load(f)
            _COUNT_CACHE[path] = (len(d["traces"]), sum(sz for _, sz in d["parts"]))
        except (OSError, ValueError, KeyError):
            _COUNT_CACHE[path] = (None, None)
    return _COUNT_CACHE[path]


def _day_of(path):
    try:
        return dt.date.fromisoformat(os.path.basename(path)[1:11].replace(".", "-"))
    except ValueError:
        return None


def reference_traces(day, feed, cache=DEFAULT_CACHE, window_days=200):
    """Expected trace count: median of other cached days of the same feed within +-window_days, else the table."""
    per_day = {}  # <tag>.counts.json (cheap; kept after the index is deleted) else the index itself
    for pat in (f"v*-planes-readsb-{feed}-0.idx.json.gz", f"v*-planes-readsb-{feed}-0.counts.json"):
        for p in glob.glob(os.path.join(cache, pat)):
            d2 = _day_of(p)
            if d2 is None or d2 == day or abs((d2 - day).days) > window_days:
                continue
            if p.endswith(".counts.json"):
                try:
                    with open(p, encoding="utf-8") as f:
                        n = json.load(f)["n_traces"]
                except (OSError, ValueError, KeyError):
                    n = None
            elif d2 in per_day:
                continue
            else:
                n, _ = index_counts(p)
            if n:
                per_day[d2] = n
    vals = list(per_day.values())
    if vals:
        return float(np.median(vals)), f"median of {len(vals)} cached day(s) within {window_days} d"
    if feed != "prod":
        return None, "no reference"
    xs = [dt.date.fromisoformat(a).toordinal() for a, _ in NOMINAL_PROD_TRACES]
    return float(np.interp(day.toordinal(), xs, [b for _, b in NOMINAL_PROD_TRACES])), "nominal table"


def corruption_status(st, n_traces, n_corrupt=0, skipped_bytes=0, size_bytes=0, resync_failed=False):
    """Fold upstream corruption into a day_status dict: records n_corrupt / tar_skipped_bytes and downgrades "ok" to
    "partial" if > PARTIAL_LOSS of the traces (or bytes) were lost, or a tar resync never found its way back."""
    if not (n_corrupt or skipped_bytes or resync_failed):
        return st
    st.update(n_corrupt=n_corrupt, tar_skipped_bytes=skipped_bytes)
    lost = max(n_corrupt / max(1, n_traces + n_corrupt), skipped_bytes / max(1, size_bytes))
    msg = (f"upstream release corrupt: {n_corrupt} unreadable trace(s), {skipped_bytes/1e6:.1f} MB of tar skipped"
           + (" (unrecoverable to the end)" if resync_failed else ""))
    st["note"] = f"{st['note']}; {msg}" if st.get("note") else msg
    if st.get("status") == "ok" and (lost > PARTIAL_LOSS or resync_failed):
        st["status"] = "partial"
    return st


def day_status(day, feed, n_traces, size_bytes, cache=DEFAULT_CACHE, missing=False, note=None):
    """{'day','feed','status': ok|partial|empty|missing, 'n_traces','gb', 'ref_traces','ratio', 'note'}"""
    st = {"day": str(day), "feed": feed, "n_traces": n_traces, "gb": round((size_bytes or 0) / 1e9, 2)}
    if missing:
        return {**st, "status": "missing", "note": note}
    if not n_traces:
        return {**st, "status": "empty", "note": "release contains no traces"}
    ref, how = reference_traces(day, feed, cache)
    st.update(ref_traces=None if ref is None else int(ref), ref_source=how, status="ok")
    if ref:
        st["ratio"] = round(n_traces / ref, 2)
        if n_traces < PARTIAL_RATIO.get(feed, 0.65) * ref:
            st["status"] = "partial"
            st["note"] = f"{n_traces} traces vs ~{int(ref)} expected: receivers/aggregator were down part of the day"
    return st


# ----------------------------------------------------------------- coverage check
def coverage_from_tracks(tracks, t0, t1, center=None, radius_km=None, max_alt_m=1500.0, bin_s=3600):
    """Low non-jet traffic actually received: per hour bin, tracks / aircraft with >= 1 point below max_alt_m (MSL)
    inside [t0, t1] (and within radius_km of center=(lat, lon) if given).  Same as web/engine/adsb.js coverage()."""
    nb = max(1, int(math.ceil((t1 - t0) / bin_s)))
    bins = [{"t_start": t0 + i * bin_s, "n_tracks": 0, "ac": set()} for i in range(nb)]
    allac, ntr = set(), 0
    coslat = math.cos(math.radians(center[0])) if center else 1.0
    for tr in tracks:
        if tr.get("category") == "jet":
            continue
        hit = set()
        for t, la, lo, alt in (p[:4] for p in tr["points"]):
            if t < t0 or t > t1 or alt is None or alt >= max_alt_m:
                continue
            if center is not None and radius_km is not None:
                dy = (la - center[0]) * 111.195
                dx = (lo - center[1]) * 111.195 * coslat
                if dx * dx + dy * dy > radius_km * radius_km:
                    continue
            hit.add(min(nb - 1, int((t - t0) // bin_s)))
        if hit:
            ntr += 1
            allac.add(tr["icao24"])
            for b in hit:
                bins[b]["n_tracks"] += 1
                bins[b]["ac"].add(tr["icao24"])
    hours = max((t1 - t0) / 3600.0, 1e-9)
    return {"t0": t0, "t1": t1, "center": list(center) if center else None, "radius_km": radius_km,
            "max_alt_m": max_alt_m, "n_tracks": ntr, "n_aircraft": len(allac), "tracks_per_h": round(ntr / hours, 2),
            "per_bin": [{"t_start": b["t_start"], "n_tracks": b["n_tracks"], "n_aircraft": len(b["ac"])}
                        for b in bins]}


def coverage_from_index(idx, bbox, t0, t1, types=None, max_alt_ft=5000):
    """Cheap and coarse (0.5 deg cells, nothing downloaded): non-jet traces whose lowest airborne altitude in a
    bbox cell is below max_alt_ft (baro) and whose time span in that cell overlaps the window."""
    types = types if types is not None else load_types()
    seen = set()
    for c in cells_for_bbox(*bbox):
        flat = idx["cells"].get(str(c), ())
        for ti, a, b, m in zip(flat[0::4], flat[1::4], flat[2::4], flat[3::4]):
            if b >= t0 and a <= t1 and 0 < m <= max_alt_ft:  # m == 0 means the only low points were on ground
                typ = idx["traces"][ti][3]
                if (types.get(typ) or ["unknown"])[0] != "jet":
                    seen.add(ti)
    return len(seen)


def coverage_baseline(bbox, t0, t1, cache=DEFAULT_CACHE, feed="prod", exclude_day=None, max_alt_ft=5000,
                      max_days=12):
    """Coarse counts at the same UTC time of day on other cached days (index only; ~1 s per day)."""
    types = load_types()
    span, tod = t1 - t0, t0 % 86400
    paths = [p for p in glob.glob(os.path.join(cache, f"v*-planes-readsb-{feed}-0.idx.json.gz"))
             if _day_of(p) not in (None, exclude_day)]
    ref = exclude_day or dt.datetime.fromtimestamp(t0, dt.timezone.utc).date()
    paths.sort(key=lambda p: abs((_day_of(p) - ref).days))
    out = []
    for p in paths[:max_days]:
        with gzip.open(p, "rt", encoding="utf-8") as f:
            idx = json.load(f)
        d0 = idx["day0"]
        out.append({"day": str(_day_of(p)), "n_coarse": coverage_from_index(idx, bbox, d0 + tod, d0 + tod + span,
                                                                              types, max_alt_ft)})
    return out


COVERAGE_POOR_PER_H = 1.0  # low non-jet tracks per hour near the site (5 km, < 1500 m MSL): < 1 poor, 1-3 weak,
COVERAGE_OK_PER_H = 3.0    # > 3 ok.  Rates, not counts: 4 aircraft in 4.5 h (Egelsbach 2023-09-12) is poor.
NO_ADSB_NOTE = ("Aircraft without ADS-B (many GA in the circuit) cannot be matched; marking only flyovers likely to be "
                "transponder-equipped (louder/faster, overflying rather than circuit traffic) helps.")


def coverage_verdict(cov, coarse_today=None, baseline=None, day_statuses=()):
    """level from the per-hour rate of low non-jet tracks near the site within the recording's plausible window
    (pass only that window as t0/t1): < 1/h poor, 1-3/h weak, > 3/h ok.  Also 'poor' if the coarse count is
    < 25 % of the baseline median or the prod release is partial/empty.  messages are ready to show in the UI."""
    msgs, level = [], "ok"
    rate = cov["tracks_per_h"]
    r = f" within {cov['radius_km']:g} km" if cov.get("radius_km") else ""
    hrs = (cov["t1"] - cov["t0"]) / 3600.0
    what = (f"{cov['n_tracks']} low light-aircraft track(s) / {cov['n_aircraft']} aircraft received{r} below "
            f"{cov['max_alt_m']:g} m MSL in {hrs:.1f} h ({rate:.1f}/h)")
    if rate < COVERAGE_POOR_PER_H:
        level = "poor"
        msgs.append(f"ADS-B coverage of low-flying aircraft here on that date is poor: {what}; results are unlikely. "
                    + NO_ADSB_NOTE)
    elif rate <= COVERAGE_OK_PER_H:
        level = "weak"
        msgs.append(f"ADS-B coverage of low-flying aircraft is weak: {what}. " + NO_ADSB_NOTE)
    if baseline and coarse_today is not None:
        med = float(np.median([b["n_coarse"] for b in baseline]))
        if med > 0 and coarse_today < 0.25 * med:
            level = "poor"
            msgs.append(f"Only {coarse_today} low non-jets in the area vs a median of {med:g} on {len(baseline)} "
                        f"other day(s) at the same time: receivers or the archive were probably down.")
    for d in day_statuses:
        if d["status"] in ("partial", "empty") and d["feed"] == "prod":
            level = "poor"
            msgs.append(f"adsb.lol archive for {d['day']} is {d['status']} ({d.get('note', '')}).")
        elif d["status"] in ("partial", "empty", "missing"):
            msgs.append(f"adsb.lol {d['feed']} feed for {d['day']} is {d['status']} (MLAT-only aircraft may be missing).")
    return {"level": level, "messages": msgs}


def coverage_report(tracks, bbox, t0, t1, site=None, radius_km=5.0, cache=DEFAULT_CACHE, day_statuses=()):
    """Everything the UI needs: exact per-hour counts near the site + coarse count vs baseline + verdict."""
    cov = coverage_from_tracks(tracks, t0, t1, center=site, radius_km=radius_km if site else None)
    d0 = dt.datetime.fromtimestamp(t0, dt.timezone.utc).date()
    p0 = os.path.join(cache, f"{tag_for(d0, 'prod')}.idx.json.gz")
    coarse = base = None
    if os.path.exists(p0) and t1 - t0 <= 86400:
        with gzip.open(p0, "rt", encoding="utf-8") as f:
            i0 = json.load(f)
        coarse = coverage_from_index(i0, bbox, t0, t1)
        del i0
        base = coverage_baseline(bbox, t0, t1, cache, exclude_day=d0)
    return {**cov, "coarse_today": coarse, "baseline": base,
            "verdict": coverage_verdict(cov, coarse, base, day_statuses)}


# ----------------------------------------------------------------- main
def fetch(bbox, t0, t1, feeds=("prod", "mlatonly"), cache=DEFAULT_CACHE, max_alt_ft=20000,
          max_alt_m=None, keep_ground=False, log=print):
    s = requests.Session()
    s.headers.update(UA)
    day = dt.datetime.fromtimestamp(t0, dt.timezone.utc).date()
    last = dt.datetime.fromtimestamp(t1, dt.timezone.utc).date()
    found, days = [], []
    while day <= last:
        per_feed = []  # feeds of ONE day; merged per day so an aircraft flying on both days keeps both
        for feed in feeds:
            tag = tag_for(day, feed)
            p = os.path.join(cache, f"{tag}.idx.json.gz")
            miss = os.path.join(cache, f"{tag}.missing")
            try:
                if os.path.exists(miss):
                    with open(miss, encoding="utf-8") as f:
                        raise MissingRelease(f.read().strip())
                if not os.path.exists(p):
                    per_feed.append(stream_day(s, day, feed, bbox, t0, t1, cache, log, keep_ground))
                    n, size = index_counts(p)
                else:
                    with gzip.open(p, "rt", encoding="utf-8") as f:
                        idx = json.load(f)
                    per_feed.append(index_day(s, idx, bbox, t0, t1, max_alt_ft, log, keep_ground))
                    n, size = len(idx["traces"]), sum(sz for _, sz in idx["parts"])
                    del idx
                st = day_status(day, feed, n, size, cache)
            except MissingRelease as e:
                old = day < dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=2)
                if old and not os.path.exists(miss) and not isinstance(e, IncompleteRelease):  # don't ask again
                    os.makedirs(cache, exist_ok=True)
                    with open(miss, "w", encoding="utf-8") as f:
                        f.write(str(e))
                st = day_status(day, feed, 0, 0, cache, missing=True, note=str(e))
            if st["status"] != "ok":
                log(f"WARNING {tag}: {st['status']} "
                    + json.dumps({k: v for k, v in st.items() if k not in ("day", "feed", "status")}))
            days.append(st)
        found += merge_feeds(per_feed)
        day += dt.timedelta(days=1)
    tracks, stats = to_contract(found, load_types(), Geoid(), max_alt_m)
    stats["days"] = days
    stats["warnings"] = [f"{d['day']} {d['feed']}: {d['status']}" for d in days if d["status"] != "ok"]
    return tracks, stats


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--bbox", help="lat1,lon1,lat2,lon2")
    ap.add_argument("--start", help="ISO UTC (e.g. 2026-11-01T08:00Z) or unix")
    ap.add_argument("--end")
    ap.add_argument("--out")
    ap.add_argument("--meta", help="fixtures/real/<case>/meta.json providing bbox/start/end (out defaults next to it)")
    ap.add_argument("--feeds", default="prod,mlatonly")
    ap.add_argument("--cache", default=DEFAULT_CACHE)
    ap.add_argument("--max-alt-m", type=float, default=None, help="drop tracks whose lowest point is above this")
    ap.add_argument("--max-alt-ft", type=float, default=20000,
                    help="index mode: skip traces never below this (ft, baro) inside the bbox cells")
    ap.add_argument("--keep-ground", action="store_true")
    ap.add_argument("--site", help="lat,lon for the coverage check (default: bbox centre)")
    ap.add_argument("--site-radius-km", type=float, default=5.0)
    a = ap.parse_args(argv)
    bbox = start = end = out = None
    if a.meta:
        with open(a.meta, encoding="utf-8") as f:
            m = json.load(f)
        bbox = m.get("bbox")
        w = m.get("date_utc_window") or m.get("utc_window") or m.get("window") or [m.get("start"), m.get("end")]
        start, end = w[0], w[1]
        out = os.path.join(os.path.dirname(a.meta), "tracks.json")
    if a.bbox:
        bbox = [float(x) for x in a.bbox.split(",")]
    start = a.start or start
    end = a.end or end
    out = a.out or out
    if isinstance(bbox, dict):
        bbox = [bbox["lat_min"], bbox["lon_min"], bbox["lat_max"], bbox["lon_max"]]
    if not (bbox and start and end and out):
        ap.error("need --bbox --start --end --out (or --meta)")
    la1, lo1, la2, lo2 = bbox
    bbox = (min(la1, la2), min(lo1, lo2), max(la1, la2), max(lo1, lo2))
    t0, t1 = parse_time(str(start)), parse_time(str(end))
    t = time.time()
    tracks, stats = fetch(bbox, t0, t1, feeds=a.feeds.split(","), cache=a.cache,
                          max_alt_ft=a.max_alt_ft, max_alt_m=a.max_alt_m, keep_ground=a.keep_ground)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(tracks, f, separators=(",", ":"))
    summ = summarize(tracks, print)
    site = tuple(map(float, a.site.split(","))) if a.site else ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)
    cov = coverage_report(tracks, bbox, t0, t1, site, a.site_radius_km, a.cache, stats.get("days", ()))
    for m_ in cov["verdict"]["messages"]:
        print("WARNING coverage:", m_)
    meta = {"bbox": bbox, "t0": t0, "t1": t1, "feeds": a.feeds, "elapsed_s": round(time.time() - t, 1),
            "source": "adsb.lol globe_history (ODbL 1.0)", **stats, "summary": summ, "coverage": cov}
    with open(os.path.splitext(out)[0] + ".info.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
    print(f"wrote {len(tracks)} tracks -> {out}")


if __name__ == "__main__":
    sys.exit(main())
