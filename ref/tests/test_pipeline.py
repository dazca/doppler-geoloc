"""Data pipeline robustness (ref/data/fetch_adsb.py + daily_job.py): process pool failure, tar truncation and resume,
release discovery, Worker probes, R2 access, manifest merging, --max-time.  No network: everything is faked locally."""
import argparse
import datetime as dt
import gzip
import http.server
import io
import json
import os
import sys
import tarfile
import threading
import time

import pytest
import requests

from conftest import ROOT

sys.path.insert(0, os.path.join(ROOT, "ref", "data"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pool_helpers as ph  # noqa: E402
import daily_job as dj  # noqa: E402
import fetch_adsb as fa  # noqa: E402


@pytest.fixture(autouse=True)
def _no_sleep_no_cache(monkeypatch):
    fa._RELEASE_CACHE.clear()
    monkeypatch.setattr(dj, "_backoff", lambda attempt: None)
    yield
    fa._RELEASE_CACHE.clear()


# ----------------------------------------------------------------- P1: process pool
def test_pool_worker_death_fails_fast():
    t = time.time()
    got = []
    with pytest.raises(fa.PoolFailure, match="worker died"):
        for r in fa.ordered_pool_map(ph.die_on_5, range(40), workers=2, timeout=60):
            got.append(r)
    assert time.time() - t < 45, "must not hang when a worker dies"
    assert got == list(range(len(got))) and len(got) < 40


def test_pool_timeout_fails_fast():
    t = time.time()
    with pytest.raises(fa.PoolFailure, match="took more than"):
        list(fa.ordered_pool_map(ph.slow, range(4), workers=1, timeout=2))
    assert time.time() - t < 30


def test_pool_ordered_and_bounded():
    pulled = []

    def gen():
        for i in range(30):
            pulled.append(i)
            yield i
    out = []
    for r in fa.ordered_pool_map(ph.ident, gen(), workers=2):
        assert len(pulled) - len(out) <= 2 * 2  # never more than 2*workers tasks in flight
        out.append(r)
    assert out == list(range(30))


def _member(icao, pts):
    d = {"icao": icao, "t": "C172", "timestamp": 1000.0,
         "trace": [[i * 2, la, lo, 1000, 90, 0, 0, None, None, "adsb_icao", 1100] for i, (la, lo) in enumerate(pts)]}
    return f"./traces/{icao[-2:]}/trace_full_{icao}.json", gzip.compress(json.dumps(d).encode())


def _tar_bytes(members):
    b = io.BytesIO()
    with tarfile.open(fileobj=b, mode="w", format=tarfile.USTAR_FORMAT) as tf:
        for name, data in members:
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            tf.addfile(ti, io.BytesIO(data))
    return b.getvalue()


class _BytesStreamer(fa.TarStreamer):
    def __init__(self, data, chunk=1000):
        super().__init__(None, [], lambda *a: None)
        self.data, self.chunk = data, chunk

    def chunks(self):
        for i in range(0, len(self.data), self.chunk):
            yield self.data[i:i + self.chunk]


_REL = "v2026.11.06-planes-readsb-prod-1"


def _patch_stream(monkeypatch, members):
    data = _tar_bytes(members)
    monkeypatch.setattr(fa, "find_release", lambda day, feed, s: ([(f"https://x/{_REL}.tar", len(data))], _REL, 2027))
    monkeypatch.setattr(fa, "resolve", lambda s, u: (u, len(data)))
    monkeypatch.setattr(fa, "TarStreamer", lambda s, urls, log: _BytesStreamer(data))


def test_stream_day_worker_death_raises(tmp_path, monkeypatch):
    _patch_stream(monkeypatch, [_member("abc%03d" % i, [(41.5, 2.1), (41.6, 2.1)]) for i in range(200)])
    t = time.time()
    with pytest.raises(fa.PoolFailure):
        fa.stream_day(None, dt.date(2026, 11, 6), "prod", (41, 2, 42, 3), 0, 1e10, str(tmp_path), lambda *a: None,
                      False, workers=2, process=ph.die_batch)
    assert time.time() - t < 60
    assert not os.path.exists(tmp_path / "v2026.11.06-planes-readsb-prod-0.idx.json.gz")  # no half index


def test_stream_day_ok_records_release(tmp_path, monkeypatch):
    _patch_stream(monkeypatch, [_member("abc%03d" % i, [(41.5, 2.1), (41.6, 2.1)]) for i in range(70)]
                  + [_member("fff000", [(50.0, 9.0), (50.1, 9.0)])])
    found = fa.stream_day(None, dt.date(2026, 11, 6), "prod", (41, 2, 42, 3), 0, 1e10, str(tmp_path),
                          lambda *a: None, False, workers=2, process=dj.region_batch)
    assert len(found) == 70 and isinstance(found[0][1][0][0], fa.Pt)
    with gzip.open(tmp_path / "v2026.11.06-planes-readsb-prod-0.idx.json.gz", "rt") as f:
        idx = json.load(f)
    assert len(idx["traces"]) == 71 and idx["release"] == _REL and idx["repo"] == "globe_history_2027"


def test_default_workers_capped():
    assert 1 <= fa.default_workers() <= 4


# ----------------------------------------------------------------- P3: tar truncation
def test_tar_complete_and_truncated():
    data = _tar_bytes([_member("a%05d" % i, [(41.5, 2.1)] * 30) for i in range(5)])
    names = [n for _, n, _ in _BytesStreamer(data).members()]
    assert len(names) == 5
    end = -(-len(data.rstrip(bytes(1))) // 512) * 512  # end of the last member (tarfile pads to 10 KiB records)
    assert len(list(_BytesStreamer(data[:end + 1024]).members())) == 5
    for cut in (len(data) // 2, 700, end, end + 512):  # mid-member, mid-member, no / only one zero block
        with pytest.raises(fa.TruncatedTar):
            list(_BytesStreamer(data[:cut]).members())


# ----------------------------------------------------------------- P4: resume
class _Resp:
    def __init__(self, data, status=200, fail_after=None):
        self.data, self.status_code, self.fail_after = data, status, fail_after

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))

    def iter_content(self, chunk_size):
        for i in range(0, len(self.data), 512):
            if self.fail_after is not None and i >= self.fail_after:
                raise requests.exceptions.ChunkedEncodingError("connection reset")
            yield self.data[i:i + 512]


class _DropSession:
    def __init__(self, data, drops):
        self.data, self.drops, self.ranges = data, drops, []

    def get(self, url, stream=True, timeout=None, headers=None):
        start = int(headers["Range"][6:-1]) if headers and "Range" in headers else 0
        self.ranges.append(start)
        fail = 3000 if len(self.ranges) <= self.drops else None
        return _Resp(self.data[start:], 206 if start else 200, fail)


def test_resume_dropped_download():
    data = _tar_bytes([_member("a%05d" % i, [(41.5, 2.1)] * 30) for i in range(8)])
    s = _DropSession(data, drops=2)
    out = list(fa.TarStreamer(s, [("u", len(data))], lambda *a: None).members())
    assert len(out) == 8 and len(s.ranges) == 3 and s.ranges[0] == 0 and s.ranges[1] > 0
    with pytest.raises(fa.TruncatedTar, match="dropped"):
        big = _tar_bytes([_member("a%05d" % i, [(41.5, 2.1)] * 30) for i in range(80)])
        list(fa.TarStreamer(_DropSession(big, drops=10), [("u", len(big))], lambda *a: None).members())


# ----------------------------------------------------------------- D2/D3/P3/D7: release discovery
class _GH:
    """Fake GitHub: {(repo_year, tag): assets}."""

    def __init__(self, releases, status=None):
        self.releases, self.status, self.calls = releases, status, []

    def get(self, url, headers=None, timeout=None):
        self.calls.append((url, headers))
        r = requests.Response()
        if self.status:
            r.status_code = self.status
            return r
        repo, tag = url.split("/repos/adsblol/")[1].split("/releases/tags/")
        a = self.releases.get((int(repo.rsplit("_", 1)[1]), tag))
        r.status_code = 200 if a is not None else 404
        r._content = json.dumps({"assets": a or []}).encode()
        return r


def _assets(tag, sizes, state="uploaded"):
    return [{"name": f"{tag}.tar.{p}", "size": s, "state": state} for p, s in zip(("aa", "ab", "ac"), sizes)]


def test_release_in_next_years_repo_and_suffix_fallback(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "tok")
    day = dt.date(2025, 12, 31)
    tag = "v2025.12.31-planes-readsb-prod-0tmp"
    gh = _GH({(2026, tag): _assets(tag, [fa.PART, 123])})
    urls, rel, repo = fa.find_release(day, "prod", gh)
    assert rel == tag and repo == 2026
    assert urls[0] == (f"https://github.com/adsblol/globe_history_2026/releases/download/{tag}/{tag}.tar.aa", fa.PART)
    assert all(h["Authorization"] == "Bearer tok" for _, h in gh.calls)
    n = len(gh.calls)
    assert fa.part_urls(day, "prod", gh) == urls and len(gh.calls) == n  # cached from the precheck


def test_release_previous_years_repo():
    tag = "v2024.01.01-planes-readsb-staging-0"
    gh = _GH({(2023, tag): _assets(tag, [5])})
    assert fa.find_release(dt.date(2024, 1, 1), "staging", gh)[2] == 2023


def test_release_incomplete_and_missing():
    tag = "v2026.11.06-planes-readsb-prod-0"
    with pytest.raises(fa.IncompleteRelease, match="uploading"):
        fa.find_release(dt.date(2026, 11, 6), "prod", _GH({(2026, tag): _assets(tag, [fa.PART, 5], "starter")}))
    fa._RELEASE_CACHE.clear()
    with pytest.raises(fa.IncompleteRelease, match="exactly"):
        fa.find_release(dt.date(2026, 11, 6), "prod", _GH({(2026, tag): _assets(tag, [fa.PART, fa.PART])}))
    fa._RELEASE_CACHE.clear()
    with pytest.raises(fa.MissingRelease) as e:
        fa.find_release(dt.date(2023, 2, 20), "prod", _GH({}))
    assert not isinstance(e.value, fa.IncompleteRelease)


def test_release_asset_names_must_be_servable(tmp_path, monkeypatch):
    """review F1: never index a release whose asset names the Worker's /adsb/range cannot rebuild."""
    tag = "v2026.11.05-planes-readsb-prod-0"
    odd = [{"name": f"{tag}.tar.aa", "size": 5, "state": "uploaded"},
           {"name": f"{tag}-extra.tar.ab", "size": 5, "state": "uploaded"}]
    fa._RELEASE_CACHE.clear()
    with pytest.raises(fa.IncompleteRelease, match="not servable"):
        fa.find_release(dt.date(2026, 11, 5), "prod", _GH({(2026, tag): odd}))
    fa._RELEASE_CACHE.clear()
    monkeypatch.setattr(fa, "find_release", lambda d, f, s: ([("https://x/other.tar.aa", 5)], tag, 2026))
    with pytest.raises(fa.IncompleteRelease, match="not servable"):
        fa.stream_day(None, dt.date(2026, 11, 5), "prod", (41, 2, 42, 3), 0, 1e10, str(tmp_path), lambda *a: None, False)


def test_tag_re():
    assert fa.feed_of_tag("v2026.11.06-planes-readsb-mlatonly-0tmp") == "mlatonly"
    assert fa.feed_of_tag("v2026.11.06-planes-readsb-prod-1") == "prod"
    assert fa.TAG_RE.search("x-0tmp") and not fa.TAG_RE.search("x-0tm")


# ----------------------------------------------------------------- D3: prod missing -> day.json "missing"
def test_old_missing_prod_publishes_missing(tmp_path, monkeypatch):
    def none(day, feed, s):
        raise fa.MissingRelease(f"no {feed}")
    monkeypatch.setattr(fa, "find_release", none)
    a = argparse.Namespace(work=str(tmp_path / "w"), cache=str(tmp_path / "c"), workers=1)
    items, stats = dj.build_day(dt.date(2023, 2, 20), a, lambda *x: None)
    assert stats["prod_status"] == "missing" and stats["mlatonly_status"] == "missing"
    dayj = [p for k, p in items if k.endswith("day.json")]
    st = json.load(open(dayj[0], encoding="utf-8"))
    assert st["status"] == "missing" and st["license"] == "ODbL-1.0"
    assert items[-1][0].endswith("day.json") and len(dayj) == 2
    # a recent day is retried instead
    assert dj.build_day(dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1), a, lambda *x: None) is None


def test_incomplete_release_is_retried_even_when_old(tmp_path, monkeypatch):
    def inc(day, feed, s):
        raise fa.IncompleteRelease("uploading")
    monkeypatch.setattr(fa, "find_release", inc)
    a = argparse.Namespace(work=str(tmp_path / "w"), cache=str(tmp_path / "c"), workers=1)
    assert dj.build_day(dt.date(2023, 2, 20), a, lambda *x: None) is None


# ----------------------------------------------------------------- D6: Worker probes
def _fake_get(table):
    def get(url, timeout=None):
        r = requests.Response()
        v = table(url)
        r.status_code = v if isinstance(v, int) else 200
        r._content = json.dumps(v).encode() if not isinstance(v, int) else b""
        return r
    return get


def test_worker_has_raises_on_429_and_5xx(monkeypatch):
    monkeypatch.setattr(dj.time, "sleep", lambda s: None)
    for code in (429, 500, 503):
        monkeypatch.setattr(dj.requests, "get", _fake_get(lambda u: code))
        with pytest.raises(dj.WorkerUnavailable):
            dj.worker_has("https://w", "x/day.json")
    monkeypatch.setattr(dj.requests, "get", _fake_get(lambda u: 404))
    assert dj.worker_has("https://w", "x/day.json") is False


def test_day_done_partial_recent_is_rebuilt(monkeypatch):
    today = dt.date(2026, 11, 7)
    monkeypatch.setattr(dj.requests, "get", _fake_get(lambda u: {"status": "partial"} if "prod" in u else {}))
    assert dj.day_done("https://w", dt.date(2026, 11, 5), today) is False
    assert dj.day_done("https://w", dt.date(2026, 10, 1), today) is True


def test_unreachable_worker_skips_day(monkeypatch, capsys):
    monkeypatch.setattr(dj, "day_done", lambda *a: (_ for _ in ()).throw(dj.WorkerUnavailable("HTTP 503")))
    monkeypatch.setattr(dj, "build_day", lambda *a: pytest.fail("must not rebuild a day the Worker could not check"))
    assert dj.main(["--date", "2026-11-01", "--no-upload"]) == 0
    assert "skipped this run" in capsys.readouterr().out


# ----------------------------------------------------------------- D1/D5: manifest
class _FakeR2:
    def __init__(self, docs=None):
        self.docs = dict(docs or {})
        self.puts = 0

    def install(self, monkeypatch):
        monkeypatch.setattr(dj, "r2_get_json", lambda b, k: json.loads(json.dumps(self.docs[k])) if k in self.docs
                            else None)
        monkeypatch.setattr(dj, "r2_put", self.put)
        return self

    def put(self, b, k, p):
        self.puts += 1
        self.docs[k] = json.load(open(p, encoding="utf-8"))


def _days(d0, n):
    return [str(dt.date.fromisoformat(d0) + dt.timedelta(days=k)) for k in range(n)]


def test_rebuild_manifest_keeps_old_days_and_probes_few(monkeypatch):
    old = _days("2024-01-01", 100) + _days("2026-09-01", 60)      # 2024 days are older than `since`
    r2 = _FakeR2({dj.MANIFEST_KEY: {"days": old}}).install(monkeypatch)
    probed = []

    def listed(worker, d, tries=8):
        probed.append(d)
        if d == dt.date(2026, 10, 20):
            raise dj.WorkerUnavailable("HTTP 503")  # in the manifest + unknown now -> kept
        if d == dt.date(2026, 10, 21):
            return False                            # definitely gone -> removed
        return d >= dt.date(2026, 9, 1)
    monkeypatch.setattr(dj, "day_listed", listed)
    monkeypatch.setattr(dj.time, "sleep", lambda s: None)
    doc = dj.rebuild_manifest("https://w", "b", dt.date(2026, 8, 1), dt.date(2026, 11, 6), lambda *a: None)
    days = set(doc["days"])
    assert set(_days("2024-01-01", 100)) <= days                   # never dropped
    assert "2026-10-20" in days and "2026-10-21" not in days
    assert {"2026-11-01", "2026-11-06"} <= days                    # new days added
    # probed: Aug (not in manifest, 31 d) + the last 35 days; not the 25 older September/October manifest days
    assert len(probed) == 31 + 36
    assert r2.puts == 1


def test_rebuild_manifest_refuses_big_shrink(monkeypatch):
    _FakeR2({dj.MANIFEST_KEY: {"days": _days("2026-10-01", 30)}}).install(monkeypatch)
    monkeypatch.setattr(dj, "day_listed", lambda w, d, tries=8: False)
    with pytest.raises(RuntimeError, match="refusing"):
        dj.rebuild_manifest("https://w", "b", dt.date(2026, 10, 1), dt.date(2026, 10, 30), lambda *a: None,
                            recheck_days=40)


def test_manifest_add_survives_concurrent_writer(monkeypatch):
    r2 = _FakeR2({dj.MANIFEST_KEY: {"days": ["2026-11-01"]}}).install(monkeypatch)
    monkeypatch.setattr(dj.time, "sleep", lambda s: None)
    real_put = r2.put
    raced = []

    def put(b, k, p):
        real_put(b, k, p)
        if not raced:  # another job overwrites our first write with its own read-modify-write
            raced.append(1)
            r2.docs[k] = {"days": ["2026-11-01", "2026-11-03"]}
    monkeypatch.setattr(dj, "r2_put", put)
    dj.manifest_add("b", dt.date(2026, 11, 2), lambda *a: None)
    assert r2.docs[dj.MANIFEST_KEY]["days"] == ["2026-11-01", "2026-11-02", "2026-11-03"]


# ----------------------------------------------------------------- D4 / security: R2 access
class _R2Handler(http.server.BaseHTTPRequestHandler):
    store, log, deny = {}, [], False

    def _key(self):
        return self.path.split("/objects/", 1)[1]

    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        type(self).log.append((self.command, self.path, self.headers.get("Authorization"),
                               self.headers.get("Content-Type")))
        if type(self).deny:
            self._send(403, b'{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}')
            return False
        return True

    def do_PUT(self):
        if self._auth():
            self.store[self._key()] = self.rfile.read(int(self.headers["Content-Length"]))
            self._send(200, b'{"success":true}')

    def do_GET(self):
        if self._auth():
            k = self._key()
            self._send(200, self.store[k]) if k in self.store else self._send(404, b'{"success":false}')

    def do_DELETE(self):
        if self._auth():
            self.store.pop(self._key(), None)
            self._send(200, b'{"success":true}')

    def log_message(self, *a):
        pass


@pytest.fixture
def mock_cf(monkeypatch):
    _R2Handler.store, _R2Handler.log, _R2Handler.deny = {}, [], False
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _R2Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setattr(dj, "CF_API", f"http://127.0.0.1:{srv.server_address[1]}/client/v4")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "test-token")
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acc")
    monkeypatch.setattr(dj.subprocess, "run", lambda *a, **k: pytest.fail("wrangler must not run with an API token"))
    yield _R2Handler
    srv.shutdown()


