// Build the static bundle for Cloudflare Pages: copies web/ into deploy/dist/ without tests, dev pages or docs,
// and writes the production Worker origin into config.js and _headers. Nothing is deployed.
//   node deploy/build.mjs https://data.<your-domain> [<turnstile-site-key>]   (custom-domain Worker; Cache API is a no-op on workers.dev)
//   (or WORKER_ORIGIN=... node deploy/build.mjs; with no origin the bundle runs on built-in sample data only)
import { cp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'web'), OUT = path.join(ROOT, 'deploy', 'dist');
const origin = (process.argv[2] || process.env.WORKER_ORIGIN || '').replace(/\/+$/, '');
if (origin && !/^https:\/\/[\w.-]+(:\d+)?$/.test(origin)) { console.error(`Worker origin must look like https://host, got "${origin}"`); process.exit(1); }
// Turnstile site key (public by design; the secret stays a Worker secret): enables the human session in the app.
const siteKey = (process.argv[3] || process.env.TURNSTILE_SITEKEY || '').trim();
if (siteKey && !/^[\w-]{10,64}$/.test(siteKey)) { console.error(`Turnstile site key looks wrong: "${siteKey}"`); process.exit(1); }

// Excluded from the bundle: tests, dev pages, docs. fixtures/ and ref/ live outside web/ and are never copied;
// the demo uses only web/demo/scenario1 (audio + tracks + measured events + terrain parameters).
const EXCLUDE = [/^tests(\/|$)/, /^dev(\/|$)/, /\.md$/, /(^|\/)\./];
await rm(OUT, { recursive: true, force: true });
await cp(SRC, OUT, { recursive: true, filter: (src) => {
  const rel = path.relative(SRC, src).split(path.sep).join('/');
  return rel === '' || !EXCLUDE.some((re) => re.test(rel));
} });

const cfg = path.join(OUT, 'config.js');
await writeFile(cfg, (await readFile(cfg, 'utf8')).replace("adsbWorker: ''", `adsbWorker: ${JSON.stringify(origin)}`)
  .replace("turnstileSiteKey: ''", `turnstileSiteKey: ${JSON.stringify(siteKey)}`));
const hdr = path.join(OUT, '_headers');
await writeFile(hdr, (await readFile(hdr, 'utf8')).replaceAll('__WORKER_ORIGIN__', origin));

// report
let files = 0, bytes = 0, biggest = ['', 0];
async function walk(d) {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) await walk(p);
    else { const s = (await stat(p)).size; files++; bytes += s; if (s > biggest[1]) biggest = [path.relative(OUT, p), s]; }
  }
}
await walk(OUT);
console.log(`deploy/dist: ${files} files, ${(bytes / 1e6).toFixed(1)} MB (largest ${biggest[0]} ${(biggest[1] / 1e6).toFixed(1)} MB; Pages limit 25 MiB/file, 20k files)`);
console.log(siteKey ? 'Turnstile human session: on' : 'Turnstile human session: off (no site key)');
console.log(origin ? `Worker origin: ${origin}` : 'No Worker origin: historical search uses built-in sample data; live recording disabled.');
