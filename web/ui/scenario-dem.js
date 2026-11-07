// Terrain for the synthetic test scenarios (fixtures/scenarioN): the analytic DEM they were generated with
// (port of ref/doppler_ref/scenarios.py make_dem, same as web/tests/geoloc_helpers.mjs#makeAnalyticDem).
// Real recordings use the engine's default DEM (Lane B Terrarium z12). Dev/demo only.
const cache = new Map();

export const SCENARIO_TERRAINS = ['scenario1', 'scenario2'];

export async function scenarioDem(name) {
  if (!SCENARIO_TERRAINS.includes(name)) return null;
  if (!cache.has(name)) cache.set(name, (async () => {
    let r = await fetch(new URL(`../demo/${name}/scenario.json`, import.meta.url)).catch(() => null);   // deploy bundle copy
    if (!r?.ok) r = await fetch(new URL(`../../fixtures/${name}/scenario.json`, import.meta.url)).catch(() => null);   // development
    if (!r?.ok) throw new Error(`Terrain for ${name} is not available on this server.`);
    const p = (await r.json()).dem;
    const R = 6371000.0, [lat0, lon0] = p.ref, D = Math.PI / 180, cl = Math.cos(lat0 * D);
    const one = (lat, lon) => {
      const x = R * cl * (lon - lon0) * D, y = R * (lat - lat0) * D;
      let z = p.base;
      for (const [xi, yi, h, s] of p.hills) z += h * Math.exp(-((x - xi) ** 2 + (y - yi) ** 2) / (2 * s * s));
      const [a, lx, ly] = p.wave;
      return z + a * Math.sin(x / lx) * Math.cos(y / ly);
    };
    return (lat, lon) => Float64Array.from(lat, (la, i) => one(la, lon[i]));
  })());
  return cache.get(name);
}

/** Which scenario a flight source string refers to ('fixture:scenario2 (synthetic)' → 'scenario2'), else null. */
export const scenarioFromSource = (src) => SCENARIO_TERRAINS.find((n) => String(src || '').includes(`fixture:${n}`)) || null;
