"""Lane F: fetch the raw readsb traces (gs, track, baro/geom alt, ground points) of the KSMO tail numbers.

Uses the byte-offset index already cached by ref/data/fetch_adsb.py (.cache/adsb/*.idx.json.gz) and HTTP Range
requests (a few KB per trace).  Output: ref/validation/cache/ksmo_raw/<feed>_<day>_<icao>.json (decompressed).
"""
import gzip
import json
import os
import sys

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "ref", "data"))
import fetch_adsb as fa  # noqa: E402

OUT = os.path.join(HERE, "cache", "ksmo_raw")
CASE = os.path.join(ROOT, "fixtures", "real", "ksmo_2024-07-09")


def main():
    os.makedirs(OUT, exist_ok=True)
    tracks = json.load(open(os.path.join(CASE, "tracks.json")))
    meta = json.load(open(os.path.join(CASE, "meta.json")))
    import re
    tails = set(re.findall(r"N\d+[A-Z]*", meta["audible_aircraft_notes"]))
    icaos = sorted({t["icao24"] for t in tracks if t.get("reg") in tails})
    print(len(tails), "tails ->", len(icaos), "icao24")
    s = requests.Session()
    s.headers.update(fa.UA)
    for tag in ["v2024.07.09-planes-readsb-prod-0", "v2024.07.10-planes-readsb-prod-0",
                "v2024.07.09-planes-readsb-mlatonly-0", "v2024.07.10-planes-readsb-mlatonly-0"]:
        idx = json.load(gzip.open(os.path.join(ROOT, ".cache", "adsb", tag + ".idx.json.gz")))
        starts = [0]
        for _, sz in idx["parts"][:-1]:
            starts.append(starts[-1] + sz)
        signed = None
        for icao, off, size, typ in idx["traces"]:
            if icao not in icaos:
                continue
            p = os.path.join(OUT, f"{tag}_{icao}.json")
            if os.path.exists(p):
                continue
            if signed is None:
                signed = [fa.resolve(s, u)[0] for u, _ in idx["parts"]]
            blob = b""
            for k, (st, (_, ps)) in enumerate(zip(starts, idx["parts"])):
                a, b = max(off, st), min(off + size, st + ps)
                if a < b:
                    blob += fa.range_get(s, signed[k], a - st, b - st - 1)
            d = json.loads(gzip.decompress(blob))
            json.dump(d, open(p, "w"))
            print(tag, icao, typ, len(d.get("trace", [])), "pts")


if __name__ == "__main__":
    main()
