// Runtime configuration (classic script, loaded before the app). deploy/build.mjs rewrites this file for production.
// adsbWorker: base URL of the Cloudflare Worker in worker/ (historical ADS-B /adsb/* and live /v2/point, /data/traces).
// Empty = development: built-in sample data, live recording disabled (unless set in Advanced or with ?proxy=).
// coverage: where and since when the flight archive has data. The UI blocks searches outside it (the demo is exempt).
//   bbox [lat0, lon0, lat1, lon1] (Catalonia + Andorra), from: first UTC day with tiles (YYYY-MM-DD).
// defaultRegion: the editable search area placed when a file is loaded and no area was chosen yet.
window.OVERHEAD_CONFIG = {
  adsbWorker: '',
  coverage: { bbox: [40.45, 0.10, 42.95, 3.40], from: '2026-10-08' },
  defaultRegion: { center: [41.52, 2.10], radius_m: 10000 },
  maxRadius_m: 30000,
};
if (window.OVERHEAD_CONFIG.adsbWorker) window.GEOLOC_ADSB_WORKER = window.OVERHEAD_CONFIG.adsbWorker;
