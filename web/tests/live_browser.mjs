// Lane L: browser test of web/dev/live.html with Firefox's fake microphone (Playwright).
//   PW=<path to playwright-core> node web/tests/live_browser.mjs     (env SECONDS=60)
// Starts the local dev proxy, records SECONDS of fake mic audio while polling live ADS-B, stops, and prints what the
// page built (clip length, T_start anchor vs the click time, clock offset, tracks).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { firefox } = require(process.env.PW || 'playwright-core');
const SECONDS = +(process.env.SECONDS || 60), PORT = 8791;
const proxy = spawn(process.execPath, [fileURLToPath(new URL('./live_proxy.mjs', import.meta.url)), String(PORT)], { stdio: 'pipe' });
await new Promise((r) => proxy.stdout.once('data', r));
const browser = await firefox.launch({ headless: true, firefoxUserPrefs: {
  'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true } });
try {
  const page = await browser.newPage();
  page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()));
  await page.goto(`http://127.0.0.1:${PORT}/web/dev/live.html?proxy=http://127.0.0.1:${PORT}`);
  await page.waitForFunction(() => window.__live, null, { timeout: 60000 }); // module (top-level await) loaded
  const clickMs = await page.evaluate(() => { const t = Date.now(); document.getElementById('rec').click(); return t; });
  await page.waitForTimeout(SECONDS * 1000);
  console.log('status during recording:', await page.textContent('#status'));
  await page.click('#stop');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('clip'), null, { timeout: 180000 });
  const out = await page.evaluate(() => {
    const S = window.__live;
    return { seconds: S.audio.samples.length / S.audio.fs, fs: S.audio.fs, tStartUnix: S.tStartUnix,
      rms: Math.sqrt(S.audio.samples.slice(0, 48000).reduce((s, v) => s + v * v, 0) / 48000),
      polls: S.poll.stats, clock: S.poll.clock.estimate(), tracks: S.tracks.length,
      cats: S.tracks.reduce((o, t) => (o[t.category] = (o[t.category] || 0) + 1, o), {}),
      log: document.getElementById('log').textContent };
  });
  console.log(JSON.stringify({ ...out, anchor_minus_click_ms: Math.round(out.tStartUnix * 1000 - clickMs) }, null, 1));
} finally { await browser.close(); proxy.kill(); }
