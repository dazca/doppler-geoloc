# MATH — Doppler geolocation from passing aircraft (Lane A)

All symbols in SI units. Conventions follow `docs/CONTRACTS.md`: ENU metres around a reference point,
Unix seconds for ADS-B time, audio time `t_a = t_unix − T_start` with `T_start` unknown.

Notation:

| symbol | meaning |
|---|---|
| `r_o` | observer position (ENU), ground height from DEM (+ microphone height, ~1.5 m, usually ignored) |
| `r_s(t)` | source (aircraft) position from the interpolated ADS-B track |
| `v_s(t) = ṙ_s(t)` | source velocity (ground frame) |
| `t_e`, `t_rx` | emission time and reception time |
| `R(t_e) = ‖r_o − r_s(t_e)‖` | slant range at emission |
| `u = (r_o − r_s)/R` | unit vector source → observer at emission |
| `v_r = v_s · u` | radial (closing) velocity, > 0 while approaching |
| `c` | speed of sound (343 m/s at 20 °C; `c = 331.3·√(1+T/273.15)`) |
| `β = v/c`, `M = max‖v_s‖/c` | Mach numbers (props: v ≈ 40–90 m/s ⇒ β ≈ 0.12–0.26) |
| `F0` | rest-frame frequency of a tone (blade-pass or engine-order line) |

---

## 1. Retarded time

A wavefront emitted at `t_e` reaches the observer at

    t_rx = t_e + R(t_e)/c.                                    (1.1)

For the spectrogram we need the inverse: given `t_rx`, find `t_e`. Define

    g(t_e) = t_e + R(t_e)/c − t_rx,      g'(t_e) = 1 + Ṙ/c = 1 − v_r(t_e)/c,          (1.2)

because `Ṙ = −(r_o − r_s)·v_s / R = −v_r`. Since `|v_r| ≤ ‖v_s‖ < c` (subsonic), `g' ∈ [1−M, 1+M] > 0`:
`g` is strictly increasing, so **(1.1) has exactly one solution** for every `t_rx` (for supersonic
sources it would not — irrelevant here).

**Fixed-point iteration** `t_e ← t_rx − R(t_e)/c`. The map has derivative `φ' = −Ṙ/c = v_r/c`,
so `|φ'| ≤ M < 1`: a contraction, globally convergent, linearly with ratio `M`.
From the initial guess `t_e⁰ = t_rx − R(t_rx)/c` the error is ≤ `M·R/c` (e.g. 0.35·3000/343 ≈ 3 s), and
after n steps ≤ `Mⁿ·M R/c` — about 15 iterations for 1 µs at M = 0.35.

**Newton** `t_e ← t_e − g/g'` with `g' = 1 − v_r/c` (velocity is available analytically from the
Hermite interpolant, §5). `g'' = −(a·u)/c + (‖v‖² − v_r²)/(c R)`, so for a prop at R = 3 km,
`|g''/(2g')| ≈ 1.5·10⁻³ s⁻¹`; errors go 3 s → 1.4·10⁻² s → 3·10⁻⁷ s → 10⁻¹⁶ s. **Three iterations
reach machine precision; the reference uses 4** (`doppler.emission_time`). Validated against a
bracketed root finder (`brentq`) and against a completely independent forward model (dense emission
grid + inverse interpolation) in `ref/tests/test_physics.py`.

Numerical note: Unix times ~1.7·10⁹ s have a float64 resolution of 2.4·10⁻⁷ s (14 µm of aircraft
travel) — harmless, but **never use float32 for absolute times** (resolution 128 s!). In JS keep
Float64 or subtract an epoch.

## 2. Doppler: exact vs first-order

Phase is conserved along rays: the phase received at `t_rx` is the phase emitted at `t_e(t_rx)`,
`φ_rx(t_rx) = 2πF0·t_e(t_rx)`. Hence

    f(t_rx) = F0 · dt_e/dt_rx = F0 / g'(t_e) = F0 · c / (c − v_r(t_e)).             (2.1)

