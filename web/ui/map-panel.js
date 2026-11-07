// Leaflet map panel: search-region editor (circle / rectangle with drag handles), flight tracks, result heat map.
// Leaflet 1.9.4 is loaded as a global (window.L) from unpkg in index.html.
import { t } from './i18n.js';
const L = globalThis.L;

export const CAT_COLORS = { prop: '#f2b544', heli: '#ec6fc4', jet: '#7d8fb3', unknown: '#a3a7ae' };
const KM_LAT = 110540;
const kmLon = (lat) => 111320 * Math.cos(lat * Math.PI / 180);

export function regionBBox(r) {
  if (!r) return null;
  if (r.shape === 'rect') { const [[s, w], [n, e]] = r.bounds; return [s, w, n, e]; }
  const [lat, lon] = r.center, dLat = r.radius_m / KM_LAT, dLon = r.radius_m / kmLon(lat);
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}
export function regionAreaKm2(r) {
  if (!r) return 0;
  if (r.shape === 'circle') return Math.PI * (r.radius_m / 1000) ** 2;
  const [s, w, n, e] = regionBBox(r);
  return ((n - s) * KM_LAT / 1000) * ((e - w) * kmLon((s + n) / 2) / 1000);
}
export function regionPolygon(r) {           // GeoJSON ring [lon, lat]
  if (!r) return null;
  if (r.shape === 'rect') { const [s, w, n, e] = regionBBox(r); return [[w, s], [e, s], [e, n], [w, n], [w, s]]; }
  const ring = [];
  for (let k = 0; k <= 64; k++) {
    const a = k / 64 * 2 * Math.PI;
    ring.push([r.center[1] + Math.cos(a) * r.radius_m / kmLon(r.center[0]), r.center[0] + Math.sin(a) * r.radius_m / KM_LAT]);
  }
  return ring;
}

// viridis-like ramp for the score field
const RAMP = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
function ramp(u) {
  const x = Math.max(0, Math.min(1, u)) * (RAMP.length - 1), k = Math.min(RAMP.length - 2, Math.floor(x)), f = x - k;
  return RAMP[k].map((c, i) => Math.round(c + (RAMP[k + 1][i] - c) * f));
}

