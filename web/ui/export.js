// Result exports (GeoJSON / CSV for QGIS) and file download helper.
import { fmtUtc } from './time-utils.js';

export function download(name, text, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const callsigns = (c, byId) => c.flights.map((id) => byId.get(id)?.callsign?.trim() || id);

export function candidatesToGeoJSON(cands, { tracks = [], region = null, media = null, engine = null } = {}) {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const features = cands.map((c, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [+c.lon.toFixed(7), +c.lat.toFixed(7), +(c.elev_m ?? 0).toFixed(1)] },
    properties: { rank: i + 1, score: c.score, elev_m: c.elev_m, t_start_unix: c.t_start_unix,
      t_start_utc: fmtUtc(c.t_start_unix), flights: c.flights.join(';'), callsigns: callsigns(c, byId).join(';') },
  }));
  if (region?.polygon) features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [region.polygon] },
    properties: { kind: 'search_region' } });
  return JSON.stringify({ type: 'FeatureCollection', name: 'doppler_candidates',
    metadata: { media: media?.name ?? null, engine, exported: new Date().toISOString() }, features }, null, 1);
}

export function candidatesToCSV(cands, { tracks = [] } = {}) {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const rows = ['rank,lat,lon,elev_m,score,t_start_unix,t_start_utc,flights,callsigns'];
  cands.forEach((c, i) => rows.push([i + 1, c.lat.toFixed(7), c.lon.toFixed(7), (c.elev_m ?? 0).toFixed(1), c.score,
    c.t_start_unix.toFixed(1), fmtUtc(c.t_start_unix), q(c.flights.join(';')), q(callsigns(c, byId).join(';'))].join(',')));
  return rows.join('\n') + '\n';
}

export const mapsUrl = (lat, lon) => `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}`;
export const streetViewUrl = (lat, lon) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lon.toFixed(6)}`;
