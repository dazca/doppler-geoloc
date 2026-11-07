"""Build the browser aircraft-type lookup (web/data/types.json).

Source: wiedehopf/tar1090-db (the database readsb / adsb.lol / tar1090 use).
  - db/icao_aircraft_types2.js  (gzip JSON) designator -> [name, ICAO Doc 8643 description, WTC]
    e.g. "C172": ["CESSNA 172 Skyhawk", "L1P", "L"]
  - csv branch aircraft.csv.gz  icao24;reg;type;flags;desc;...  (~620k rows)  [only for size stats / optional map]

Doc 8643 description code "L1P" = <aircraft kind><engine count><engine type>
  kind:   L landplane, S seaplane, A amphibian, G gyrocopter, H helicopter, T tiltrotor
  engine: P piston, T turboprop/turboshaft, J jet, E electric, R rocket, - none (glider/balloon)

Contract category: prop | jet | heli | unknown
  H, T(tiltrotor)               -> heli
  engine J                      -> jet
  engine P/T/E (fixed wing, G)  -> prop
  otherwise (gliders, balloons, unknown) -> unknown

Output web/data/types.json:
  {"_": {...meta...}, "C172": ["prop","L1P","L"], ...}    (~60 KB, ~15 KB gzipped)
Optional --icao-map OUT writes {icao24: designator} (big; meant for the Worker, not the page).

Usage: python ref/data/aircraft_types.py [--out web/data/types.json] [--icao-map path.json]
"""
import argparse
import gzip
import io
import json
import os
import sys

import requests

TYPES_URL = "https://raw.githubusercontent.com/wiedehopf/tar1090-db/master/db/icao_aircraft_types2.js"
CSV_URL = "https://raw.githubusercontent.com/wiedehopf/tar1090-db/csv/aircraft.csv.gz"

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def category_from_desc(desc):
    """ICAO Doc 8643 description ('L1P', 'H2T', ...) -> contract category."""
    if not desc or len(desc) < 3:
        return "unknown"
    kind, eng = desc[0], desc[2]
    if kind in "HT":
        return "heli"
    if eng == "J":
        return "jet"
    if eng in "PTE":
        return "prop"
    return "unknown"


def _get(url):
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    b = r.content
    return gzip.decompress(b) if b[:2] == b"\x1f\x8b" else b


def build_types():
    raw = json.loads(_get(TYPES_URL))
    out = {}
    for des, v in sorted(raw.items()):
        name, desc, wtc = (v + [None, None, None])[:3]
        out[des] = [category_from_desc(desc), desc, wtc]
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "web", "data", "types.json"))
    ap.add_argument("--icao-map", help="also write icao24->designator JSON here (large)")
    a = ap.parse_args(argv)

    types = build_types()
    meta = {"source": TYPES_URL, "license": "tar1090-db (see repo); designators per ICAO Doc 8643",
            "format": "designator -> [category, doc8643_desc, wtc]",
            "categories": "prop|jet|heli|unknown"}
    doc = {"_": meta, **types}
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    s = json.dumps(doc, separators=(",", ":"))
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(s)
    cats = {}
    for v in types.values():
        cats[v[0]] = cats.get(v[0], 0) + 1
    print(f"types: {len(types)} designators -> {a.out} ({len(s)/1e3:.1f} KB, "
          f"{len(gzip.compress(s.encode()))/1e3:.1f} KB gz) {cats}")

    if a.icao_map:
        csv = _get(CSV_URL).decode("utf-8", "replace").splitlines()
        m = {}
        for line in csv:
            p = line.split(";")
            if len(p) > 2 and p[2]:
                m[p[0].lower()] = p[2]
        s2 = json.dumps(m, separators=(",", ":"))
        with open(a.icao_map, "w", encoding="utf-8") as f:
            f.write(s2)
        print(f"icao map: {len(m)} entries ({len(csv)} rows) -> {len(s2)/1e6:.1f} MB, "
              f"{len(gzip.compress(s2.encode()))/1e6:.1f} MB gz")


if __name__ == "__main__":
    sys.exit(main())
