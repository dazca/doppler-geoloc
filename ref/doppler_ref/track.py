"""Flight track (contract JSON) -> C1 cubic-Hermite interpolant in ENU.

Interpolation (must be reproduced exactly by the JS port):
  knots t_i, positions p_i (ENU).  Tangent m_i at interior knots is the
  non-uniform 3-point derivative (exact for quadratics):
      m_i = (s_r * h_l + s_l * h_r) / (h_l + h_r),  h_l = t_i - t_{i-1}, h_r = t_{i+1} - t_i,
      s_l = (p_i - p_{i-1}) / h_l,  s_r = (p_{i+1} - p_i) / h_r
  End knots use the one-sided slope.  Each interval is a cubic Hermite.
  Outside [t_0, t_n] the position is clamped to the end knot and `valid` is False.

Optional smoothing (smooth_s = W > 0): before building the Hermite, every knot i is replaced by a
tricube-weighted local quadratic fit over knots with |t_j - t_i| < W (weights (1-(|dt|/W)^3)^3):
p_i <- a, m_i <- b of p(t) ~ a + b*(t-t_i) + c*(t-t_i)^2.  Knots with < 4 neighbours keep raw values.
This suppresses ADS-B position noise, which otherwise turns into velocity (hence Doppler) noise.
"""
import json
import numpy as np


def local_quadratic(t, P, W):
    Ps, Ms = P.copy(), hermite_tangents(t, P)
    for i in range(len(t)):
        dt = t - t[i]
        m = np.abs(dt) < W
        if m.sum() < 4:
            continue
        w = (1 - (np.abs(dt[m]) / W) ** 3) ** 3
        A = np.column_stack([np.ones(m.sum()), dt[m], dt[m] ** 2])
        Aw = A * w[:, None]
        coef = np.linalg.solve(A.T @ Aw, Aw.T @ P[m])
        Ps[i], Ms[i] = coef[0], coef[1]
    return Ps, Ms


def hermite_tangents(t, P):
    n = len(t)
    M = np.empty_like(P)
    if n == 1:
        M[:] = 0.0
        return M
    h = np.diff(t)[:, None]
    s = np.diff(P, axis=0) / h
    M[0] = s[0]
    M[-1] = s[-1]
    if n > 2:
        hl, hr = h[:-1], h[1:]
        M[1:-1] = (s[1:] * hl + s[:-1] * hr) / (hl + hr)
    return M


class Track:
    def __init__(self, d, enu, smooth_s=0.0):
        self.id = d["id"]
        self.icao24 = d.get("icao24")
        self.callsign = d.get("callsign")
        self.type = d.get("type")
        self.category = d.get("category", "unknown")
        pts = np.asarray(d["points"], float)
        pts = pts[np.argsort(pts[:, 0], kind="stable")]
        keep = np.concatenate([[True], np.diff(pts[:, 0]) > 1e-6])
        pts = pts[keep]
        self.t = pts[:, 0]
        self.P = enu.fwd(pts[:, 1], pts[:, 2], pts[:, 3])
        if smooth_s > 0:
            self.P, self.M = local_quadratic(self.t, self.P, smooth_s)
        else:
            self.M = hermite_tangents(self.t, self.P)
        self.raw = d

    @property
    def t0(self):
        return self.t[0]

    @property
    def t1(self):
        return self.t[-1]

    def eval(self, tq):
        """Return pos [...,3], vel [...,3], valid [...] at times tq (any shape)."""
        tq = np.asarray(tq, float)
        shp = tq.shape
        tf = tq.ravel()
        valid = (tf >= self.t[0]) & (tf <= self.t[-1])
        if len(self.t) < 2:
            pos = np.broadcast_to(self.P[0], (tf.size, 3)).copy()
            return pos.reshape(shp + (3,)), np.zeros(shp + (3,)), valid.reshape(shp)
        tc = np.clip(tf, self.t[0], self.t[-1])
        i = np.clip(np.searchsorted(self.t, tc, side="right") - 1, 0, len(self.t) - 2)
        ta, tb = self.t[i], self.t[i + 1]
        h = (tb - ta)[:, None]
        s = ((tc - ta) / (tb - ta))[:, None]
        p0, p1, m0, m1 = self.P[i], self.P[i + 1], self.M[i], self.M[i + 1]
        s2, s3 = s * s, s * s * s
        pos = (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * h * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * h * m1
        vel = ((6 * s2 - 6 * s) * p0 + (-6 * s2 + 6 * s) * p1) / h + (3 * s2 - 4 * s + 1) * m0 + (3 * s2 - 2 * s) * m1
        return pos.reshape(shp + (3,)), vel.reshape(shp + (3,)), valid.reshape(shp)


def load_tracks(path, enu, smooth_s=0.0):
    with open(path) as fh:
        data = json.load(fh)
    if isinstance(data, dict) and "flights" in data:
        data = data["flights"]
    return [Track(d, enu, smooth_s) for d in data]
