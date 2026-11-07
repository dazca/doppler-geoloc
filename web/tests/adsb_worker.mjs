// End-to-end check of web/engine/adsb.js (needs internet).
//   node web/tests/adsb_worker.mjs [WORKER_URL]
// Without WORKER_URL, a mock "worker" is used: index shards are read from .cache/shards (ref/data/build_index.py)
// and /adsb/range is forwarded directly to GitHub (Node has no CORS restrictions).  Compares with the Python
// output fixtures/real/lell_20261101/tracks.json.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTracks } from '../engine/adsb.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CASE = process.env.CASE || 'lell_20261101';
const TR = process.env.TRACKS || 'tracks';
const SKIP_JETS = process.env.SKIP_JETS === '1';
const MAX_ALT_FT = Number(process.env.MAX_ALT_FT || 20000);
const info = JSON.parse(readFileSync(path.join(ROOT, `fixtures/real/${CASE}/${TR}.info.json`), 'utf8'));
let ref = JSON.parse(readFileSync(path.join(ROOT, `fixtures/real/${CASE}/${TR}.json`), 'utf8'));
if (SKIP_JETS) ref = ref.filter((t) => t.category !== 'jet');
const types = JSON.parse(readFileSync(path.join(ROOT, 'web/data/types.json'), 'utf8'));

const WORKER = process.argv[2] || 'mock://worker';
const mockFetch = async (u) => {
  if (!u.startsWith('mock://')) return fetch(u);
  const url = new URL(u.replace('mock://worker', 'http://x'));
  if (url.pathname.startsWith('/adsb/index/')) {
    const [, , , tag, cell] = url.pathname.split('/');
    const p = path.join(ROOT, '.cache/shards', tag, cell);
    return existsSync(p) ? new Response(readFileSync(p)) : new Response('', { status: 404 });
  }
  const q = url.searchParams, tag = q.get('tag');
  const src = `https://github.com/adsblol/globe_history_${tag.slice(1, 5)}/releases/download/${tag}/${tag}.tar${q.get("part") ? "." + q.get("part") : ""}`;
  return fetch(src, { headers: { Range: `bytes=${q.get('start')}-${q.get('end')}` } });
};

let nReq = 0;
const t = performance.now();
const tracks = await fetchTracks({ worker: WORKER, bbox: info.bbox, t0: info.t0, t1: info.t1, types,
  feeds: info.feeds.split(','), skipJets: SKIP_JETS, maxAltFt: MAX_ALT_FT,
  onProgress: (n) => { nReq = n; }, fetch: WORKER.startsWith('mock') ? mockFetch : undefined });
const ms = performance.now() - t;
const npts = (a) => a.reduce((s, tr) => s + tr.points.length, 0);
console.log(`JS (${WORKER}, skipJets=${SKIP_JETS}): ${tracks.length} tracks / ${npts(tracks)} pts, ${nReq} trace fetches in ${(ms / 1000).toFixed(1)} s;` +
  ` Python: ${ref.length} tracks / ${npts(ref)} pts`);
// altitude agreement on common geometric points (JS uses one geoid N per bbox, Python per point)
const byId = new Map(ref.map((tr) => [tr.id, tr]));
let n = 0, maxd = 0, worst = null;
for (const tr of tracks) {
  const r = byId.get(tr.id);
  if (!r) continue;
  const m = new Map(r.points.map((p) => [p[0], p[3]]));
  for (const p of tr.points) if (m.has(p[0])) { const dd = Math.abs(m.get(p[0]) - p[3]); if (dd > maxd) { maxd = dd; worst = [tr.id, p, m.get(p[0])]; } n++; }
}
console.log(`common ids ${tracks.filter((x) => byId.has(x.id)).length}, compared ${n} pts, max |dAlt| ${maxd.toFixed(1)} m`, maxd > 20 ? JSON.stringify(worst) : '');
if (Math.abs(tracks.length - ref.length) > Math.max(2, 0.05 * ref.length)) process.exit(1);