def test_r2_api_put_get_delete(mock_cf, monkeypatch, tmp_path):
    monkeypatch.setattr(dj, "WORK", str(tmp_path))
    assert dj.r2_selftest("bucket", lambda *a: None)
    m, path, auth, ctype = mock_cf.log[0]
    assert (m, path, auth, ctype) == ("PUT", "/client/v4/accounts/acc/r2/buckets/bucket/objects/meta/_ci_probe.json",
                                      "Bearer test-token", "application/json")
    assert dj.r2_get_json("bucket", "nope.json") is None


def test_r2_api_auth_error_fails_fast(mock_cf, tmp_path):
    mock_cf.deny = True
    p = tmp_path / "x.json"
    p.write_text("{}")
    with pytest.raises(dj.AuthError):
        dj.r2_put("bucket", "x.json", str(p))
    assert len(mock_cf.log) == 1  # no retries on 403


def test_upload_auth_error_aborts_run(monkeypatch, capsys, tmp_path):
    monkeypatch.setattr(dj, "day_done", lambda *a: False)
    monkeypatch.setattr(dj, "build_day", lambda d, a, log: ([("k", str(tmp_path / "f"))], {"prod_status": "ok"}))
    (tmp_path / "f").write_text("x")

    def deny(*a, **k):
        raise dj.AuthError("403")
    monkeypatch.setattr(dj, "r2_put", deny)
    calls = []
    monkeypatch.setattr(dj, "upload", lambda b, items, log: (calls.append(1), deny()))
    assert dj.main(["--date", "2026-11-01", "--date", "2026-11-02", "--work", str(tmp_path / "w")]) == 2
    assert len(calls) == 1 and "ABORT" in capsys.readouterr().out


def test_wrangler_fallback_timeout_and_auth(monkeypatch, tmp_path):
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    seen = []

    def run(cmd, **kw):
        seen.append(kw.get("timeout"))
        if len(seen) == 1:
            raise dj.subprocess.TimeoutExpired(cmd, kw["timeout"])
        return dj.subprocess.CompletedProcess(cmd, 1, "", "✘ A request to the Cloudflare API failed. "
                                                          "Authentication error [code: 10000]")
    monkeypatch.setattr(dj.subprocess, "run", run)
    with pytest.raises(dj.AuthError):
        dj.r2_put("b", "k.json", str(tmp_path / "f"))
    assert seen == [300, 300]


# ----------------------------------------------------------------- F2: --max-time
def test_max_time_stops_cleanly(monkeypatch, capsys):
    monkeypatch.setattr(dj, "day_done", lambda *a: False)
    monkeypatch.setattr(dj, "build_day", lambda *a: pytest.fail("no time for a day"))
    assert dj.main(["--days", "3", "--max-time", "5", "--no-upload"]) == 0
    out = capsys.readouterr().out
    assert "REMAINING (3):" in out
