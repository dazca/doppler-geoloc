// Radix-2 FFT with precomputed twiddles / bit-reversal. Pure ES module (browser + Node).
//
//   const fft = createFFT(n);            // n = power of two
//   fft.complex(re, im)                  // in-place complex forward FFT, length n (Float64Array)
//   fft.real(x, outRe, outIm)            // real forward FFT of x (length n, any typed array);
//                                        // writes bins 0..n/2 (length n/2+1) into outRe/outIm
//   fft.power(x, out)                    // |X[k]|^2, k=0..n/2 into out (length n/2+1)
//
// The real transform packs x into a complex sequence of length n/2, runs one half-size
// complex FFT and splits the result (standard "two-for-one" trick) => ~2x faster than
// a full complex FFT of length n.

export function isPow2(n) { return n > 0 && (n & (n - 1)) === 0; }
export function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

function makeComplexPlan(m) {
  // plan for complex FFT of length m
  const bits = Math.round(Math.log2(m));
  const rev = new Uint32Array(m);
  for (let i = 0; i < m; i++) {
    let r = 0, x = i;
    for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  const half = m >> 1;
  const cosT = new Float64Array(Math.max(half, 1));
  const sinT = new Float64Array(Math.max(half, 1));
  for (let i = 0; i < half; i++) {
    cosT[i] = Math.cos(2 * Math.PI * i / m);
    sinT[i] = -Math.sin(2 * Math.PI * i / m); // forward transform e^{-i...}
  }
  return { m, rev, cosT, sinT };
}

function complexInPlace(plan, re, im) {
  const { m, rev } = plan;
  for (let i = 0; i < m; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  butterflies(plan, re, im);
}

// butterflies on bit-reversed input
function butterflies(plan, re, im) {
  const { m, cosT, sinT } = plan;
  let size;
  if (m >= 4) {
    // fused size-2 + size-4 stages (radix-4 with trivial twiddles 1, -i)
    for (let i = 0; i < m; i += 4) {
      const r0 = re[i], i0 = im[i], r1 = re[i + 1], i1 = im[i + 1];
      const r2 = re[i + 2], i2 = im[i + 2], r3 = re[i + 3], i3 = im[i + 3];
      const ar = r0 + r1, ai = i0 + i1, br = r0 - r1, bi = i0 - i1;
      const cr = r2 + r3, ci = i2 + i3, dr = r2 - r3, di = i2 - i3;
      re[i] = ar + cr; im[i] = ai + ci;
      re[i + 2] = ar - cr; im[i + 2] = ai - ci;
      re[i + 1] = br + di; im[i + 1] = bi - dr;   // b + (-i) d
      re[i + 3] = br - di; im[i + 3] = bi + dr;
    }
    size = 8;
  } else {
    for (let i = 0; i + 1 < m; i += 2) {
      const ar = re[i], ai = im[i], br = re[i + 1], bi = im[i + 1];
      re[i] = ar + br; im[i] = ai + bi; re[i + 1] = ar - br; im[i + 1] = ai - bi;
    }
    size = 4;
  }
  for (; size <= m; size <<= 1) {
    const halfSize = size >> 1;
    const step = m / size;
    for (let start = 0; start < m; start += size) {
      let k = 0;
      for (let j = start, end = start + halfSize; j < end; j++, k += step) {
        const l = j + halfSize;
        const wr = cosT[k], wi = sinT[k];
        const xr = re[l], xi = im[l];
        const tr = xr * wr - xi * wi;
        const ti = xr * wi + xi * wr;
        re[l] = re[j] - tr; im[l] = im[j] - ti;
        re[j] += tr; im[j] += ti;
      }
    }
  }
}

export function createFFT(n) {
  if (!isPow2(n) || n < 2) throw new Error(`FFT size must be a power of two >= 2, got ${n}`);
  const fullPlan = makeComplexPlan(n);
  const m = n >> 1;
  const halfPlan = makeComplexPlan(m);
  // split twiddles W_n^k, k = 0..m
  const wr = new Float64Array(m + 1), wi = new Float64Array(m + 1);
  for (let k = 0; k <= m; k++) { wr[k] = Math.cos(2 * Math.PI * k / n); wi[k] = -Math.sin(2 * Math.PI * k / n); }
  const zr = new Float64Array(m), zi = new Float64Array(m);

  function real(x, outRe, outIm) {
    const rev = halfPlan.rev;   // pack + bit-reverse in one pass
    for (let k = 0; k < m; k++) { const r = rev[k]; zr[r] = x[2 * k]; zi[r] = x[2 * k + 1]; }
    butterflies(halfPlan, zr, zi);
    // k = 0 and k = m
    outRe[0] = zr[0] + zi[0]; outIm[0] = 0;
    outRe[m] = zr[0] - zi[0]; outIm[m] = 0;
    for (let k = 1; k < m; k++) {
      const ar = zr[k], ai = zi[k], br = zr[m - k], bi = -zi[m - k]; // b = conj(Z[m-k])
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);              // Xe
      // Xo = (a - b) / (2i) = -i/2 * (a - b)
      const dr = ar - br, di = ai - bi;
      const or_ = 0.5 * di, oi = -0.5 * dr;
      const c = wr[k], s = wi[k];
      outRe[k] = er + (or_ * c - oi * s);
      outIm[k] = ei + (or_ * s + oi * c);
    }
  }

  const pr = new Float64Array(m + 1), pi = new Float64Array(m + 1);
  function power(x, out) {
    real(x, pr, pi);
    for (let k = 0; k <= m; k++) out[k] = pr[k] * pr[k] + pi[k] * pi[k];
    return out;
  }

  return {
    n,
    complex: (re, im) => complexInPlace(fullPlan, re, im),
    real,
    power,
  };
}
