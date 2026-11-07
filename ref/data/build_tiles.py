"""Pre-extracted per-cell, per-day track tiles: the fastest browser path (one small request per 0.5 deg cell).

For each 0.5 deg cell touching --bbox and each UTC day: all NON-JET tracks (prop/heli/unknown, any altitude)
clipped to the cell, already in contract format (alt MSL, geoid + baro calibration applied by fetch_adsb.py),
gzip JSON.  Written to <out>/<YYYY-MM-DD>/<cell>.json.gz and served by the Worker at /adsb/tile/<date>/<cell>.json.
The browser merges tracks of the same aircraft across cells (web/engine/adsb.js fetchTracksFromTiles).

  python ref/data/build_tiles.py --bbox 41.2,1.7,41.9,2.5 --date 2026-11-01 --out .cache/tiles
Needs the day already indexed (first fetch_adsb.py run on that day), otherwise it streams the day first.
"""
import argparse
import datetime as dt
import gzip
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_adsb import CELL, DEFAULT_CACHE, LICENSE, cells_for_bbox, fetch  # noqa: E402


def cell_bbox(c):
    i, j = c // 1000 - 180, c % 1000 - 360
    return (i * CELL, j * CELL, (i + 1) * CELL - 1e-9, (j + 1) * CELL - 1e-9)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", required=True)
    ap.add_argument("--date", required=True, action="append", help="UTC day YYYY-MM-DD (repeatable)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--feeds", default="prod,mlatonly")
    ap.add_argument("--cache", default=DEFAULT_CACHE)
    a = ap.parse_args(argv)
    la1, lo1, la2, lo2 = map(float, a.bbox.split(","))
    cells = cells_for_bbox(min(la1, la2), min(lo1, lo2), max(la1, la2), max(lo1, lo2))
    for day in a.date:
        d0 = dt.datetime.fromisoformat(day).replace(tzinfo=dt.timezone.utc).timestamp()
        os.makedirs(os.path.join(a.out, day), exist_ok=True)
        for c in cells:
            t = time.time()
            tracks, _ = fetch(cell_bbox(c), d0, d0 + 86400 - 1e-3, feeds=a.feeds.split(","), cache=a.cache,
                              max_alt_ft=99999, log=lambda *x: None)
            tracks = [tr for tr in tracks if tr["category"] != "jet"]
            for tr in tracks:
                tr.pop("sources", None)
            p = os.path.join(a.out, day, f"{c}.json.gz")
            with gzip.open(p, "wt", encoding="utf-8", compresslevel=9) as f:
                json.dump({"date": day, "cell": c, "cell_deg": CELL, "source": "adsb.lol globe_history (ODbL 1.0)",
                           **LICENSE, "tracks": tracks}, f, separators=(",", ":"))
            print(f"{day} cell {c}: {len(tracks)} non-jet tracks, {sum(len(x['points']) for x in tracks)} pts, "
                  f"{os.path.getsize(p)/1e3:.0f} KB gz, built in {time.time()-t:.1f}s")


if __name__ == "__main__":
    sys.exit(main())
