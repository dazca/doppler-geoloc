// Zoomable / pannable spectrogram viewer on a 2D canvas (no WebGL, no deps).
//
//   const view = new SpectrogramView(containerEl, {colormap: 'viridis'});
//   view.setSpectrogram(spec)                     // contract spectrogram {t0,dt,f0,df,nT,nF,data}
//   view.setLevels(loDb, hiDb) / view.getLevels() // colour range (brightness = lo, contrast = hi-lo)
//   view.autoLevels(pLo=0.2, pHi=0.997)           // percentile-based levels
//   view.setGamma(g)                              // colour-scale gamma (default 1)
//   view.setColormap('viridis'|'magma'|'gray')
//   view.setView({t0,t1,f0,f1}) / view.getView() / view.resetView()
//   view.setMode('pan'|'pick'|'box')              // pick: click -> 'pick'; box: drag -> 'box'
//                                                 // pan always available: drag in 'pan', shift/middle/right-drag otherwise
//   view.setOverlay(id, {points: [[t,f],...]|[{t,f}], color, width, dash: [..], markers: bool, label})
//   view.removeOverlay(id) / view.clearOverlays()
//   view.setOverlays(entries)                     // replace ALL overlays in one redraw: Map | {id: ov} | [[id, ov]]
//   band overlay: {type: 'band', t0, t1, f0?, f1?, fill, stroke, label}  // filled time(-frequency) region,
//                                                 // drawn under line overlays; omitted f0/f1 = full height
//   view.setCursor(t | null)                      // vertical cursor (e.g. playback position)
//   view.on('pick'|'box'|'hover'|'view', cb)      // pick: {t,f,db,event}; box: {t0,t1,f0,f1}; hover: {t,f,db}
//   view.destroy()
// Wheel = zoom time around cursor; Shift+wheel or wheel over the frequency axis = zoom frequency.
// Double-click = reset view. Rendering max-pools spectrogram cells into pixels so faint lines survive zoom-out.

const STOPS = {
  viridis: [[68, 1, 84], [72, 36, 117], [65, 68, 135], [53, 95, 141], [42, 120, 142], [33, 145, 140],
    [34, 168, 132], [68, 191, 112], [122, 209, 81], [189, 223, 38], [253, 231, 37]],
  magma: [[0, 0, 4], [20, 14, 54], [59, 15, 112], [100, 26, 128], [140, 41, 129], [183, 55, 121],
    [222, 73, 104], [246, 110, 92], [254, 159, 109], [254, 206, 145], [252, 253, 191]],
  gray: [[0, 0, 0], [255, 255, 255]],
};

export function makeLUT(name) {
  const st = STOPS[name] || STOPS.viridis, lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (st.length - 1), k = Math.min(st.length - 2, Math.floor(x)), u = x - k;
    const c = [0, 1, 2].map((q) => Math.round(st[k][q] + (st[k + 1][q] - st[k][q]) * u));
    lut[i] = (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]; // little-endian RGBA
  }
  return lut;
}

