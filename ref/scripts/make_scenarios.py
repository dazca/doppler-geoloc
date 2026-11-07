"""Generate synthetic scenarios into fixtures/<name>/ ."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from doppler_ref.scenarios import SCENARIOS, build_scenario

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

if __name__ == "__main__":
    names = sys.argv[1:] or list(SCENARIOS)
    for n in names:
        r = build_scenario(SCENARIOS[n], os.path.join(ROOT, "fixtures", n))
        print(n, "observer", r["truth"]["observer"]["lat"], r["truth"]["observer"]["lon"], r["truth"]["observer"]["elev_m"])
        for e in r["truth"]["events"]:
            print("  true", e)
        for e in r["measured"]:
            print("  meas", e)
        for k, v in r["truth"]["all_flights_cpa"].items():
            print("  cpa", k, v)
