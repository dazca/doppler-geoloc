// Lane E4: "Record now" in the main app, Firefox fake microphone, real adsb.lol live data via Lane L's dev proxy.
//   PW=<path to playwright-core> node web/tests/live_app_browser.mjs     (env SECONDS=40, LAT/LON = rough area)
// Flow: open index.html?proxy=..., set a 6 km area, Record now -> record SECONDS -> Stop -> backfill -> spectrogram;
// then a hand-entered event (the fake mic has no Doppler) and a search with T_start known (±3 s).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { firefox } = require(process.env.PW || 'playwright-core');
const SECONDS = +(process.env.SECONDS || 40), PORT = 8792;
const LAT = process.env.LAT || '41.52', LON = process.env.LON || '2.10';
const proxy = spawn(process.execPath, [fileURLToPath(new URL('./live_proxy.mjs', import.meta.url)), String(PORT)], { stdio: 'pipe' });
await new Promise((r) => proxy.stdout.once('data', r));
const browser = await firefox.launch({ headless: true, firefoxUserPrefs: {
  'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true } });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  const base = `http://127.0.0.1:${PORT}`;
  await page.goto(`${base}/web/index.html?proxy=${encodeURIComponent(base)}`);
  await page.waitForFunction(() => document.getElementById('engine-badge') && !document.getElementById('engine-badge').hidden, null, { timeout: 60000 });
  await page.click('#btn-new');
  await page.waitForTimeout(300);
  const out = { recordEnabled: !(await page.isDisabled('#btn-record')) };
  const setVal = async (sel, v) => { await page.fill(sel, v); await page.locator(sel).dispatchEvent('change'); };
  await page.click('#btn-record');
  out.setupText = (await page.textContent('#live-panel')).slice(0, 160);
  await setVal('#r-lat', LAT); await setVal('#r-lon', LON); await setVal('#r-size', '6');
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'docs/img/lane_e_e4_live_setup.png' });
  const clickMs = Date.now();
  await page.click('#btn-live-start');
  try { await page.waitForSelector('#btn-live-stop', { timeout: 30000 }); }
  catch (e) { console.log(JSON.stringify({ panel: await page.textContent('#live-panel'), toast: await page.textContent('#toast'), errors }, null, 1)); throw e; }
  await page.waitForTimeout(SECONDS * 1000);
  out.during = await page.textContent('#live-stats');
  await page.screenshot({ path: 'docs/img/lane_e_e4_live_recording.png' });
  await page.click('#btn-live-stop');
  await page.waitForFunction(() => /Live recording ready/.test(document.getElementById('banner').textContent), null, { timeout: 240000 });
  await page.waitForTimeout(800);
  Object.assign(out, await page.evaluate(() => {
    const P = JSON.parse(localStorage.getItem('overhead.draft.v1'));
    return { banner: document.getElementById('banner').innerText.split('\n')[0], timeText: document.getElementById('time-utc').textContent,
      media: P.media && { name: P.media.name, duration: P.media.duration, live: P.media.live }, flights: P.flights && { source: P.flights.source, counts: P.flights.counts, notes: P.flights.notes },
      specStatus: document.getElementById('spec-status').textContent };
  }));
  out.anchor_minus_click_ms = Math.round(out.media.live.tStartUnix * 1000 - clickMs);
  await page.screenshot({ path: 'docs/img/lane_e_e4_live_done.png' });
  // a hand-entered event (fake mic: no Doppler curve), then a search with the known start time
  const box = await page.locator('#spec-host canvas').boundingBox();
  await page.click('[data-mode=mark]');
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForFunction(() => document.querySelector('.event') && !document.querySelector('.ev-status--busy'), null, { timeout: 60000 });
  await page.click('[data-mode=view]');
  const card = page.locator('.event').first(), inp = card.locator('input[type=number]');
  const vals = [String(Math.round(out.media.duration / 2)), '110', '40', '70', '300', '1500'];
  for (let k = 0; k < 6; k++) { await inp.nth(k).fill(vals[k]); await inp.nth(k).dispatchEvent('change'); }
  out.runHint = await page.textContent('#run-hint');
  if (out.flights?.counts && Object.values(out.flights.counts).some((n) => n > 0)) {
    const t = Date.now();
    await page.click('#btn-run');
    await page.waitForFunction(() => /Search finished|failed|No usable|error/i.test(document.getElementById('toast').textContent) && !document.getElementById('btn-run').disabled, null, { timeout: 300000 });
    out.searchToast = await page.textContent('#toast');
    out.searchMs = Date.now() - t;
    await page.waitForTimeout(1500);
    out.search = await page.evaluate(() => { const r = JSON.parse(localStorage.getItem('overhead.draft.v1')).run.results; return r && { time: r.input?.time, n: r.candidates.length, top: r.candidates[0] && { lat: r.candidates[0].lat, lon: r.candidates[0].lon, flights: r.candidates[0].flights, t_start: r.candidates[0].t_start_unix }, stages: r.stages }; });
    await page.screenshot({ path: 'docs/img/lane_e_e4_live_search.png' });
  }
  out.consoleErrors = errors;
  console.log(JSON.stringify(out, null, 1));
} finally { await browser.close(); proxy.kill(); }