// B9: time-pooled max pyramid for redraws of long, zoomed-out spectrograms. Level k max-pools factor^k original time
// rows (only levels of factor 8, 64, 512: ~14 % extra memory). maxRowsInto() takes the max over rows [i0, i1] using
// the coarsest whole blocks inside the range and finer levels / raw rows at the edges, so the result is exact.
export function buildTimePyramid(data, nT, nF, { factor = 8, maxLevels = 3 } = {}) {
  const levels = [];
  let src = data, n = nT, F = 1;
  while (levels.length < maxLevels && n >= 2 * factor) {
    const m = Math.ceil(n / factor), d = new Float32Array(m * nF);
    for (let i = 0; i < m; i++) {
      const o = i * nF, k0 = i * factor, k1 = Math.min(n, k0 + factor);
      d.set(src.subarray(k0 * nF, k0 * nF + nF), o);
      for (let k = k0 + 1; k < k1; k++) { const q = k * nF; for (let j = 0; j < nF; j++) { const v = src[q + j]; if (v > d[o + j]) d[o + j] = v; } }
    }
    F *= factor; levels.push({ F, n: m, data: d }); src = d; n = m;
  }
  return levels;
}
/** col[j] = max(col[j], max over original rows i0..i1 of data[i*nF + j]) for j in [jMin, jMax], using levels[0..li]. */
export function maxRowsInto(col, jMin, jMax, data, nF, levels, i0, i1, li = levels.length - 1) {
  if (i1 < i0) return;
  while (li >= 0) {
    const { F, data: d } = levels[li], b0 = Math.ceil(i0 / F), b1 = Math.floor((i1 + 1) / F) - 1;
    if (b1 >= b0) {
      maxRowsInto(col, jMin, jMax, data, nF, levels, i0, b0 * F - 1, li - 1);
      for (let b = b0; b <= b1; b++) { const o = b * nF; for (let j = jMin; j <= jMax; j++) { const v = d[o + j]; if (v > col[j]) col[j] = v; } }
      maxRowsInto(col, jMin, jMax, data, nF, levels, (b1 + 1) * F, i1, li - 1);
      return;
    }
    li--;
  }
  for (let i = i0; i <= i1; i++) { const o = i * nF; for (let j = jMin; j <= jMax; j++) { const v = data[o + j]; if (v > col[j]) col[j] = v; } }
}

// indices of cells (centres x0 + i*dx) inside [a, b); nearest cell if none
function cellRange(a, b, x0, dx) {
  let i0 = Math.ceil((a - x0) / dx - 1e-9), i1 = Math.ceil((b - x0) / dx - 1e-9) - 1;
  if (i1 < i0) i0 = i1 = Math.round(((a + b) / 2 - x0) / dx);
  return [i0, i1];
}

