// Offline place list for the "where" search box (Catalonia + Andorra, where the flight archive has data).
// Approximate centres; the search area is a circle the user can still drag. No geocoding service, no new origin.
export const PLACES = [
  ['Barcelona', 41.387, 2.170], ['Badalona', 41.450, 2.247], ["L'Hospitalet de Llobregat", 41.360, 2.100],
  ['Terrassa', 41.563, 2.009], ['Sabadell', 41.548, 2.107], ['Mataró', 41.540, 2.444], ['Granollers', 41.608, 2.288],
  ['Sant Cugat del Vallès', 41.472, 2.086], ['Cerdanyola del Vallès', 41.491, 2.141], ['Rubí', 41.493, 2.032],
  ['Mollet del Vallès', 41.540, 2.213], ['Martorell', 41.474, 1.930], ['El Prat de Llobregat', 41.326, 2.095],
  ['Castelldefels', 41.280, 1.977], ['Sitges', 41.237, 1.805], ['Vilanova i la Geltrú', 41.224, 1.725],
  ['Vilafranca del Penedès', 41.346, 1.698], ['Igualada', 41.579, 1.617], ['Manresa', 41.728, 1.824], ['Vic', 41.930, 2.255],
  ['Berga', 42.104, 1.845], ['Solsona', 41.994, 1.517], ['Ripoll', 42.201, 2.191], ['Olot', 42.181, 2.490],
  ['Girona', 41.979, 2.821], ['Figueres', 42.267, 2.961], ['Banyoles', 42.117, 2.766], ["La Bisbal d'Empordà", 41.960, 3.039],
  ['Palafrugell', 41.917, 3.163], ['Sant Feliu de Guíxols', 41.781, 3.028], ['Lloret de Mar', 41.700, 2.845], ['Blanes', 41.674, 2.790],
  ['Santa Coloma de Farners', 41.860, 2.668], ['Calella', 41.614, 2.664], ['Arenys de Mar', 41.581, 2.550],
  ['Puigcerdà', 42.432, 1.928], ["La Seu d'Urgell", 42.358, 1.456], ['Sort', 42.413, 1.131], ['Tremp', 42.167, 0.894],
  ['Vielha', 42.702, 0.796], ['El Pont de Suert', 42.408, 0.740], ['Lleida', 41.617, 0.620], ['Balaguer', 41.790, 0.810],
  ['Mollerussa', 41.631, 0.896], ['Tàrrega', 41.647, 1.140], ['Cervera', 41.670, 1.272], ['Montblanc', 41.376, 1.162],
  ['Valls', 41.286, 1.250], ['Tarragona', 41.119, 1.245], ['Reus', 41.156, 1.107], ['Salou', 41.077, 1.141],
  ['Cambrils', 41.067, 1.059], ['El Vendrell', 41.219, 1.535], ['Falset', 41.145, 0.819], ["Móra d'Ebre", 41.092, 0.643],
  ['Gandesa', 41.052, 0.437], ['Tortosa', 40.812, 0.521], ['Amposta', 40.713, 0.581],
  ['Andorra la Vella', 42.507, 1.522], ['Escaldes-Engordany', 42.509, 1.539], ['Encamp', 42.536, 1.583], ['Canillo', 42.567, 1.598],
  ['Ordino', 42.556, 1.533], ['La Massana', 42.545, 1.515], ['Sant Julià de Lòria', 42.464, 1.491],
  ['Aeròdrom de Sabadell (LELL)', 41.521, 2.105], ['Aeroport de Barcelona (LEBL)', 41.297, 2.078], ['Aeroport de Girona (LEGE)', 41.901, 2.760],
  ['Aeroport de Reus (LERS)', 41.147, 1.167], ['Aeroport de Lleida-Alguaire (LEDA)', 41.728, 0.535], ["Aeròdrom d'Igualada-Òdena (LEIG)", 41.586, 1.652],
  ['Aeròdrom de la Cerdanya (LECD)', 42.386, 1.866], ["Aeròdrom d'Empuriabrava (LEAP)", 42.262, 3.109], ["Aeroport d'Andorra–la Seu (LESU)", 42.339, 1.409],
];

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
/** Best match for typed text: exact, then prefix, then substring (accent- and case-insensitive). */
export function findPlace(text) {
  const q = fold(text || '');
  if (!q) return null;
  return PLACES.find((p) => fold(p[0]) === q) || PLACES.find((p) => fold(p[0]).startsWith(q)) || PLACES.find((p) => fold(p[0]).includes(q)) || null;
}
/** Nearest listed place to [lat, lon] and its distance in km. */
export function nearestPlace([lat, lon]) {
  let best = null, bd = Infinity;
  for (const p of PLACES) {
    if (/\(/.test(p[0])) continue;                        // name towns, not airfields
    const d = Math.hypot((p[1] - lat) * 111, (p[2] - lon) * 111 * Math.cos(lat * Math.PI / 180));
    if (d < bd) { bd = d; best = p; }
  }
  return best ? { name: best[0], km: bd } : null;
}
