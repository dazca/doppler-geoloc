import os, time
import numpy as np
import pytest
from conftest import ROOT
from run_search import run, horiz_err


@pytest.mark.parametrize("name", ["scenario1", "scenario2"])
def test_end_to_end_recovers_observer(name):
    t0 = time.perf_counter()
    sc, r, err = run(name, quiet=True)
    dt = time.perf_counter() - t0
    tru = sc["truth"]
    print(f"\n{name}: grid={r['n_grid']} coarse_survivors={r['n_surv']} err={err:.0f} m "
          f"dT_start={r['best']['t_start_unix'] - tru['t_start_unix']:+.2f} s total={dt:.1f} s "
          f"timings={ {k: round(v, 2) for k, v in r['timings'].items()} }")
    assert r["best"]["flights"] == [e["flight"] for e in tru["events"]]
    assert err < 150.0
    assert abs(r["best"]["t_start_unix"] - tru["t_start_unix"]) < 2.0