This is the contract's exact formula, and it is exact for any trajectory (curved, accelerating) in still,
homogeneous air. `v_r` must be evaluated **at the emission time**, not at `t_rx`.

First-order form `f ≈ F0(1 + v_r/c)`. With `b = v_r/c`:

    f_exact − f_1st = F0 [1/(1−b) − (1+b)] = F0 · b² / (1 − b).                      (2.2)

| v_r (m/s) | b | error / F0 (approaching) | receding (b<0) | at F0 = 130 Hz, k=4 harmonic |
|---|---|---|---|---|
| 50 | 0.146 | **2.5 %** | 1.9 % | 3.2 Hz → 13 Hz |
| 80 | 0.233 | 7.1 % | 4.4 % | 9.2 Hz → 37 Hz |
| 120 | 0.350 | **18.8 %** | 9.1 % | 24 Hz → 98 Hz |

The spectrogram bin is ~2 Hz, so the first-order model is **not acceptable**: always use (2.1).
Note also the asymmetry: the exact curve rises more above F0 than it drops below it.

## 3. Straight constant-speed pass: closed form

Let the source move on a straight line at speed v, at slant distance d from the observer at the CPA
instant `t_c` (3D: altitude and horizontal offset are both inside d — the geometry is planar in the plane
containing the line and the observer). Put `T = t_rx − t_c`, `τ = t_e − t_c`. Then
`R(τ)² = d² + v²τ²` and (1.1) becomes `c(T−τ) = √(d²+v²τ²)`, i.e.

    (c² − v²) τ² − 2c²T τ + (c²T² − d²) = 0,
    τ(T) = [T − S(T)] / (1 − β²),     S(T) = √(β²T² + (1−β²) d²/c²)                 (3.1)

(the root with τ < T). With `v_r = −v²τ/R` and `R = c(T−τ)`, (2.1) simplifies to

    f(T) = F0/(1−β²) · [1 − β T / √(T² + τ0²)],      τ0 = d·√(1−β²) / v.             (3.2)

So the curve is an *algebraic sigmoid* `x/√(1+x²)` (tanh-like) — **exact, retardation included**:

* asymptotes: `f_hi = F0/(1−β)` (T→−∞), `f_lo = F0/(1+β)` (T→+∞), so
  `f_hi/f_lo = (c+v)/(c−v)`, **`v = c (f_hi − f_lo)/(f_hi + f_lo)`**, and
  **`F0 = 2 f_hi f_lo/(f_hi + f_lo)`** (harmonic mean — *not* the arithmetic mean);
* centre of point symmetry: `T = 0` (i.e. `t_rx = t_c`!) at `f_mid = (f_hi+f_lo)/2 = F0/(1−β²)`;
* `f = F0` exactly at `T = d/c`: the **delayed CPA time** `t_dcpa = t_c + d/c` (CPA emission arrives);
* slope at the delayed CPA (differentiate (3.2), using `T² + τ0² = d²/(β²c²)` at `T = d/c`):

      df/dt |_(t_dcpa) = −F0 v² / (c d)      (exact, not an approximation)              (3.3)

* maximum slope is at the symmetry centre `T=0`: `−F0 v² / (c d (1−β²)^{3/2})` (4 % steeper at β = 0.166);
* time scale: 10 %→90 % of the swing takes `2.67 τ0 ≈ 2.67 d/v` (e.g. 750 m at 57 m/s: 35 s).

**Identifiability from one curve.** The map `(F0, v, d, t_c) ↔ (f_mid, swing, τ0, centre)` is a
bijection: the frequency ratio fixes v independently of d, the width fixes d given v
(`d = v τ0/√(1−β²)`), so `δd/d = δv/v ⊕ δτ0/τ0` — speed errors propagate 1:1 into distance errors.
Pitfalls when reading the curve by eye:

1. the visible part ends where the aircraft becomes inaudible, `|T| ≲ √(R_max²−d²)/v`; with
   R_max/d = 3 one only sees ±94 % of the swing ⇒ v is underestimated by ~6 % unless the model is fitted;
2. the "centre line" read by eye is the arithmetic midpoint `F0/(1−β²)` (2.8 % high at 57 m/s) and the
   "centre time" is the symmetry point `t_c`, which precedes the delayed CPA by `d/c` (2–4 s). These
   biases differ between two events by `(d_B−d_A)/c` ≈ 1–2 s, eating into the time-offset tolerance.
   A least-squares fit of (3.2) (§9, `fit.py`) removes both.

Numbers for the scenario-1 first pass (F0 = 128 Hz, v = 57.5 m/s, d = 748 m): swing 109.6 → 153.8 Hz,
τ0 = 12.8 s, slope −1.65 Hz/s at fundamental, −6.6 Hz/s at the 4th harmonic.

## 4. Real tracks: curved, accelerating, climbing

(3.2) is only a local model. The reference simulation uses the real interpolated track:
for each `t_rx` on the score grid solve (1.1) by Newton, then `f = F0·c/(c − v_s(t_e)·u(t_e))`.
Turns/accelerations change the curve noticeably — for scenario 2, flight Q3 (turn ending at the CPA), a
straight-line fit returns v = 49 m/s, d = 626 m vs truth 64 m/s / 860 m. This is why the final scoring
must use the track-based simulation, and why the v/d filters must be loose.

**Delayed CPA time for a track.** `t_cpa = argmin_t ‖r_o − r_s(t)‖` (global minimum within the track),
`d_cpa = R(t_cpa)` (3D slant), `t_dcpa = t_cpa + d_cpa/c`. By construction `v_r(t_cpa) = 0`, so
`f(t_dcpa) = F0` for any track — the delayed CPA is the time of the F0 crossing. (Reference:
dense 0.5 s sampling + parabolic refinement of R². R(t) is very flat at the minimum so t_cpa is only
defined to ~0.1–0.2 s for far observers, which is irrelevant for d and for the 5–10 s offset tolerance.)

## 5. Track interpolation

ADS-B (OpenSky/adsb.lol) gives positions every ~1–10 s with gaps, CPR/NACp noise of a few metres,
and altitudes quantized to 25 ft (7.6 m). Doppler needs **velocity**, so linear interpolation is wrong
(velocity jumps ⇒ frequency jumps of `F0·Δv_r/c` at each knot). The reference uses a C¹ piecewise
cubic Hermite in ENU with non-uniform three-point tangents (exact for quadratic motion; formula in
`ref/doppler_ref/track.py`). Error budget:

* tangent error ≈ `h²/6·|p'''|`; for a 3°/s turn (`|p'''| = vω² = 0.16 m/s³`) and h = 10 s: 2.6 m/s of
  velocity error ⇒ `Δf ≈ F0·Δv/c` = 1 Hz at the fundamental, 4 Hz at k=4 — comparable to a bin;
* position noise σ_p = 3 m at h = 1–5 s ⇒ velocity noise ~σ_p/h ≈ 1 m/s;
* altitude quantization ⇒ spurious vertical speed ±7.6/h m/s (only matters when u has a large
  vertical component, i.e. when the observer is nearly under the aircraft).

Improvements: use the ADS-B *reported* velocity (ground speed, track, vertical rate) as Hermite
tangents; smooth with a local quadratic over ±10–15 s; flag gaps > 20 s around the CPA as low-confidence.

## 6. Altitude, terrain and slant geometry

`r_o = ENU(lat, lon, h_DEM)`, `r_s = ENU(lat, lon, h_ac)`, slant `d = ‖r_o − r_s‖` exactly in 3D
(no flat-earth approximation is needed since ENU is computed from ECEF). Datum issues:

