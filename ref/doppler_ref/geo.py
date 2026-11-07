"""WGS84 geodetic <-> ECEF <-> local ENU (exact formulas, numpy-vectorized)."""
import numpy as np

A = 6378137.0
F = 1.0 / 298.257223563
E2 = F * (2.0 - F)


def geodetic_to_ecef(lat, lon, h):
    lat = np.radians(lat)
    lon = np.radians(lon)
    sl, cl = np.sin(lat), np.cos(lat)
    N = A / np.sqrt(1.0 - E2 * sl * sl)
    x = (N + h) * cl * np.cos(lon)
    y = (N + h) * cl * np.sin(lon)
    z = (N * (1.0 - E2) + h) * sl
    return x, y, z


def ecef_to_geodetic(x, y, z, n_iter=5):
    lon = np.arctan2(y, x)
    p = np.hypot(x, y)
    lat = np.arctan2(z, p * (1.0 - E2))
    for _ in range(n_iter):
        sl = np.sin(lat)
        N = A / np.sqrt(1.0 - E2 * sl * sl)
        h = p / np.cos(lat) - N
        lat = np.arctan2(z, p * (1.0 - E2 * N / (N + h)))
    sl = np.sin(lat)
    N = A / np.sqrt(1.0 - E2 * sl * sl)
    h = p / np.cos(lat) - N
    return np.degrees(lat), np.degrees(lon), h


class ENU:
    """Local East-North-Up frame tangent at (lat0, lon0, h0)."""

    def __init__(self, lat0, lon0, h0=0.0):
        self.lat0, self.lon0, self.h0 = float(lat0), float(lon0), float(h0)
        self.x0 = np.array(geodetic_to_ecef(lat0, lon0, h0))
        la, lo = np.radians(lat0), np.radians(lon0)
        sla, cla, slo, clo = np.sin(la), np.cos(la), np.sin(lo), np.cos(lo)
        # rows: e, n, u unit vectors in ECEF
        self.R = np.array([[-slo, clo, 0.0],
                           [-sla * clo, -sla * slo, cla],
                           [cla * clo, cla * slo, sla]])

    def fwd(self, lat, lon, h):
        """lat, lon (deg), h (m) -> array [..., 3] ENU meters."""
        x, y, z = geodetic_to_ecef(np.asarray(lat, float), np.asarray(lon, float), np.asarray(h, float))
        d = np.stack([x - self.x0[0], y - self.x0[1], z - self.x0[2]], axis=-1)
        return d @ self.R.T

    def inv(self, enu):
        enu = np.asarray(enu, float)
        d = enu @ self.R + self.x0
        return ecef_to_geodetic(d[..., 0], d[..., 1], d[..., 2])
