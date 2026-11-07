// Lane L: LOCAL dev-only CORS proxy + static server, so web/dev/live.html can be tried without a Worker.
//   node web/tests/live_proxy.mjs [port=8790]     -> http://127.0.0.1:8790/web/dev/live.html?proxy=http://127.0.0.1:8790
// Forwards only:  /v2/point/{lat}/{lon}/{nm}             -> https://api.adsb.lol/v2/point/...
//                 /data/traces/{xx}/trace_{full|recent}_{hex}.json -> https://adsb.lol/data/traces/...
// Everything else is served from the project root. Not for deployment (the production design is a Worker, see
// docs/LANE_L_REPORT.md). Adds Access-Control-Allow-Origin: * and Access-Control-Expose-Headers: Date.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = +(process.argv[2] || 8790);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wav': 'audio/wav' };
const UA = 'doppler-geoloc-dev-proxy/0.1 (local feasibility test)';

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Date' };
  let up = null;
  if (/^\/v2\/point\/-?[\d.]+\/-?[\d.]+\/\d+$/.test(u.pathname)) up = 'https://api.adsb.lol' + u.pathname;
  else if (/^\/data\/traces\/[0-9a-f]{2}\/trace_(full|recent)_~?[0-9a-f]{6}\.json$/.test(u.pathname)) up = 'https://adsb.lol' + u.pathname;
  if (up) {
    try {
      const r = await fetch(up, { headers: { 'User-Agent': UA } });
      const body = Buffer.from(await r.arrayBuffer()); // fetch already decoded gzip
      res.writeHead(r.status, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Date: r.headers.get('date') || new Date().toUTCString() });
      return res.end(body);
    } catch (e) { res.writeHead(502, cors); return res.end(String(e)); }
  }
  const p = normalize(join(ROOT, decodeURIComponent(u.pathname)));
  if (!p.startsWith(normalize(ROOT))) { res.writeHead(403); return res.end(); }
  try {
    const b = await readFile(p);
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end(); }
}).listen(PORT, '127.0.0.1', () => console.log(`live dev proxy on http://127.0.0.1:${PORT}/web/dev/live.html?proxy=http://127.0.0.1:${PORT}`));