* DEMs (SRTM, Copernicus) are orthometric (EGM96/EGM2008); ADS-B "geometric altitude" is GNSS
  height above the WGS84 ellipsoid (geoid undulation N = 30–50 m in Europe/US); ADS-B "baro altitude"
  is pressure altitude referenced to 1013.25 hPa, which differs from true altitude by
  ~30 ft/hPa ⇒ ±100–300 m on non-standard days, plus temperature error ~4 %/10 °C of height.
* Effect: an altitude bias δh changes the slant distance by `(h/d)·δh` and leaves the CPA time almost
  untouched (`δt_dcpa = δd/c` ~0.1 s). The search compensates by moving the observer sideways by
  `δy ≈ −(h/y)·δh` (y = horizontal offset from the track): **a 100 m baro error gives ~60 m error for
  y ≈ 1.6h, but kilometres when the observer is nearly under the track** (`y → 0`). Use geometric
  altitude when available, or correct baro with QNH from a METAR. Experiments: LANE_A_REPORT §Robustness.

## 7. Harmonics

Piston props radiate lines at multiples of the engine half-order `N/120` (N = rpm), strongest at the
blade-pass frequency `BPF = B·N/60` (2-blade at 2400–2700 rpm: 80–90 Hz; 3-blade: 120–135 Hz, cf. the
~130 Hz in the video) and the firing frequency `n_cyl·N/120`. The Doppler factor `c/(c − v_r)` is
multiplicative, so every line k·F0 follows the same ratio curve `ρ(t) = f(t)/F0`:

* the swing in Hz grows with k, so a fixed bin width `Δf` gives relative resolution `Δf/(k F0)` —
  higher harmonics resolve v, d and timing better (until absorption/SNR kill them, roughly > 1 kHz);
* scoring `Σ_k w_k · Z(t, k F0 ρ(t))` coherently stacks the evidence (≈ √K SNR gain for equal lines);
* picking "F0" as the 2nd line instead of the fundamental is harmless for scoring (lines still match);
  but missing odd/half orders loses SNR. The reference uses k = 1..4.

## 8. Error sources: wind, temperature, ground, recording

**Wind (uniform w).** The ray obeys `D − wτ = cτ n` (n = wavefront normal). Differentiating,
`dτ/dt_e = −v·n/(c + w·n)`, hence

    f = F0 · c_eff / (c_eff − v_s·n),     c_eff = c + w·n.                              (8.1)

So wind acts like a direction-dependent speed of sound: (i) Doppler changes only at order `β·w/c`
(10 m/s ⇒ 0.5 % of F0 ⇒ 0.6 Hz / 2.5 Hz at k=1 / 4) — partly absorbed by the F0 sweep but making
approach and recession asymmetric; (ii) the propagation delay changes by `−R(w·n)/c²` ≈ 0.1 s at 1 km,
10 m/s — negligible against the time tolerance. Use **ground** speed (ADS-B), not airspeed.
Wind gradients refract sound (upwind shadow zones) and change audibility, which matters for the silence filter.

**Temperature.** δc/c ≈ 0.18 %/°C. β = v/c scales the swing by the same fraction (10 °C ⇒ 1.8 %); delays
R/c change by 1.8 % (≈ 0.05 s at 1 km). Small; take T from METAR. Temperature lapse (−6.5 °C/km) bends
rays upward (shadow zone) — another audibility effect.

