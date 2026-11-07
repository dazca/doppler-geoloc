"""Real DEM from AWS Terrarium tiles (same source as web/engine/dem.js), cached on disk.

elev = R*256 + G + B/256 - 32768  (metres, ~EGM96 orthometric; SRTM/NED-derived in the US).
Bilinear interpolation on the tile pixel grid (Web-Mercator).
"""
import os
import urllib.request

import numpy as np

URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
CACHE = os.path.join(os.path.dirname(__file__), "..", ".cache", "terrarium")


def _tile_xy(lat, lon, z):
    n = 2.0 ** z
    x = (np.asarray(lon) + 180.0) / 360.0 * n
    la = np.radians(lat)
    y = (1.0 - np.log(np.tan(la) + 1.0 / np.cos(la)) / np.pi) / 2.0 * n
    return x, y


def _load_tile(z, x, y):
    from matplotlib.image import imread
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, f"{z}_{x}_{y}.png")
    if not os.path.exists(p):
        urllib.request.urlretrieve(URL.format(z=z, x=x, y=y), p)
    im = np.round(imread(p)[..., :3] * 255.0)
    return im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768


class TerrariumDEM:
    def __init__(self, bbox, z=12):
        """bbox = [lat_min, lon_min, lat_max, lon_max]; loads all tiles covering it into one mosaic."""
        self.z = z
        x0, y1 = _tile_xy(bbox[0], bbox[1], z)
        x1, y0 = _tile_xy(bbox[2], bbox[3], z)
        self.tx0, self.ty0 = int(np.floor(x0)), int(np.floor(y0))
        tx1, ty1 = int(np.floor(x1)), int(np.floor(y1))
        rows = []
        for ty in range(self.ty0, ty1 + 1):
            rows.append(np.concatenate([_load_tile(z, tx, ty) for tx in range(self.tx0, tx1 + 1)], axis=1))
        self.M = np.concatenate(rows, axis=0)

    def __call__(self, lat, lon):
        x, y = _tile_xy(lat, lon, self.z)
        px = (x - self.tx0) * 256 - 0.5
        py = (y - self.ty0) * 256 - 0.5
        H, W = self.M.shape
        px = np.clip(px, 0, W - 1.001)
        py = np.clip(py, 0, H - 1.001)
        i, j = np.floor(py).astype(int), np.floor(px).astype(int)
        a, b = py - i, px - j
        M = self.M
        return ((1 - a) * (1 - b) * M[i, j] + (1 - a) * b * M[i, j + 1] + a * (1 - b) * M[i + 1, j]
                + a * b * M[i + 1, j + 1])
