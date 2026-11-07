// WGS84 geodetic <-> ECEF <-> local ENU (exact, Float64). Port of ref/doppler_ref/geo.py.
export const A = 6378137.0;
export const F = 1.0 / 298.257223563;
export const E2 = F * (2.0 - F);
const D2R = Math.PI / 180;

export function geodeticToEcef(lat, lon, h, out = new Float64Array(3)) {
  const la = lat * D2R, lo = lon * D2R;
  const sl = Math.sin(la), cl = Math.cos(la);
  const N = A / Math.sqrt(1.0 - E2 * sl * sl);
  out[0] = (N + h) * cl * Math.cos(lo);
  out[1] = (N + h) * cl * Math.sin(lo);
  out[2] = (N * (1.0 - E2) + h) * sl;
  return out;
}

export function ecefToGeodetic(x, y, z, out = new Float64Array(3), nIter = 5) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1.0 - E2));
  for (let k = 0; k < nIter; k++) {
    const sl = Math.sin(lat);
    const N = A / Math.sqrt(1.0 - E2 * sl * sl);
    const h = p / Math.cos(lat) - N;
    lat = Math.atan2(z, p * (1.0 - E2 * N / (N + h)));
  }
  const sl = Math.sin(lat);
  const N = A / Math.sqrt(1.0 - E2 * sl * sl);
  out[0] = lat / D2R; out[1] = lon / D2R; out[2] = p / Math.cos(lat) - N;
  return out;
}

/** Local East-North-Up frame tangent at (lat0, lon0, h0). fwd -> [e,n,u] metres, inv -> [lat,lon,h]. */
export function makeENU(lat0, lon0, h0 = 0) {
  const x0 = geodeticToEcef(lat0, lon0, h0);
  const la = lat0 * D2R, lo = lon0 * D2R;
  const sla = Math.sin(la), cla = Math.cos(la), slo = Math.sin(lo), clo = Math.cos(lo);
  // rows e, n, u
  const R = [-slo, clo, 0.0, -sla * clo, -sla * slo, cla, cla * clo, cla * slo, sla];
  const tmp = new Float64Array(3);
  function fwd(lat, lon, h, out = new Float64Array(3)) {
    geodeticToEcef(lat, lon, h, tmp);
    const dx = tmp[0] - x0[0], dy = tmp[1] - x0[1], dz = tmp[2] - x0[2];
    out[0] = R[0] * dx + R[1] * dy + R[2] * dz;
    out[1] = R[3] * dx + R[4] * dy + R[5] * dz;
    out[2] = R[6] * dx + R[7] * dy + R[8] * dz;
    return out;
  }
  function inv(e, n, u, out = new Float64Array(3)) {
    const x = e * R[0] + n * R[3] + u * R[6] + x0[0];
    const y = e * R[1] + n * R[4] + u * R[7] + x0[1];
    const z = e * R[2] + n * R[5] + u * R[8] + x0[2];
    return ecefToGeodetic(x, y, z, out);
  }
  return { lat0, lon0, h0, fwd, inv, R, x0 };
}