**Ground reflection (Lloyd's mirror).** Direct and ground-reflected rays interfere; path difference
`Δ ≈ 2 h_s h_r / R` gives moving notches at `f_n = (2n+1) c/(2Δ)`. For a microphone at h_r = 1.5 m,
h_s = 500 m, R = 1 km: Δ = 1.5 m, first notch ≈ 114 Hz — right in the band of interest. The notches
sweep in time as R changes; they can cancel a harmonic for many seconds (score dips) but also encode
geometry (`h_r`, elevation angle) and could be modelled as an additional score term.

**Recording.** (i) Cuts/edits in the video invalidate the time offset; (ii) speed changes
(PAL 25/24 fps speed-up = 4.2 %) scale both frequency (absorbed by F0) **and time** (920 s → ±38 s
error!) — test a time-scale factor if the offset tolerance fails; (iii) AGC/compression changes levels
(harmless after whitening); (iv) wind noise on the microphone raises the low-frequency floor.

## 9. Scoring

The spectrogram (contract format, dB) is **whitened per frequency bin**: `z = (S − median_t)/(1.4826·MAD_t)`
clipped to [−3, 8]. This removes stationary hums (they never move like a Doppler curve) and makes values
comparable across frequencies. A hypothesis `H = (r_o, flights, T_start, F0_e)` predicts, for event e,
the ridge `k·F0_e·ρ_e(t)` over the audible part of the pass (`R < R_aud`, ±60 s around `t_dcpa`).
Score:

    S(H) = Σ_e  mean_{t∈audible, k=1..K}  z(t − T_start, k F0_e ρ_e(t))       (bilinear sampling)

Under "whitened noise ≈ N(0,1) i.i.d." and a weak ridge of known shape, Σ z along the ridge is the
log-likelihood-ratio statistic (matched filter); the mean (instead of the sum) avoids favouring
hypotheses with longer audible windows. Nuisance parameters are profiled: T_start (shared by all events:
the offsets are locked by geometry) is swept ±4 s around the value implied by event 0 and each event's
F0 independently ±4 % (the score is separable per event given T_start).

## 10. Sensitivity and identifiability

Let `σ_f` be the effective frequency precision of the score (≈ bin/k ~ 0.5 Hz for k up to 4 with stacking).

* **Timing.** Near the CPA the curve moves `|df/dt| = F0v²/(cd)` ≈ 1.6 Hz/s (k=1), 6.6 Hz/s (k=4)
  ⇒ the event time is pinned to σ_t ≈ 0.1–0.3 s.
* **Distance.** `∂f/∂d` is largest at `T = τ0/√2`: `δf_max ≈ 0.385·Δ·δd/d` with Δ = F0β/(1−β²) the half
  swing (22 Hz in scenario 1) ⇒ 10 % in d moves the curve by 0.85 Hz (k=1) / 3.4 Hz (k=4): d is
  resolved to ~5–10 %. On the ground `δd = (y/d)·δy` ⇒ δy ≈ (d/y)·δd ≈ 50–100 m; poor when y → 0
  (observer below the track: `d ≈ h + y²/2h` is flat in y, and there is a left/right mirror ambiguity).
* **One event.** Since T_start is unknown, t_c carries no information. Only d (and, for curved or
  accelerating tracks, *which part* of the track matches the measured v and curve shape) constrain the
  position ⇒ the solution set is a pair of curves parallel to the track (left/right) at horizontal offset
  `√(d²−h²)`, cut only by the silence filter and by track non-uniformity: km-scale ambiguity.
  Experiments confirm this (LANE_A_REPORT). If the video has a trustworthy timestamp (T_start known to
  ±2 s) a single event becomes usable: t_c pins the along-track coordinate.
* **Two events.** The offset `Δ = t_dcpa,B − t_dcpa,A` is one scalar equation. Linearising around a
  point with along-track unit vectors e_A, e_B: `δΔ = (e_B/v_B − e_A/v_A)·δp + (δd_B − δd_A)/c`. So the
  offset constrains position along `g = e_B/v_B − e_A/v_A` with precision `σ_t/‖g‖` — e.g. perpendicular
  tracks at 60 m/s: ‖g‖ = 1/42 s/m ⇒ **~13 m per 0.3 s**. Combined with the two d-constraints this gives a
  finite set of points (the left/right ambiguities are resolved by the second d). Degenerate geometry:
  parallel tracks flown in the same direction at the same speed (g ≈ 0) ⇒ the offset carries no
  information. This is the "dilution of precision" of the method.
* **Three or more events**: two independent offsets ⇒ the horizontal position is fixed by timing alone;
  the d constraints become a consistency check (much more robust; see scenario 2).
* **Unknown recording start** is a single nuisance shift shared by all events; it never biases the
  position as long as the audio timeline is continuous and unscaled.

## 11. Improvements to the method (recommended)

1. **Automatic event measurement** instead of manual reading: harmonic-stacked ridge tracking
   (per-frame argmax of Σ_k z(t, k f) over a ±30 % band, sub-bin parabolic refinement; Viterbi/DP to
   enforce continuity in noisy clips) followed by a robust least-squares fit of (3.2) for
   (F0, v, d, t_c) with covariance. On the synthetic scenarios this gives v within 1–5 %, d within 1–6 %
   and t_dcpa within 0.1–1 s for straight passes (vs ±15 %/±30 %/±3 s by eye) — but biased for passes
   in a turn, so keep ranges generous (we use ±20 % v, ±40 % d) and let the physical simulation decide.
2. **Fit the track-based model, not only straight lines**: once a candidate flight is chosen, the
   only free parameters are r_o (2D), T_start and F0 — do Gauss-Newton on the ridge points with the
   exact simulation (fast, gives an uncertainty ellipse) instead of only a grid.
3. **Whitening + likelihood instead of raw dB pixel sum**: raw dB sums favour loud broadband events
   (wind gusts, jets) and bins with higher background. Per-bin z-scores (done) and optionally a weighting
   by expected SNR (∝ 1/R²·harmonic amplitude) make the score a proper matched filter. Also blur the
   curve by the window's frequency kernel (or sample the max over ±1 bin) for robustness to small
   model errors.
4. **Harmonic stacking** k = 1..K (done, K=4) and optionally half orders.
5. **Coarse-to-fine** (done): cheap per-point/flight CPA tables and filters on a 200 m grid; full curve
   simulation only for the few survivors; 100 m then 50 m refinement around the best *distinct*
   candidates, re-centring the T_start/F0 sweeps each level.
6. **Profile nuisance parameters**: the score is separable per event given T_start, so
   max over F0 per event is done independently (O(n_F0·E) instead of O(n_F0^E)).
7. **Use ADS-B velocities** as Hermite tangents; smooth noisy positions; interpolate gaps carefully
   (or reject hypotheses whose CPA falls in a > 20 s gap).
8. **Use geometric altitude**, or correct baro altitude with QNH; optionally fit a per-flight altitude
   bias as a nuisance (it is strongly correlated with the lateral position, §6).
9. **Report a posterior map, not just the arg-max**: keep top distinct modes (left/right mirror,
   alternative flight pairs) with their score margin. A margin < ~10 % means "ambiguous".
10. **Ground-reflection fringes** as an extra observable (elevation angle) and **atmospheric absorption**
    for the expected harmonic amplitudes.
11. **Time-scale factor** nuisance (audio speed-up/slow-down by up to ±5 %) for re-encoded videos.
12. **Rank hypotheses by ridge residual, not only by pixel sums** (learned on the real colsto clip, see
    LANE_A_REPORT §7): after the time-offset join, compute for each hypothesis the weighted RMS of
    `log f_ridge(t_k) − log(F0·ρ(t_k + s))` over the tracked ridge points (F0 in closed form = weighted mean,
    shift s swept). It uses only where the signal *is* seen, so it is immune to masked approach phases,
    hum lines and bursts. On real audio, ridges often cover only the receding half of a pass (prop noise is
    radiated aft and the approach is masked), which biases straight-line v/d fits (colsto event 2: fit
    77 m/s / 1.4 km vs matched B350 103 m/s / 3.7 km). Hard v/d gates from such fits remove the truth.
