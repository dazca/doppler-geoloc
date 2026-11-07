// Lane D: D1 (geo, track) + D2 (retarded time, Doppler, CPA, straight line) vs fixtures/golden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeENU } from '../engine/geoloc/geo.js';
import { buildTrack, evalTrack } from '../engine/geoloc/track.js';
import { emissionTime, straightLineF, straightLineTe, cpa } from '../engine/geoloc/doppler.js';

const G = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/golden');
const load = (f) => JSON.parse(readFileSync(path.join(G, f)));
const maxErr = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

test('D1 geo: ENU forward and inverse vs geo.json', () => {
  const g = load('geo.json');
  const enu = makeENU(...g.ref);
  let eE = 0, eL = 0, eH = 0;
  g.lla.forEach((q, i) => {
    const e = enu.fwd(q[0], q[1], q[2]);
    eE = Math.max(eE, maxErr(e, g.enu[i]));
    const b = enu.inv(e[0], e[1], e[2]);
    eL = Math.max(eL, Math.abs(b[0] - g.lla_back[i][0]), Math.abs(b[1] - g.lla_back[i][1]));
    eH = Math.max(eH, Math.abs(b[2] - g.lla_back[i][2]));
  });
  console.log(`  geo: max |dENU| ${eE.toExponential(2)} m, |dlatlon| ${eL.toExponential(2)} deg, |dh| ${eH.toExponential(2)} m`);
  assert.ok(eE < g.tolerance.enu_m && eL < g.tolerance.lla_deg && eH < g.tolerance.h_m);
});

test('D1 track: Hermite raw and W=15 s smoothed vs track_interp.json', () => {
  const g = load('track_interp.json');
  const enu = makeENU(g.ref[0], g.ref[1], 0);
  for (const [W, pos, vel, label] of [[0, g.pos_enu, g.vel_enu, 'raw'], [15, g.smoothed_W15.pos_enu, g.smoothed_W15.vel_enu, 'W15']]) {
    const tr = buildTrack(g.track, enu, W);
    const o = new Float64Array(6);
    let ep = 0, ev = 0, vOk = true;
    g.t.forEach((t, i) => {
      const valid = evalTrack(tr, t, o);
      if (W === 0 && valid !== g.valid[i]) vOk = false;
      ep = Math.max(ep, maxErr(o.subarray(0, 3), pos[i]));
      ev = Math.max(ev, maxErr(o.subarray(3), vel[i]));
    });
    console.log(`  track ${label}: max |dpos| ${ep.toExponential(2)} m, |dvel| ${ev.toExponential(2)} m/s`);
    assert.ok(vOk, 'valid flags');
    assert.ok(ep < g.tolerance.pos_m && ev < g.tolerance.vel_mps, label);
  }
});

test('D2 emission time + exact Doppler + CPA vs emission_doppler.json', () => {
  const g = load('emission_doppler.json');
  const enu = makeENU(g.ref[0], g.ref[1], 0);
  const tr = buildTrack(g.track, enu, 0);
  const c = g.c, tol = g.tolerance, out = new Float64Array(3);
  const e = { te: 0, R: 0, vr: 0, f: 0, f1: 0, tc: 0, dc: 0, sp: 0, tdc: 0 };
  for (const cs of g.cases) {
    const [ox, oy, oz] = cs.obs_enu;
    cs.t_rx.forEach((trx, i) => {
      const valid = emissionTime(tr, ox, oy, oz, trx, c, out);
      assert.equal(valid, cs.valid[i]);
      e.te = Math.max(e.te, Math.abs(out[0] - cs.t_e[i]));
      e.R = Math.max(e.R, Math.abs(out[1] - cs.R[i]));
      e.vr = Math.max(e.vr, Math.abs(out[2] - cs.v_r[i]));
      e.f = Math.max(e.f, Math.abs(100 * c / (c - out[2]) - cs.f_exact_F0_100[i]));
      e.f1 = Math.max(e.f1, Math.abs(100 * (1 + out[2] / c) - cs.f_first_order_F0_100[i]));
    });
    const r = cpa(tr, [cs.obs_enu], c);
    e.tc = Math.max(e.tc, Math.abs(r.t_cpa[0] - cs.cpa.t_cpa));
    e.dc = Math.max(e.dc, Math.abs(r.d_cpa[0] - cs.cpa.d_cpa));
    e.sp = Math.max(e.sp, Math.abs(r.speed[0] - cs.cpa.speed));
    e.tdc = Math.max(e.tdc, Math.abs(r.t_dcpa[0] - cs.cpa.t_dcpa));
  }
  console.log('  emission/doppler/cpa max errors:', Object.entries(e).map(([k, v]) => `${k}=${v.toExponential(2)}`).join(' '));
  assert.ok(e.te < tol.t_e_s && e.R < tol.R_m && e.vr < tol.v_r_mps && e.f < tol.f_hz && e.f1 < tol.f_hz);
  assert.ok(e.tc < tol.t_cpa_s && e.dc < tol.d_cpa_m && e.sp < tol.speed_mps && e.tdc < tol.t_dcpa_s);
});

test('D2 straight-line closed form vs straight_line.json', () => {
  const g = load('straight_line.json');
  let ef = 0, et = 0;
  for (const cs of g.cases) {
    cs.T.forEach((T, i) => {
      ef = Math.max(ef, Math.abs(straightLineF(T, cs.F0, cs.v, cs.d, g.c) - cs.f[i]));
      et = Math.max(et, Math.abs(straightLineTe(T, cs.v, cs.d, g.c) - cs.tau[i]));
    });
    // f = F0 at the delayed CPA, slope there = -F0 v^2/(c d)
    const Td = cs.d / g.c, h = 1e-4;
    assert.ok(Math.abs(straightLineF(Td, cs.F0, cs.v, cs.d, g.c) - cs.F0) < 1e-9);
    const sl = (straightLineF(Td + h, cs.F0, cs.v, cs.d, g.c) - straightLineF(Td - h, cs.F0, cs.v, cs.d, g.c)) / (2 * h);
    assert.ok(Math.abs(sl - cs.slope_at_delayed_cpa) < 1e-6);
  }
  console.log(`  straight line: max |df| ${ef.toExponential(2)} Hz, |dtau| ${et.toExponential(2)} s`);
  assert.ok(ef < 1e-9 && et < 1e-9);
});
