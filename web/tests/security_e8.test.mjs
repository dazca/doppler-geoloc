// E8 (docs/SECURITY_REVIEW.md L2/L3): regression checks that need no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pointUrl } from '../live/adsb-live.js';

test('L3: live position is rounded to 0.05 deg before it is sent', () => {
  assert.equal(pointUrl('https://w', 41.52123, 2.10456, 25), 'https://w/v2/point/41.50/2.10/25');
  assert.equal(pointUrl('https://w', -33.8688, 151.2093, 25.4), 'https://w/v2/point/-33.85/151.20/25');
  for (const [la, lo] of [[40.8761, -73.5239], [0.024, -0.026]]) {
    const [a, b] = pointUrl('https://w', la, lo, 10).split('/v2/point/')[1].split('/');
    assert.ok(Math.abs(+a - la) <= 0.025 + 1e-9 && Math.abs(+b - lo) <= 0.025 + 1e-9);
    assert.ok(Number.isInteger(Math.round(+a * 20 * 1e6) / 1e6) && Number.isInteger(Math.round(+b * 20 * 1e6) / 1e6));
  }
});

test('L2: map tooltip does not pass flight data as an HTML string; CSP pins Leaflet files', () => {
  const src = readFileSync(new URL('../ui/map-panel.js', import.meta.url), 'utf8');
  assert.ok(!/bindTooltip\(`/.test(src), 'tooltip must not be an HTML template string');
  assert.ok(/tip\.textContent\s*=/.test(src));
  const hdr = readFileSync(new URL('../_headers', import.meta.url), 'utf8');
  // Leaflet pinned to its exact file; Turnstile (human check, web/ui/data-session.js) only from its own origin
  assert.match(hdr, /script-src 'self' blob: https:\/\/unpkg\.com\/leaflet@1\.9\.4\/dist\/leaflet\.js https:\/\/challenges\.cloudflare\.com;/);
  assert.match(hdr, /frame-src https:\/\/challenges\.cloudflare\.com;/);
  assert.match(hdr, /style-src 'self' https:\/\/unpkg\.com\/leaflet@1\.9\.4\/dist\/leaflet\.css;/);
});
