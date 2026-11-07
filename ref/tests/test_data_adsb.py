"""Lane B: offline tests of the readsb trace -> contract conversion (no network)."""
import json
import os
import sys

from conftest import ROOT

sys.path.insert(0, os.path.join(ROOT, "ref", "data"))
from aircraft_types import category_from_desc  # noqa: E402
from fetch_adsb import cells_for_bbox, cell_id, extract, footprint, light_of, to_contract  # noqa: E402


class FakeGeoid:
    def N(self, lat, lon):
        import numpy as np
        return np.full(len(lat), 50.0)


def trace():
    # [dt, lat, lon, alt_baro_ft, gs, track, flags, vrate, extra, source, alt_geom_ft]
    return {"icao": "abc123", "t": "C172", "r": "EC-XXX", "desc": "CESSNA 172", "timestamp": 1000.0, "trace": [
        [0, 41.50, 2.10, 1000, 90, 0, 0, None, {"flight": "ECXXX  ", "category": "A1"}, "adsb_icao", 1100],
        [2, 41.51, 2.10, 1000, 90, 0, 0, None, None, "adsb_icao", 1100],
        [4, 41.52, 2.10, 1000, 90, 0, 0, None, None, "mlat", None],          # baro only
        [6, 41.53, 2.10, "ground", 0, 0, 0, None, None, "adsb_icao", None],  # dropped
        [900, 41.54, 2.10, 1000, 90, 0, 0, None, None, "adsb_icao", 1100],    # after gap -> new leg
        [902, 41.55, 2.10, 1000, 90, 0, 0, None, None, "adsb_icao", 1100],
        [904, 45.00, 2.10, 1000, 90, 0, 0, None, None, "adsb_icao", 1100],    # outside bbox
    ]}


def test_category_codes():
    assert category_from_desc("L1P") == "prop"
    assert category_from_desc("L2T") == "prop"
    assert category_from_desc("L2J") == "jet"
    assert category_from_desc("H1T") == "heli"
    assert category_from_desc("L0-") == "unknown"


def test_extract_and_contract():
    d = trace()
    legs = extract(d, (41.0, 2.0, 42.0, 2.5), 0, 1e10)
    assert [len(l) for l in legs] == [3, 2]
    types = json.load(open(os.path.join(ROOT, "web", "data", "types.json"), encoding="utf-8"))
    tracks, stats = to_contract([(light_of(d), legs)], types, FakeGeoid(), None)
    assert len(tracks) == 2
    t = tracks[0]
    assert t["category"] == "prop" and t["callsign"] == "ECXXX" and t["type"] == "C172"
    assert t["points"][0][:3] == [1000.0, 41.5, 2.1]
    assert abs(t["points"][0][3] - (1100 * 0.3048 - 50)) < 0.11      # geometric - geoid
    # only 4 (geom, baro) pairs < 5 needed for calibration -> raw pressure altitude
    assert abs(t["points"][2][3] - 1000 * 0.3048) < 0.11
    assert stats["alt_src"]["baro_raw"] == 1
    # with enough pairs the baro-only point gets median(geom_msl - baro) = 100 ft - 50 m
    many = [(light_of(d), legs)] * 3
    tracks, stats = to_contract(many, types, FakeGeoid(), None)
    assert abs(tracks[0]["points"][2][3] - (1100 * 0.3048 - 50)) < 0.11
    assert stats["alt_src"]["baro_cal"] == 3


def test_cells():
    assert cell_id(41.52, 2.1) in cells_for_bbox(41.2, 1.7, 41.9, 2.5)
    fp = footprint(trace())
    assert min(v[2] for v in fp.values()) == 0  # ground point counts as 0 ft


# ---------------------------------------------------------------- B2 fixes: missing / partial days, coverage
import datetime as dt  # noqa: E402
import gzip  # noqa: E402

import fetch_adsb as fa  # noqa: E402


def _fake_index(cache, day, feed, n, cells=None):
    tag = fa.tag_for(day, feed)
    idx = {"tag": tag, "day": str(day), "day0": int(dt.datetime(day.year, day.month, day.day,
                                                               tzinfo=dt.timezone.utc).timestamp()),
           "cell_deg": 0.5, "parts": [["u", 1000]], "traces": [["%06x" % i, i, 10, "C172"] for i in range(n)],
           "cells": cells or {}}
    with gzip.open(os.path.join(cache, f"{tag}.idx.json.gz"), "wt", encoding="utf-8") as f:
        json.dump(idx, f)
    fa._COUNT_CACHE.clear()
    return idx


def test_partial_and_empty_day_status(tmp_path):
    c = str(tmp_path)
    for k, n in ((-30, 70000), (-10, 72000), (20, 74000)):
        _fake_index(c, dt.date(2026, 6, 11) + dt.timedelta(days=k), "prod", n)
    st = fa.day_status(dt.date(2026, 6, 11), "prod", 42314, 1.52e9, c)
    assert st["status"] == "partial" and st["ref_traces"] == 72000 and st["ratio"] == 0.59
    assert fa.day_status(dt.date(2026, 6, 12), "prod", 70500, 3e9, c)["status"] == "ok"
    assert fa.day_status(dt.date(2026, 6, 11), "mlatonly", 0, 0, c)["status"] == "empty"
    # no neighbour cached -> nominal table (2026-06 ~ 70k): 42k is still partial
    assert fa.day_status(dt.date(2026, 6, 11), "prod", 42314, 1.5e9, str(tmp_path / "none"))["status"] == "partial"