function niceStep(range, target) {
  const raw = range / Math.max(1, target), p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
const fmtTime = (t, step) => {
  if (step >= 60 || Math.abs(t) >= 600) {
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${m}:${s.toFixed(step < 1 ? 1 : 0).padStart(step < 1 ? 4 : 2, '0')}`;
  }
  return t.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0);
};

export class SpectrogramView {
  constructor(container, opts = {}) {
    this.container = container;
    this.margin = { l: 52, r: 8, t: 8, b: 26, ...(opts.margin || {}) };
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;cursor:crosshair;touch-action:none';
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.img = document.createElement('canvas'); // cached plot-area image
    this.lut = makeLUT(opts.colormap || 'viridis');
    this.gamma = 1;
    this.mode = opts.mode || 'pan';
    this.overlays = new Map();
    this.handlers = {};
    this.spec = null;
    this.view = { t0: 0, t1: 1, f0: 0, f1: 1 };
    this.levels = [-10, 20];
    this.hover = null; this.drag = null; this.cursorT = null;
    this._dirtyImg = true;
    this._bind();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);
    this._resize();
  }

  // ---------------------------------------------------------------- public API
  on(ev, cb) { (this.handlers[ev] ||= []).push(cb); return this; }
  _emit(ev, d) { for (const cb of this.handlers[ev] || []) cb(d); }

  setSpectrogram(spec, { keepView = false, autoLevels = true } = {}) {
    this.spec = spec; this._pyr = null;
    if (!keepView) this.resetView(false);
    if (autoLevels) this.autoLevels(); else this._invalidate();
  }
  extent() {
    const s = this.spec;
    return s ? { t0: s.t0 - s.dt / 2, t1: s.t0 + (s.nT - 0.5) * s.dt, f0: s.f0 - s.df / 2, f1: s.f0 + (s.nF - 0.5) * s.df }
      : { t0: 0, t1: 1, f0: 0, f1: 1 };
  }
  resetView(emit = true) { this.setView(this.extent(), emit); }
  getView() { return { ...this.view }; }
  setView(v, emit = true) {
    const e = this.extent();
    let { t0, t1, f0, f1 } = { ...this.view, ...v };
    const minT = this.spec ? this.spec.dt * 4 : 1e-3, minF = this.spec ? this.spec.df * 4 : 1e-3;
    if (t1 - t0 < minT) { const c = (t0 + t1) / 2; t0 = c - minT / 2; t1 = c + minT / 2; }
    if (f1 - f0 < minF) { const c = (f0 + f1) / 2; f0 = c - minF / 2; f1 = c + minF / 2; }
    const clampRange = (a, b, lo, hi) => {
      const w = Math.min(b - a, hi - lo);
      if (a < lo) { a = lo; b = lo + w; }
      if (b > hi) { b = hi; a = hi - w; }
      return [a, b];
    };
    [t0, t1] = clampRange(t0, t1, e.t0, e.t1);
    [f0, f1] = clampRange(f0, f1, e.f0, e.f1);
    this.view = { t0, t1, f0, f1 };
    this._invalidate();
    if (emit) this._emit('view', this.getView());
  }
  setLevels(lo, hi) { this.levels = [lo, Math.max(hi, lo + 1e-3)]; this._invalidate(); }
  getLevels() { return [...this.levels]; }
  setGamma(g) { this.gamma = g; this._invalidate(); }
  autoLevels(pLo = 0.2, pHi = 0.997) {
    if (!this.spec) return;
    const d = this.spec.data, n = Math.min(d.length, 200000), step = d.length / n, a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = d[Math.floor(i * step)];
    a.sort();
    this.setLevels(a[Math.floor(pLo * (n - 1))], a[Math.floor(pHi * (n - 1))]);
  }
  setColormap(name) { this.lut = makeLUT(name); this._invalidate(); }
  setMode(m) { this.mode = m; this.canvas.style.cursor = m === 'pan' ? 'grab' : 'crosshair'; }
  setOverlay(id, ov) { this.overlays.set(id, ov); this._draw(); }
  removeOverlay(id) { this.overlays.delete(id); this._draw(); }
  clearOverlays() { this.overlays.clear(); this._draw(); }
  setOverlays(entries) {
    const it = entries instanceof Map ? entries.entries() : Array.isArray(entries) ? entries : Object.entries(entries || {});
    this.overlays = new Map(it);
    this._draw();
  }
  setCursor(t) { this.cursorT = t; this._draw(); }
  destroy() { this._ro.disconnect(); this.canvas.remove(); }

  // coordinate transforms (CSS pixels relative to canvas)
  plotRect() { const m = this.margin; return { x: m.l, y: m.t, w: Math.max(1, this.cssW - m.l - m.r), h: Math.max(1, this.cssH - m.t - m.b) }; }
  tToX(t) { const r = this.plotRect(), v = this.view; return r.x + (t - v.t0) / (v.t1 - v.t0) * r.w; }
  fToY(f) { const r = this.plotRect(), v = this.view; return r.y + r.h - (f - v.f0) / (v.f1 - v.f0) * r.h; }
  xToT(x) { const r = this.plotRect(), v = this.view; return v.t0 + (x - r.x) / r.w * (v.t1 - v.t0); }
  yToF(y) { const r = this.plotRect(), v = this.view; return v.f0 + (r.y + r.h - y) / r.h * (v.f1 - v.f0); }
  valueAt(t, f) {
    const s = this.spec; if (!s) return NaN;
    const i = Math.round((t - s.t0) / s.dt), j = Math.round((f - s.f0) / s.df);
    return i >= 0 && i < s.nT && j >= 0 && j < s.nF ? s.data[i * s.nF + j] : NaN;
  }

  // ---------------------------------------------------------------- rendering
  _resize() {
    const r = this.container.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = Math.max(50, r.width); this.cssH = Math.max(50, r.height);
    this.canvas.width = Math.round(this.cssW * this.dpr); this.canvas.height = Math.round(this.cssH * this.dpr);
    this._invalidate();
  }
  _invalidate() {
    this._dirtyImg = true;
    if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }
  _renderImage() {
    const s = this.spec, r = this.plotRect();
    const W = Math.max(1, Math.round(r.w * this.dpr)), H = Math.max(1, Math.round(r.h * this.dpr));
    this.img.width = W; this.img.height = H;
    if (!s) return;
    const ictx = this.img.getContext('2d');
    const id = ictx.createImageData(W, H), px = new Uint32Array(id.data.buffer);
    const v = this.view, { nT, nF, data } = s;
    // pixel row -> frequency-bin range (top row = high f)
    const fLo = new Int32Array(H), fHi = new Int32Array(H);
    for (let y = 0; y < H; y++) {
      const [a, b] = cellRange(v.f1 - (y + 1) / H * (v.f1 - v.f0), v.f1 - y / H * (v.f1 - v.f0), s.f0, s.df);
      fLo[y] = Math.max(0, Math.min(nF - 1, a)); fHi[y] = Math.max(0, Math.min(nF - 1, b));
    }
    const col = new Float32Array(nF);
    const [lo, hi] = this.levels, k = 255 / (hi - lo), g = this.gamma, lut = this.lut;
    const gl = new Uint8Array(1024); // gamma LUT on normalised value
    for (let i = 0; i < 1024; i++) gl[i] = Math.round(255 * Math.pow(i / 1023, g));
    const bg = lut[0];
    // zoomed out by >= 8 time cells per pixel column: use the pooled pyramid (built once per spectrogram)
    const cellsPerPx = (v.t1 - v.t0) / s.dt / W;
    let levels = [];
    if (cellsPerPx >= 8) {
      if (this._pyr?.spec !== s) this._pyr = { spec: s, levels: buildTimePyramid(data, nT, nF) };
      levels = this._pyr.levels.filter((l) => l.F <= cellsPerPx);
    }
    for (let x = 0; x < W; x++) {
      let [i0, i1] = cellRange(v.t0 + x / W * (v.t1 - v.t0), v.t0 + (x + 1) / W * (v.t1 - v.t0), s.t0, s.dt);
      if (i1 < 0 || i0 >= nT) { for (let y = 0; y < H; y++) px[y * W + x] = bg; continue; }
      i0 = Math.max(0, i0); i1 = Math.min(nT - 1, i1);
      // max over time cells in this column
      const jMin = fLo[H - 1], jMax = fHi[0];
      for (let j = jMin; j <= jMax; j++) col[j] = -Infinity;
      maxRowsInto(col, jMin, jMax, data, nF, levels, i0, i1);
      for (let y = 0; y < H; y++) {
        let m = -Infinity;
        for (let j = fLo[y]; j <= fHi[y]; j++) if (col[j] > m) m = col[j];
        let q = (m - lo) * k;
        q = q < 0 ? 0 : q > 255 ? 255 : q;
        px[y * W + x] = lut[g === 1 ? q | 0 : gl[(q * 4.0118) | 0]];
      }
    }
    ictx.putImageData(id, 0, 0);
  }
  _draw() {
    const ctx = this.ctx, dpr = this.dpr, r = this.plotRect();
    if (this._dirtyImg) { this._renderImage(); this._dirtyImg = false; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.img, Math.round(r.x * dpr), Math.round(r.y * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._drawAxes(r);
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    for (const ov of this.overlays.values()) if (ov.type === 'band') this._drawBand(ov, r);
    for (const ov of this.overlays.values()) if (ov.type !== 'band') this._drawOverlay(ov);
    if (this.cursorT != null) {
      const x = this.tToX(this.cursorT);
      ctx.strokeStyle = 'rgba(255,80,80,0.9)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke();
    }
    if (this.drag?.kind === 'box') {
      const { x0, y0, x1, y1 } = this.drag;
      ctx.strokeStyle = '#fff'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([]);
    }
    if (this.hover) {
      const { x, y } = this.hover;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); ctx.stroke();
      const t = this.xToT(x), f = this.yToF(y), db = this.valueAt(t, f);
      const txt = `t ${t.toFixed(2)} s   f ${f.toFixed(1)} Hz   ${Number.isFinite(db) ? db.toFixed(1) + ' dB' : ''}`;
      ctx.font = '12px system-ui, sans-serif';
      const w = ctx.measureText(txt).width + 10;
      const bx = Math.min(x + 10, r.x + r.w - w), by = y > r.y + 30 ? y - 24 : y + 8;
      ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(bx, by, w, 18);
      ctx.fillStyle = '#fff'; ctx.fillText(txt, bx + 5, by + 13);
    }
    ctx.restore();
  }
  _drawBand(ov, r) {
    const ctx = this.ctx;
    const x0 = Math.max(r.x, this.tToX(ov.t0)), x1 = Math.min(r.x + r.w, this.tToX(ov.t1));
    if (!(x1 > x0)) return;
    const y0 = ov.f1 != null ? Math.max(r.y, this.fToY(ov.f1)) : r.y;
    const y1 = ov.f0 != null ? Math.min(r.y + r.h, this.fToY(ov.f0)) : r.y + r.h;
    if (!(y1 > y0)) return;
    ctx.fillStyle = ov.fill || 'rgba(141,180,255,0.15)';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    if (ov.stroke) {
      ctx.strokeStyle = ov.stroke; ctx.lineWidth = 1; ctx.setLineDash(ov.dash || []);
      ctx.beginPath();
      if (this.tToX(ov.t0) >= r.x) { ctx.moveTo(x0 + 0.5, y0); ctx.lineTo(x0 + 0.5, y1); }
      if (this.tToX(ov.t1) <= r.x + r.w) { ctx.moveTo(x1 - 0.5, y0); ctx.lineTo(x1 - 0.5, y1); }
      ctx.stroke(); ctx.setLineDash([]);
    }
    if (ov.label && x1 - x0 > 40) {
      ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = ov.labelColor || ov.stroke || '#cfe0ff';
      ctx.fillText(ov.label, x0 + 5, y0 + 13);
    }
  }
  _drawOverlay(ov) {
    const ctx = this.ctx, pts = ov.points || [];
    if (!pts.length) return;
    const P = (p) => (Array.isArray(p) ? [p[0], p[1]] : [p.t, p.f]);
    ctx.strokeStyle = ov.color || '#ff0'; ctx.fillStyle = ov.color || '#ff0';
    ctx.lineWidth = ov.width ?? 1.5; ctx.setLineDash(ov.dash || []);
    if (ov.line !== false) {
      ctx.beginPath();
      let pen = false;
      for (const p of pts) {
        const [t, f] = P(p);
        if (!Number.isFinite(t) || !Number.isFinite(f)) { pen = false; continue; }
        const x = this.tToX(t), y = this.fToY(f);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (ov.markers) for (const p of pts) {
      const [t, f] = P(p);
      ctx.beginPath(); ctx.arc(this.tToX(t), this.fToY(f), ov.markerSize ?? 3, 0, 2 * Math.PI); ctx.fill();
    }
    if (ov.label) {
      const [t, f] = P(pts[0]);
      ctx.font = '12px system-ui, sans-serif'; ctx.fillText(ov.label, this.tToX(t) + 4, this.fToY(f) - 4);
    }
  }
  _drawAxes(r) {
    const ctx = this.ctx, v = this.view;
    ctx.strokeStyle = '#888'; ctx.fillStyle = '#ccc'; ctx.lineWidth = 1;
    ctx.font = '11px system-ui, sans-serif';
    ctx.strokeRect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1);
    const ts = niceStep(v.t1 - v.t0, r.w / 90);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let t = Math.ceil(v.t0 / ts) * ts; t <= v.t1; t += ts) {
      const x = this.tToX(t);
      ctx.beginPath(); ctx.moveTo(x, r.y + r.h); ctx.lineTo(x, r.y + r.h + 4); ctx.stroke();
      ctx.fillText(fmtTime(t, ts), x, r.y + r.h + 6);
    }
    const fsStep = niceStep(v.f1 - v.f0, r.h / 40);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let f = Math.ceil(v.f0 / fsStep) * fsStep; f <= v.f1; f += fsStep) {
      const y = this.fToY(f);
      ctx.beginPath(); ctx.moveTo(r.x - 4, y); ctx.lineTo(r.x, y); ctx.stroke();
      ctx.fillText(fsStep < 1 ? f.toFixed(1) : String(Math.round(f)), r.x - 6, y);
    }
    ctx.save(); ctx.translate(10, r.y + r.h / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.fillText('Hz', 0, 0); ctx.restore();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  // ---------------------------------------------------------------- interaction
  _bind() {
    const c = this.canvas;
    const pos = (e) => { const b = c.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
    this._onWheel = (e) => {
      e.preventDefault();
      const { x, y } = pos(e), r = this.plotRect(), z = Math.exp(Math.sign(e.deltaY) * 0.15 * Math.min(3, Math.abs(e.deltaY) / 50 || 1));
      const v = this.view;
      if (e.shiftKey || x < r.x) {
        const f = this.yToF(y);
        this.setView({ f0: f - (f - v.f0) * z, f1: f + (v.f1 - f) * z });
      } else {
        const t = this.xToT(x);
        this.setView({ t0: t - (t - v.t0) * z, t1: t + (v.t1 - t) * z });
      }
    };
    c.addEventListener('wheel', this._onWheel, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const { x, y } = pos(e);
      const panLike = this.mode === 'pan' || e.shiftKey || e.button === 1 || e.button === 2;
      this.drag = { kind: panLike ? 'pan' : this.mode === 'box' ? 'box' : 'click', x0: x, y0: y, x1: x, y1: y,
        v: this.getView(), moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      const { x, y } = pos(e), r = this.plotRect();
      const inside = x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
      this.hover = inside ? { x, y } : null;
      if (inside) this._emit('hover', { t: this.xToT(x), f: this.yToF(y), db: this.valueAt(this.xToT(x), this.yToF(y)) });
      const d = this.drag;
      if (d) {
        d.x1 = x; d.y1 = y;
        if (Math.hypot(x - d.x0, y - d.y0) > 4) d.moved = true;
        if (d.kind === 'click' && d.moved) d.kind = 'pan';
        if (d.kind === 'pan' && d.moved) {
          const dt = (x - d.x0) / r.w * (d.v.t1 - d.v.t0), df = (y - d.y0) / r.h * (d.v.f1 - d.v.f0);
          this.setView({ t0: d.v.t0 - dt, t1: d.v.t1 - dt, f0: d.v.f0 + df, f1: d.v.f1 + df });
          return;
        }
      }
      this._draw();
    });
    c.addEventListener('pointerup', (e) => {
      const d = this.drag; this.drag = null;
      if (!d) return;
      const t = this.xToT(d.x1), f = this.yToF(d.y1);
      if (d.kind === 'click' && !d.moved) this._emit('pick', { t, f, db: this.valueAt(t, f), event: e });
      else if (d.kind === 'box' && d.moved) {
        const b = { t0: Math.min(this.xToT(d.x0), t), t1: Math.max(this.xToT(d.x0), t),
          f0: Math.min(this.yToF(d.y0), f), f1: Math.max(this.yToF(d.y0), f) };
        this._emit('box', b);
      }
      this._draw();
    });
    c.addEventListener('pointerleave', () => { this.hover = null; this._draw(); });
    c.addEventListener('dblclick', () => this.resetView());
  }
}