export function createMapPanel(el, { onRegionChange, onCandidateSelect, onMapClick } = {}) {
  const map = L.map(el, { zoomControl: true, preferCanvas: true, worldCopyJump: true }).setView([40.8, -73.3], 8);
  const base = {
    [t('map.dark')]: L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 16,
        attribution: 'Basemap © Esri, HERE, Garmin, © OpenStreetMap contributors' }),
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 16, pane: 'shadowPane' }),
    ]),
    [t('map.sat')]: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' }),
    [t('map.streets')]: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }),
  };
  Object.values(base)[0].addTo(map);
  const coverageLayer = L.layerGroup().addTo(map);
  const renderer = L.canvas({ padding: 0.3 });
  const flightLayer = L.layerGroup().addTo(map);
  const heatLayer = L.layerGroup().addTo(map);
  const candLayer = L.layerGroup().addTo(map);
  const regionLayer = L.layerGroup().addTo(map);
  L.control.layers(base, { [t('map.flights')]: flightLayer, [t('map.score')]: heatLayer, [t('map.cands')]: candLayer }, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  let region = null, shapeObj = null, handles = [];
  const handleIcon = (cls, label) => L.divIcon({ className: `map-handle ${cls}`, iconSize: [14, 14], html: '', iconAnchor: [7, 7] });

  function emit() { onRegionChange?.(structuredClone(region)); }
  function drawRegion() {
    regionLayer.clearLayers(); handles = []; shapeObj = null;
    if (!region) return;
    const style = { color: '#8db4ff', weight: 1.5, fillColor: '#8db4ff', fillOpacity: 0.06, dashArray: '5 4', interactive: false };
    if (region.shape === 'circle') {
      shapeObj = L.circle(region.center, { ...style, radius: region.radius_m }).addTo(regionLayer);
      const c = L.marker(region.center, { draggable: true, icon: handleIcon('center'), title: t('map.move'), keyboard: false }).addTo(regionLayer);
      const edgePos = () => [region.center[0], region.center[1] + region.radius_m / kmLon(region.center[0])];
      const r = L.marker(edgePos(), { draggable: true, icon: handleIcon('edge'), title: t('map.radius'), keyboard: false }).addTo(regionLayer);
      c.on('drag', (e) => { const p = e.target.getLatLng(); region.center = [p.lat, p.lng]; shapeObj.setLatLng(p); r.setLatLng(edgePos()); });
      r.on('drag', (e) => { const p = e.target.getLatLng(); region.radius_m = Math.max(200, map.distance(region.center, p)); shapeObj.setRadius(region.radius_m); });
      c.on('dragend', emit); r.on('dragend', () => { r.setLatLng(edgePos()); emit(); });
      handles = [c, r];
    } else {
      shapeObj = L.rectangle(region.bounds, style).addTo(regionLayer);
      const corners = () => { const [[s, w], [n, e]] = region.bounds; return [[s, w], [n, e], [(s + n) / 2, (w + e) / 2]]; };
      const [sw, ne, mid] = corners();
      const hSW = L.marker(sw, { draggable: true, icon: handleIcon('edge'), title: t('map.corner'), keyboard: false }).addTo(regionLayer);
      const hNE = L.marker(ne, { draggable: true, icon: handleIcon('edge'), title: t('map.corner'), keyboard: false }).addTo(regionLayer);
      const hC = L.marker(mid, { draggable: true, icon: handleIcon('center'), title: t('map.move'), keyboard: false }).addTo(regionLayer);
      const sync = () => {
        const [[s, w], [n, e]] = region.bounds;
        region.bounds = [[Math.min(s, n), Math.min(w, e)], [Math.max(s, n), Math.max(w, e)]];
        region.center = [(s + n) / 2, (w + e) / 2];
        shapeObj.setBounds(region.bounds);
      };
      hSW.on('drag', (e) => { const p = e.target.getLatLng(); region.bounds[0] = [p.lat, p.lng]; sync(); hC.setLatLng(corners()[2]); });
      hNE.on('drag', (e) => { const p = e.target.getLatLng(); region.bounds[1] = [p.lat, p.lng]; sync(); hC.setLatLng(corners()[2]); });
      hC.on('drag', (e) => {
        const p = e.target.getLatLng(), [[s, w], [n, e2]] = region.bounds, hl = (n - s) / 2, hw = (e2 - w) / 2;
        region.bounds = [[p.lat - hl, p.lng - hw], [p.lat + hl, p.lng + hw]]; region.center = [p.lat, p.lng];
        shapeObj.setBounds(region.bounds); hSW.setLatLng(region.bounds[0]); hNE.setLatLng(region.bounds[1]);
      });
      for (const h of [hSW, hNE, hC]) h.on('dragend', () => { const c = corners(); hSW.setLatLng(c[0]); hNE.setLatLng(c[1]); hC.setLatLng(c[2]); emit(); });
      handles = [hSW, hNE, hC];
    }
  }

  map.on('click', (e) => onMapClick?.([e.latlng.lat, e.latlng.lng]));

  // ---- flights
  let flightPolys = new Map();
  function setFlights(tracks, filter, highlight = []) {
    flightLayer.clearLayers(); flightPolys = new Map();
    const hl = new Set(highlight);
    for (const t of tracks || []) {
      const on = filter?.[t.category] !== false;
      if (!on && !hl.has(t.id)) continue;
      const latlngs = t.points.map((p) => [p[1], p[2]]);
      const isHl = hl.has(t.id);
      const pl = L.polyline(latlngs, { renderer, color: isHl ? '#ffffff' : CAT_COLORS[t.category] || CAT_COLORS.unknown,
        weight: isHl ? 3 : 1.25, opacity: isHl ? 0.95 : hl.size ? 0.25 : 0.6, interactive: true });
      // L2: flight data is untrusted text; Leaflet inserts string content as HTML, so pass a text node
      const tip = document.createElement('span');
      tip.textContent = `${t.callsign?.trim() || t.icao24 || t.id} · ${t.type || '?'} · ${t.category}`;
      pl.bindTooltip(tip, { sticky: true, className: 'map-tip' });
      pl.addTo(flightLayer);
      if (isHl) pl.bringToFront();
      flightPolys.set(t.id, pl);
    }
  }

  // ---- results
  function setResults(res, selected = null) {
    heatLayer.clearLayers(); candLayer.clearLayers();
    if (!res) return;
    const f = res.field;
    if (f && f.nLat && f.nLon) {
      const cv = document.createElement('canvas'); cv.width = f.nLon; cv.height = f.nLat;
      const ctx = cv.getContext('2d'), img = ctx.createImageData(f.nLon, f.nLat);
      const span = (f.max - f.min) || 1;
      for (let i = 0; i < f.nLat; i++) for (let j = 0; j < f.nLon; j++) {
        const v = f.values[i * f.nLon + j], o = ((f.nLat - 1 - i) * f.nLon + j) * 4;   // row 0 = south -> bottom
        if (v == null || !Number.isFinite(v)) { img.data[o + 3] = 0; continue; }
        const u = (v - f.min) / span, [r, g, b] = ramp(u);
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = Math.round(70 + 150 * u);
      }
      ctx.putImageData(img, 0, 0);
      const [s, w, n, e] = f.bbox;
      L.imageOverlay(cv.toDataURL(), [[s, w], [n, e]], { opacity: 0.75, interactive: false, className: 'score-overlay' }).addTo(heatLayer);
    }
    res.candidates.forEach((c, i) => {
      const isSel = i === selected;
      const m = L.marker([c.lat, c.lon], { icon: L.divIcon({ className: `cand-pin${isSel ? ' is-selected' : ''}${i === 0 ? ' is-best' : ''}`,
        html: `<span>${i + 1}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }), title: t('map.cand', { n: i + 1 }), zIndexOffset: isSel ? 1000 : 100 - i, riseOnHover: true });
      m.on('click', () => onCandidateSelect?.(i));
      m.addTo(candLayer);
    });
  }

  return {
    map,
    getRegion: () => structuredClone(region),
    setRegion(r, { fit = false } = {}) {
      region = r ? structuredClone(r) : null;
      drawRegion();
      if (fit && region) map.fitBounds(L.latLngBounds([[regionBBox(region)[0], regionBBox(region)[1]], [regionBBox(region)[2], regionBBox(region)[3]]]), { padding: [30, 30] });
    },
    regionAtView(shape = 'circle', radius_m = null) {
      const c = map.getCenter(), b = map.getBounds();
      const rad = radius_m || Math.round(Math.min(map.distance(c, [b.getNorth(), c.lng]), map.distance(c, [c.lat, b.getEast()])) * 0.6 / 500) * 500 || 5000;
      return makeRegion(shape, [c.lat, c.lng], rad);
    },
    setFlights, setResults,
    /** Faint outline of where flight data exists (not interactive). */
    setCoverage(bbox) {
      coverageLayer.clearLayers();
      if (bbox) L.rectangle([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { color: '#8db4ff', weight: 1, opacity: 0.35, dashArray: '2 6', fill: false, interactive: false }).addTo(coverageLayer);
    },
    focusCandidate(c) { map.setView([c.lat, c.lon], Math.max(map.getZoom(), 14)); },
    fitTracks(tracks) {
      const pts = [];
      for (const t of tracks) for (let k = 0; k < t.points.length; k += 10) pts.push([t.points[k][1], t.points[k][2]]);
      if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [20, 20] });
    },
    invalidate: () => map.invalidateSize(),
  };
}

export function makeRegion(shape, center, radius_m) {
  const dLat = radius_m / KM_LAT, dLon = radius_m / kmLon(center[0]);
  return { shape, center: [...center], radius_m,
    bounds: [[center[0] - dLat, center[1] - dLon], [center[0] + dLat, center[1] + dLon]] };
}