def test_missing_mlatonly_release_is_a_warning_not_fatal(tmp_path, monkeypatch):
    c = str(tmp_path)
    day = dt.date(2023, 12, 17)
    _fake_index(c, day, "prod", 41515)
    monkeypatch.setattr(fa, "index_day", lambda *a, **k: [])

    def no_release(session, day, feed, *a, **k):
        raise fa.MissingRelease(f"release {fa.tag_for(day, feed)} not found")
    monkeypatch.setattr(fa, "stream_day", no_release)
    t0 = dt.datetime(2023, 12, 17, 9, tzinfo=dt.timezone.utc).timestamp()
    tracks, stats = fa.fetch((41.2, 1.7, 41.9, 2.5), t0, t0 + 3600, cache=c, log=lambda *a: None)
    assert tracks == []
    st = {d["feed"]: d["status"] for d in stats["days"]}
    assert st == {"prod": "ok", "mlatonly": "missing"}
    assert stats["warnings"] == ["2023-12-17 mlatonly: missing"]
    assert os.path.exists(os.path.join(c, "v2023.12.17-planes-readsb-mlatonly-0.missing"))  # not asked again


def _tr(icao, cat, pts):
    return {"id": icao, "icao24": icao, "callsign": None, "type": None, "category": cat, "points": pts}


def test_coverage_from_tracks_synthetic():
    t0 = 1000.0
    site = (41.52, 2.105)
    tracks = [
        _tr("a", "prop", [[t0 + 10, 41.52, 2.105, 300.0], [t0 + 20, 41.53, 2.105, 320.0]]),       # near, low, h0
        _tr("b", "prop", [[t0 + 4000, 41.52, 2.10, 1400.0]]),                                     # near, low, h1
        _tr("c", "jet", [[t0 + 10, 41.52, 2.105, 300.0]]),                                        # jet: ignored
        _tr("d", "heli", [[t0 + 10, 41.80, 2.105, 300.0]]),                                       # 31 km away
        _tr("e", "prop", [[t0 + 10, 41.52, 2.105, 2000.0]]),                                      # too high
    ]
    cov = fa.coverage_from_tracks(tracks, t0, t0 + 7200, center=site, radius_km=5)
    assert (cov["n_tracks"], cov["n_aircraft"]) == (2, 2)
    assert [b["n_aircraft"] for b in cov["per_bin"]] == [1, 1]
    assert fa.coverage_from_tracks(tracks, t0, t0 + 7200)["n_aircraft"] == 3  # no radius: d counts too
    v = fa.coverage_verdict(fa.coverage_from_tracks([], t0, t0 + 3600, site, 5))
    assert v["level"] == "poor" and "0 aircraft received within 5 km" in v["messages"][0]
    assert "without ADS-B" in v["messages"][0]
    assert fa.coverage_verdict(cov)["level"] == "weak"  # 2 tracks in 2 h = 1/h
    v = fa.coverage_verdict(cov, coarse_today=1, baseline=[{"n_coarse": 16}, {"n_coarse": 13}, {"n_coarse": 20}])
    assert v["level"] == "poor"
    v = fa.coverage_verdict(cov, day_statuses=[{"day": "x", "feed": "prod", "status": "partial", "note": "n"}])
    assert v["level"] == "poor"


def test_coverage_on_lell_fixture():
    # Lane K: 47 low non-jet tracks (21 aircraft) within 5 km of LELL on 2026-11-01 07-15 UTC
    tracks = json.load(open(os.path.join(ROOT, "fixtures/real/lell_20261101/tracks.json"), encoding="utf-8"))
    t0 = dt.datetime(2026, 11, 1, 7, tzinfo=dt.timezone.utc).timestamp()
    cov = fa.coverage_from_tracks(tracks, t0, t0 + 8 * 3600, center=(41.5209, 2.105), radius_km=5)
    assert (cov["n_tracks"], cov["n_aircraft"]) == (47, 21)
    assert fa.coverage_verdict(cov)["level"] == "ok"


def test_coverage_rate_thresholds():
    # Lane V2: Egelsbach 2023-09-12, 4 aircraft in 4.5 h (0.9/h) must be poor, not ok
    def cov_n(n, hours):
        trs = [_tr(f"a{i}", "prop", [[60.0 + i * 60, 41.52, 2.105, 300.0]]) for i in range(n)]
        return fa.coverage_from_tracks(trs, 0.0, hours * 3600, center=(41.52, 2.105), radius_km=5)
    assert fa.coverage_verdict(cov_n(4, 4.5))["level"] == "poor"   # 0.9/h
    assert fa.coverage_verdict(cov_n(4, 2))["level"] == "weak"     # 2/h
    assert fa.coverage_verdict(cov_n(6, 2))["level"] == "weak"     # 3/h (boundary: weak)
    assert fa.coverage_verdict(cov_n(7, 2))["level"] == "ok"       # 3.5/h


def test_coverage_from_index_coarse():
    c = str(fa.cell_id(41.52, 2.10))
    idx = {"traces": [["a", 0, 1, "C172"], ["b", 0, 1, "A320"], ["c", 0, 1, "C172"], ["d", 0, 1, "C172"]],
           "cells": {c: [0, 100, 200, 1500, 1, 100, 200, 1500, 2, 100, 200, 30000, 3, 100, 200, 0]}}
    # a: low prop -> counted; b: jet; c: too high; d: ground only
    assert fa.coverage_from_index(idx, (41.2, 1.7, 41.9, 2.5), 150, 160, types={"C172": ["prop"], "A320": ["jet"]}) == 1
