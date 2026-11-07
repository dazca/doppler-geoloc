// DEM sampling from AWS Terrain Tiles (Terrarium PNG, CORS "*", no key).
// Pure ES module: works in browsers and Node >= 18 (needs global fetch + DecompressionStream).
// No dependencies: includes a tiny PNG decoder (8-bit RGB/RGBA, non-interlaced = what Terrarium serves),
// which also avoids canvas colour-management artefacts that would corrupt elevation bytes.
//
//   import { createDem } from './dem.js';
//   const dem = createDem({ zoom: 12 });
//   const h = await dem.elevations([[41.4219, 2.1186], [41.6056, 1.8125]]);   // Float32Array, metres
//
// Terrarium: elev = R*256 + G + B/256 - 32768 (metres, ~EGM96/MSL; SRTM/ETOPO/... blend, see DATA.md).
// Sampling: bilinear on pixel centres in global Web-Mercator pixel space (seamless across tiles).
// z12 pixel ~ 38 m * cos(lat); z13 ~ 19 m (native source resolution is ~30 m in most of the world).

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export function decodeTerrariumPixel(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

// ---------------------------------------------------------------- tiny PNG decoder
async function inflate(bytes) {
  const ds = new DecompressionStream('deflate'); // zlib-wrapped, as in PNG IDAT
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodePng(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (off < u8.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    const data = u8.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(off + 8); height = dv.getUint32(off + 12);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || (ctype !== 2 && ctype !== 6) || interlace) {
    throw new Error(`unsupported PNG (depth ${depth}, colour ${ctype}, interlace ${interlace})`);
  }
  const bpp = ctype === 2 ? 3 : 4;
  let total = 0;
  for (const c of idat) total += c.length;
  const z = new Uint8Array(total);
  let p = 0;
  for (const c of idat) { z.set(c, p); p += c.length; }
  const raw = await inflate(z);
  const stride = width * bpp;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = y > 0 ? out[prev + i] : 0;
      const c = i >= bpp && y > 0 ? out[prev + i - bpp] : 0;
      let v;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new Error('bad PNG filter ' + f);
      }
      out[dst + i] = v & 255;
    }
  }
  return { width, height, channels: bpp, data: out };
}

// ---------------------------------------------------------------- tiles -> elevation grid
export function tileToElevations(img) {
  const { width, height, channels, data } = img;
  const e = new Float32Array(width * height);
  for (let i = 0, j = 0; i < e.length; i++, j += channels) {
    e[i] = decodeTerrariumPixel(data[j], data[j + 1], data[j + 2]);
  }
  return e;
}

/** Global Web-Mercator pixel coordinates (pixel-centre convention: centre of pixel k is at k). */
export function latLonToGlobalPixel(lat, lon, z, tileSize = 256) {
  const n = tileSize * 2 ** z;
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  const x = ((lon + 180) / 360) * n - 0.5;
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n - 0.5;
  return [x, y];
}

export function createDem(opts = {}) {
  const zoom = opts.zoom ?? 12;
  const url = opts.url ?? TERRARIUM_URL;
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const maxTiles = opts.maxTiles ?? 512;
  // Transient failures ("fetch failed", 429, 5xx) are retried with exponential backoff.  If a tile still fails and
  // opts.fallbackElevation is a number, a flat tile of that height is used (counted in stats.failedTiles) instead
  // of aborting the whole search; default: throw.
  const retries = opts.retries ?? 4, retryBaseMs = opts.retryBaseMs ?? 250;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const fallback = opts.fallbackElevation;
  const failedTiles = [];
  const cache = new Map(); // key -> Promise<Float32Array>  (LRU via Map order)
  let requests = 0;

  function tile(x, y) {
    const n = 2 ** zoom;
    x = ((x % n) + n) % n;
    y = Math.max(0, Math.min(n - 1, y));
    const key = `${x}/${y}`;
    let pr = cache.get(key);
    if (pr) { cache.delete(key); cache.set(key, pr); return pr; }
    const u = url.replace('{z}', zoom).replace('{x}', x).replace('{y}', y);
    requests++;
    pr = (async () => {
      let last;
      for (let i = 0; i <= retries; i++) {
        try {
          const r = await fetchFn(u);
          if (r.ok) return tileToElevations(await decodePng(new Uint8Array(await r.arrayBuffer())));
          last = new Error(`HTTP ${r.status}`);
          if (r.status !== 429 && r.status < 500) break; // 404 etc.: not transient
        } catch (e) { last = e; }
        if (i < retries) await sleep(retryBaseMs * 2 ** i);
      }
      if (typeof fallback === 'number') {
        failedTiles.push(`${key}: ${last?.message || last}`);
        return new Float32Array(256 * 256).fill(fallback);
      }
      throw new Error(`DEM tile ${u}: ${last?.message || last}`);
    })();
    pr.catch(() => cache.delete(key));
    cache.set(key, pr);
    while (cache.size > maxTiles) cache.delete(cache.keys().next().value);
    return pr;
  }

  /** points: Array<[lat, lon]> or {lat: ArrayLike, lon: ArrayLike}. Returns Float32Array (metres). */
  async function elevations(points) {
    const lat = Array.isArray(points) ? points.map((p) => p[0]) : points.lat;
    const lon = Array.isArray(points) ? points.map((p) => p[1]) : points.lon;
    const N = lat.length;
    const gx = new Float64Array(N), gy = new Float64Array(N);
    const need = new Map();
    for (let i = 0; i < N; i++) {
      const [x, y] = latLonToGlobalPixel(lat[i], lon[i], zoom);
      gx[i] = x; gy[i] = y;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      for (const xx of [x0, x0 + 1]) for (const yy of [y0, y0 + 1]) {
        const k = `${xx >> 8}/${yy >> 8}`;
        if (!need.has(k)) need.set(k, [xx >> 8, yy >> 8]);
      }
    }
    const tiles = new Map();
    await Promise.all([...need].map(async ([k, [tx, ty]]) => tiles.set(k, await tile(tx, ty))));
    const px = (x, y) => tiles.get(`${x >> 8}/${y >> 8}`)[(y & 255) * 256 + (x & 255)];
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x0 = Math.floor(gx[i]), y0 = Math.floor(gy[i]);
      const fx = gx[i] - x0, fy = gy[i] - y0;
      const a = px(x0, y0), b = px(x0 + 1, y0), c = px(x0, y0 + 1), d = px(x0 + 1, y0 + 1);
      out[i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
    return out;
  }

  /** Regular lat/lon grid: returns {lat, lon, elev: Float32Array row-major [iLat*nLon + iLon]}. */
  async function grid(lat0, lon0, lat1, lon1, nLat, nLon) {
    const lat = [], lon = [];
    for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) {
      lat.push(lat0 + ((lat1 - lat0) * i) / Math.max(1, nLat - 1));
      lon.push(lon0 + ((lon1 - lon0) * j) / Math.max(1, nLon - 1));
    }
    return { lat, lon, nLat, nLon, elev: await elevations({ lat, lon }) };
  }

  return {
    elevations,
    elevation: async (la, lo) => (await elevations([[la, lo]]))[0],
    grid,
    get stats() { return { requests, cached: cache.size, zoom, failedTiles: failedTiles.slice() }; },
  };
}
