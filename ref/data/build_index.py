"""Split a day index (cache written by fetch_adsb.py STREAM mode) into per-cell shards for the Worker/R2.

  python ref/data/build_index.py .cache/adsb/v2026.11.01-planes-readsb-prod-0.idx.json.gz --out .cache/shards
  # then upload:  npx wrangler r2 object put doppler-adsb-index/<tag>/<cell>.json --file <file>  (per file)
  # or only the cells you need:  --bbox 41.2,1.7,41.9,2.5
Also writes <out>/<tag>/day.json = release completeness (fetch_adsb.day_status: ok|partial|empty|missing), read by
web/engine/adsb.js fetchDayStatus.  Pass a <tag>.missing marker file instead of an index to publish "missing".

Shard  <out>/<tag>/<cell>.json :
  {"tag", "cell", "cell_deg", "geoid_N" (EGM96 at cell centre, m),
   "traces": [[icao, type, part, start_in_part, size, tmin, tmax, min_alt_ft_in_cell], ...]}
  part = "aa" / "ab" ... ; byte range = [start, start+size-1] of <tag>.tar.<part> (one gzip JSON member).
Members that straddle a part boundary (~1 per day) are skipped.
"""
import argparse
import datetime as dt
import gzip
import json
import math
import os
import sys

os.environ.setdefault("PROJ_NETWORK", "ON")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_adsb import CELL, DEFAULT_CACHE, LICENSE, Geoid, cells_for_bbox, day_status, feed_of_tag  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("index")
    ap.add_argument("--out", required=True)
    ap.add_argument("--bbox", help="only cells touching lat1,lon1,lat2,lon2")
    ap.add_argument("--cache", default=DEFAULT_CACHE, help="other cached indexes = reference for partial-day check")
    a = ap.parse_args(argv)
    if a.index.endswith(".missing"):
        tag = os.path.basename(a.index)[:-len(".missing")]
        day = dt.date.fromisoformat(tag[1:11].replace(".", "-"))
        feed = feed_of_tag(tag)
        with open(a.index, encoding="utf-8") as f:
            st = {**day_status(day, feed, 0, 0, a.cache, missing=True, note=f.read().strip()), **LICENSE}
        os.makedirs(os.path.join(a.out, tag), exist_ok=True)
        with open(os.path.join(a.out, tag, "day.json"), "w", encoding="utf-8") as f:
            json.dump(st, f)
        print(f"{tag}: day.json status {st['status']}")
        return
    with gzip.open(a.index, "rt", encoding="utf-8") as f:
        idx = json.load(f)
    tag = idx["tag"]
    day = dt.date.fromisoformat(idx["day"])
    feed = feed_of_tag(tag)
    st = day_status(day, feed, len(idx["traces"]), sum(sz for _, sz in idx["parts"]), a.cache)
    # real release tag / repo (may differ from the canonical <tag>: -0tmp/-1 re-runs, Dec 31 in next year's repo):
    # /adsb/range requests must use these when present
    rel = {k: idx[k] for k in ("release", "repo") if idx.get(k)}
    st.update(rel, **LICENSE)
    os.makedirs(os.path.join(a.out, tag), exist_ok=True)
    with open(os.path.join(a.out, tag, "day.json"), "w", encoding="utf-8") as f:
        json.dump(st, f)
    print(f"{tag}: day.json status {st['status']} ({st.get('ratio')})")
    parts = idx["parts"]
    starts = [0]
    for _, s in parts[:-1]:
        starts.append(starts[-1] + s)
    names = [u.rsplit(".tar", 1)[1].lstrip(".") for u, _ in parts]

    def locate(off, size):
        for k in range(len(parts) - 1, -1, -1):
            if off >= starts[k]:
                if off + size > starts[k] + parts[k][1]:
                    return None
                return names[k], off - starts[k]
        return None

    cells = idx["cells"]
    if a.bbox:
        la1, lo1, la2, lo2 = map(float, a.bbox.split(","))
        keep = {str(c) for c in cells_for_bbox(min(la1, la2), min(lo1, lo2), max(la1, la2), max(lo1, lo2))}
        cells = {k: v for k, v in cells.items() if k in keep}
    geoid = Geoid()
    os.makedirs(os.path.join(a.out, tag), exist_ok=True)
    total, skipped = 0, 0
    for c, entries in cells.items():
        ci = int(c)
        lat = (ci // 1000 - 180 + 0.5) * CELL
        lon = (ci % 1000 - 360 + 0.5) * CELL
        rows = []
        for ti, tmin, tmax, minalt in zip(entries[0::4], entries[1::4], entries[2::4], entries[3::4]):
            icao, off, size, typ = idx["traces"][ti]
            loc = locate(off, size)
            if loc is None:
                skipped += 1
                continue
            rows.append([icao, typ, loc[0], loc[1], size, tmin, tmax, minalt])
        sh = {"tag": tag, **rel, "cell": ci, "cell_deg": CELL,
              "geoid_N": round(float(geoid.N([lat], [lon])[0]), 2), **LICENSE, "traces": rows}
        p = os.path.join(a.out, tag, f"{ci}.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(sh, f, separators=(",", ":"))
        total += os.path.getsize(p)
    print(f"{tag}: {len(cells)} shards, {total/1e6:.1f} MB total, skipped {skipped} straddling entries")


if __name__ == "__main__":
    sys.exit(main())
