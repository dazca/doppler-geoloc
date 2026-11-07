"""Write blind.json for a V2 case: region centre offset 5-10 km at a random bearing from the truth (truth is read
here ONLY to place the offset; the runner never sees it), time window, events with seeds.
usage: python -P mkblind.py <case_dir> <events.json> <t0_unix> <t1_unix> [seed]"""
import sys, json, math, random, os
case, evf, t0, t1 = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
rnd = random.Random(int(sys.argv[5]) if len(sys.argv) > 5 else hash(case) & 0xffff)
meta = json.load(open(os.path.join(case, "meta.json")))
d, b = rnd.uniform(5000, 10000), rnd.uniform(0, 360)
la = meta["true_lat"] + d * math.cos(math.radians(b)) / 111320
lo = meta["true_lon"] + d * math.sin(math.radians(b)) / (111320 * math.cos(math.radians(meta["true_lat"])))
ev = json.load(open(evf))
blind = {"note": ev.get("note", ""), "region": {"center": [round(la, 5), round(lo, 5)], "radius_m": 15000},
         "time": {"t0": t0, "t1": t1}, "tracks_filter": {"maxAltM": 4000}, "segments": ev["segments"]}
json.dump(blind, open(os.path.join(case, "blind.json"), "w"), indent=1)
meta["blind_region_offset"] = {"center": blind["region"]["center"], "offset_m": round(d), "bearing_deg": round(b)}
json.dump(meta, open(os.path.join(case, "meta.json"), "w"), indent=1)
print(blind["region"], round(d), round(b))
