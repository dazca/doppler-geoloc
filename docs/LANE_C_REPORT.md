# Lane C report: browser DSP

Plain ES modules with no build step and no dependencies. Every `web/engine/*` module runs in both the browser and Node 22.

Tests: `node --test web/tests/dsp.test.mjs web/tests/ridge.test.mjs` (14 tests, all pass).
Benchmark: `node web/tests/bench_stft.mjs`.
Regenerate fixtures: `python fixtures/dsp/gen_dsp_fixtures.py` (needs numpy, scipy and ffmpeg).
Demo: serve the project root (`python -m http.server 8765`) and open `http://127.0.0.1:8765/web/dev/dsp-demo.html`.

## Files
| file | purpose |
|---|---|
| `web/engine/fft.js` | radix-2 FFT (precomputed twiddles and bit reversal, fused first radix-4 pass) and a real FFT built on a half-size complex FFT |
| `web/engine/stft.js` | STFT to a contract spectrogram, with optional band limits and whitening |
| `web/engine/audio.js` | browser decode and resample to mono; WAV parser; sinc resampler; MP4/MOV creation-time parser |
| `web/engine/ridge.js` | Viterbi ridge tracker with harmonic stacking and automatic trimming against a null test |
| `web/workers/dsp.worker.js`, `web/workers/dsp-client.js` | module worker for the STFT and a Promise client (zero-copy result transfer) |
| `web/ui/spectrogram-view.js` | canvas spectrogram viewer component |
| `web/dev/dsp-demo.html` | demo page |
| `web/tests/dsp.test.mjs`, `ridge.test.mjs`, `bench_stft.mjs` | validation and benchmark |
| `fixtures/dsp/*` | generator script, WAV/MP3/M4A/MP4/MOV/WebM files, scipy expected spectrograms, Doppler truth |

## API
```js
// fft.js
createFFT(n) -> { n, complex(re, im) /*in place*/, real(x, outRe, outIm) /*bins 0..n/2*/, power(x, out) /*|X|^2*/ }
isPow2(n), nextPow2(n)

// stft.js
stft(x, {fs, nperseg=2048, nfft=nextPow2(nperseg), hop=nperseg/4, window='hann'|'hann-sym'|'rect'|array,
         detrend='constant'|false, scaling='density'|'spectrum', fMin, fMax, dbFloor=-200,
         whiten='none'|'freq'|'frame'|'both', onProgress})
  -> {t0, dt, f0, df, nT, nF, data: Float32Array[iT*nF+iF], unit: 'dB'|'dB re median', meta:{fs,nperseg,nfft,hop,scaling,whiten}}
  // Frame i is centred at (i*hop + nperseg/2)/fs, the same convention as scipy.signal.spectrogram.
stftParams(opts), makeWindow(kind, n), whitenFreq(spec), whitenFrame(spec), median(arr),
timeOf(spec,iT), freqOf(spec,iF), tIndex(spec,t), fIndex(spec,f)

// audio.js
decodeAudioFile(file, {sampleRate=16000, readMeta=true})          // browser only
  -> {samples: Float32Array mono, sampleRate, duration, channels, meta /* = readMediaMeta result */}
readMediaMeta(File|Blob|ArrayBuffer|Uint8Array|reader(off,len))
  -> {container, mvhdCreationUnix, durationSec, appleCreationDate, appleCreationUnix, dayString,
      best: {unix, source} | null}
parseWav(buf) -> {sampleRate, channels, channelData, samples /*mono mix*/}   // PCM 8/16/24/32, float32/64, EXTENSIBLE
resample(x, fsIn, fsOut, {halfTaps=16}) -> Float32Array            // windowed sinc, anti-aliased
mixToMono(channels), parseDateToUnix(str), makeReader(src)

// ridge.js
trackRidge(spec, {t, f}, {bandFrac=0.25, fLo, fHi, maxSlope=0.1*f /*Hz/s*/, penalty=4 /*dB per bin^2*/,
           snap=3, tMin, tMax /*default seed±120 s*/, harmonics=[1], minSnr /*default auto*/, nullZ=3,
           smoothS=2, maxGapS=2, seedGapS=5, trim=true})
  -> {points: [{t, f, snr, score}], seed: {t, f}, iSeed, threshold, nullStats: {mean, std}, params}

// workers/dsp-client.js
const dsp = createDspClient(); await dsp.stft(samples, opts, onProgress, {transfer:false});
await dsp.ridge(spec, seed, opts); dsp.terminate();

// ui/spectrogram-view.js
new SpectrogramView(container, {colormap})
  .setSpectrogram(spec, {keepView, autoLevels}) .setLevels(lo, hi) .getLevels() .autoLevels(pLo, pHi) .setGamma(g)
  .setColormap('viridis'|'magma'|'gray') .setView({t0,t1,f0,f1}) .getView() .resetView()
  .setMode('pan'|'pick'|'box') .setOverlay(id, {points, color, width, dash, markers, line, label})
  .removeOverlay(id) .clearOverlays() .setCursor(t) .on('pick'|'box'|'hover'|'view', cb)
  .tToX/.fToY/.xToT/.yToF/.valueAt(t,f) .destroy()
```

Viewer controls:
* Mouse wheel zooms time around the cursor. Shift+wheel, or the wheel over the frequency axis, zooms frequency.
* Dragging pans in pan mode. In the other modes, pan with Shift+drag, middle-drag or right-drag.
* Double-click resets the view.
* A crosshair readout shows t, f and dB.
* Rendering takes the maximum of all spectrogram cells that fall in each pixel, so faint lines survive zooming out.

## Ridge tracker algorithm
1. **Snap the seed.** The click is moved to the strongest bin within ±3 bins.
2. **Track forward and backward from the seed.** Each direction is a separate Viterbi pass over the band f_seed·(1±0.25).
   * Emission: the mean over the harmonic multipliers of S(m·f) minus the frame's median over the band. The multipliers come from `harmonics`.
   * Transition: −penalty·Δbin², with |Δbin| ≤ ceil(maxSlope·dt/df).
3. **Refine the frequency.** Each point's frequency comes from parabolic interpolation of the dB peak. With several harmonics, the per-harmonic estimates (each divided by its multiplier) are averaged with power weights.
4. **Trim automatically.** The same tracker is first run on a *null* spectrogram: each block of ⌈nperseg/hop⌉ frames is circularly rolled in frequency by a random amount. This breaks any real ridge but keeps the noise statistics, including streaks caused by overlapping windows. The threshold is the null's mean + 3σ of the 2 s-smoothed path score. The output keeps the confident segment containing the seed, or the nearest one within 5 s of it, with gaps of up to 2 s merged.

Rolling single frames was tried first. It underestimated the null by about 1.5 dB because adjacent frames are correlated (87.5 % window overlap), so nothing was ever trimmed.

## Numerical validation
In the table below, "max |ΔdB|" is the largest difference in dB between our spectrogram and scipy's. All rows passed.

| test | result |
|---|---|
| `fft.real` vs `numpy.fft.rfft`, n = 2…8192 | max abs error 2.0e-13 at n=8192 (|X| up to 270); 1e-14 at n=256 |
| `fft.complex` vs direct DFT, n=64 | 2.5e-13 |
| STFT vs `scipy.signal.spectrogram` (density, constant detrend), nperseg=nfft=1024, hop=256 | max |ΔdB| 7.6e-6, mean 1.3e-6 (622×513) |
| STFT with zero padding, nperseg=1000, nfft=4096, hop=333 | max |ΔdB| 7.6e-6 (478×2049) |
| STFT, `scaling='spectrum'`, no detrend, 2048/2048/512 | max |ΔdB| 7.6e-6 |
| STFT band 300–1500 Hz + per-frequency median whitening vs numpy | exactly equal (0.0) |
| int16 WAV vs float32 WAV parsing | 1.7e-5 (quantisation) |
| `resample` 48k→16k | 11 kHz tone, which would alias to 5 kHz, is rejected by 79 dB |
| MP4 `mvhd` creation_time (ffmpeg `-metadata creation_time=2024-05-06T07:08:09Z`, moov after mdat) | 1714979289, exact; duration 3.0 s |
| MOV `com.apple.quicktime.creationdate=2024-05-06T09:08:10+0200` (keys/ilst, faststart) | 1714979290 = 07:08:10Z, exact; preferred over mvhd |
| WebM / MP3 | `best = null` (no ISO-BMFF metadata), as expected |

The 7.6e-6 dB residual is float32 rounding of the output.

### Ridge tracking on the synthetic pass
Fixture `fixtures/dsp/doppler_110.wav`, 16 kHz, 60 s:
* Source: F0 = 110 Hz plus harmonics 2–8 with amplitudes 1, 0.7, 0.5, …, moving at 60 m/s with closest approach (CPA) 300 m at t = 30 s, c = 343 m/s.
* The Doppler shift uses the exact retarded time, and amplitude falls off as 1/r.
* Noise: white noise at a broadband SNR of **−20 dB** for the fundamental at CPA, plus brown noise and a 50/150 Hz hum.
* Result: the fundamental sits about 8 dB above the median per bin at CPA and is barely visible (see screenshot).

STFT settings: 4096 window, 8192 FFT, hop 512, frequency whitening. Errors are measured against the analytic f(t):

| seed | points (time span) | |err| median | p95 | max |
|---|---|---|---|---|
| h1 alone, click (31 s, +3 Hz) | 408 (24.0–37.1 s) | 0.74 Hz | 4.9 | 10.6 |
| h2 alone, click (25 s, −4 Hz) | 337 (25.0–35.7 s) | 0.76 | 3.9 | 10.1 |
| h2 alone, click (33 s) | 257 (27.6–35.8 s) | 0.77 | 2.0 | 5.8 |
| h3 alone, click (33 s) | 169 (27.9–33.2 s) | 0.99 | 6.0 | 9.3 |
| **h1 with harmonics [1,2,3]** | 383 (25.0–37.2 s) | **0.37** | **1.4** | 3.2 |
| h1 with harmonics [1..6] | 408 (24.1–37.1 s) | 0.38 | 1.8 | 5.3 |
| h2 clicked, harmonics [0.5,1,1.5,2] | 415 (24.0–37.3 s) | 0.57 | 2.0 | 3.6 |
| pure-noise seed (700 Hz, 10 s) | 1 point (rejected) | | | |

Tracking takes 10–40 ms per ridge (60 s file). Harmonic stacking is the recommended mode for prop aircraft. The weak 4th harmonic, about 3 dB above noise, cannot be tracked on its own.

## Benchmarks
The machine was heavily loaded: CPU at 90–100 % from other lanes' Python jobs. In the same session, the 1e8 multiply-add baseline took between 120 and 2356 ms, so treat these numbers as upper bounds.

| | 10 min @ 16 kHz (9.6 M samples) |
|---|---|
| Node: 2048/2048/512, full band (18747×1025) | 1.1 s |
| Node: 4096/4096/512, fMax 2 kHz (18743×513, 38 MB) | 1.7–2.3 s |
| Node: 4096/8192/256, fMax 2 kHz (37485×1025, 154 MB) | 9–10 s; whitening adds ≈1 s (`freq`) to 2.5 s (`both`) |
| Browser worker (Firefox 158): 4096/4096/512, fMax 2 kHz | 2.6 s |
| Browser worker: 4096/8192/512, fMax 2 kHz, `whiten:'freq'` | 6.2 s |
| Viewer render, full 10-min view (1400×525 canvas) | 219 ms; zoomed (40 s) 22 ms |
| Single real FFT (Node, loaded machine) | 21 µs (n=2048), 56 µs (4096), 135 µs (8192) |
| Browser decode (`decodeAudioData` + resample): 60 s 48 kHz stereo AAC MP4 | 0.37 s |

The profile splits about evenly between butterflies (~50 %) and windowing, power and log (~50 %), so there is no single hotspot that WASM would fix. A SIMD WASM FFT might give 2–3×, and the result is already within "a few seconds" for practical settings. **WASM is not warranted.**

The cheaper levers are hop 512 rather than 256 (Doppler curves change slowly) and the `fMax` band limit.

## Browser test evidence
Run in the Playwright MCP browser, which here is Firefox 158; served with `python -m http.server`.
* **Real file upload of `doppler_110.wav` through `<input type=file>`.** The demo decoded it through WebAudio, computed the STFT in the module worker and rendered it. The status line read "60.0 s @ 16000 Hz | decode 345 ms, STFT 707 ms (1868×1025, df 1.95 Hz, dt 32 ms)".
* **Ridge picking with real mouse clicks** in "track ridge" mode. Each ridge was checked against the analytic curve in the page:
  * h1 with [1,2,3]: 387 points, median 0.37 Hz, p95 1.42, max 3.15.
  * h2: 251 points, median 0.76 Hz, p95 1.97.
  * h3: 202 points, median 0.97 Hz, p95 5.85.
* **Formats decoded in the browser**, each with the correct creation time:
  * `doppler_110.m4a` (AAC): mvhd, 2024-05-06T07:08:09Z.
  * `meta_apple.mov`: Apple creationdate, 07:08:10Z.
  * `meta_mvhd.mp4`: mvhd.
  * `meta_none.webm` (Opus): no metadata, as expected.
  * `stft_signal.mp3`.
  * **`doppler_110_48k_stereo.mp4`** (H.264 + AAC, 48 kHz stereo, resampled to 16 kHz by the browser): ridge errors were the same as for the WAV (h1 stacked: median 0.36 Hz, p95 1.42).
* **Viewer interactions**:
  * wheel zoom: time span 40 s → 25.5 s around the cursor;
  * drag pan: shifted the view by 1.9 s;
  * box zoom: produced a t 20–40, f 80–401 Hz view from a box drawn at 80–400 Hz.
* **Console**: 0 errors and 0 warnings.
* **Screenshots**:
  * `docs/img/lane_c_ridge_tracking.png`: three tracked harmonics (pink h1 stacked, yellow h2, cyan h3) over dashed truth lines, with the error readout.
  * `docs/img/lane_c_spectrogram_raw.png`: the raw whitened spectrogram (magma) with no overlays, where the faint Doppler lines are visible.

## Limitations
1. **Memory for large files.** `decodeAudioFile` reads the whole file into memory, because `decodeAudioData` needs the complete buffer. A 1–2 GB phone video can exhaust browser memory. The right fix is to demux MP4 in JavaScript and decode only the audio track with WebCodecs `AudioDecoder`; that is not implemented. The metadata parser does not have this problem: it only reads box headers and the `moov` box through `Blob.slice`.
2. **Codecs.** Browser codec support varies. Firefox decoded AAC, Opus and MP3 here. Playwright's open-source Chromium build may lack AAC/H.264. On failure, the page tells the user to convert the file.
3. **What creation_time means.** It is a hint for T_start, not ground truth.
   * `mvhd.creation_time` is meant to be UTC. Some Android phones and cameras write local time, and some write the time recording *stopped*. Downstream code should try both T_start ≈ creation and creation − duration (`durationSec` is returned).
   * The Apple `creationdate` carries a timezone and is the most reliable source.
   * Editing apps and messengers often rewrite or strip both fields.
4. **Ridge tracker limits.**
   * It is first-order: a jump penalty only, with no curvature or momentum term. Below about 5 dB per-bin SNR on a single line, the path drifts briefly, which is why the p95 errors are 4–6 Hz for single lines. Harmonic stacking reduces this to ~1.5 Hz.
   * The default `maxSlope` of 0.1·f per second covers a prop at 300 m. Fast, close jets may need a larger `maxSlope` or a lower `penalty`.
   * Its accuracy near CPA is limited by the window length: the frequency moves about 1–4 Hz within a 0.256 s window.
5. **Fixed resolution.** There is a single STFT resolution: no multi-resolution or reassignment. Whitening uses a global per-frequency median, so a source that is non-stationary over the whole file (for example a passing car) is not removed.
6. **Node-only resampler.** The JavaScript `resample` is slow (~4 s per minute at 48 k→16 k under load). It is only a fallback; browsers resample inside `decodeAudioData`.
7. **Benchmark caveat.** Benchmarks were taken under heavy contention from other lanes' jobs. Unloaded figures should be lower.

---

# C6: robustness on real audio (colsto / Long Island, `fixtures/real/colsto_longisland/`)

## New options (all opt-in; the existing defaults and validated numbers are unchanged)
16/16 tests pass, including the new `web/tests/robust.test.mjs`. The default-path numbers are identical to before: stacked h1 median 0.37 Hz, p95 1.42 Hz.

**`stft.js`**
* `whitenWindowS`: running per-frequency median (block medians, linearly interpolated), used instead of the global median when `whiten` is `'freq'` or `'both'`. It removes hum lines that come and go.
* `clipDb`: a number or `[lo, hi]`; clips the final dB values.
* New exports: `whitenFreqLocal(spec, windowS)` and `clipSpec(spec, clip)`.

**`ridge.js`** (options for `trackRidge`)
* `nullStat: 'robust'`: computes the null threshold from median and MAD instead of mean and std. Real nulls still contain bursts and lines; on this file `'mean'` gave thresholds of about 10 dB and cut ridges to ±4 s.
* `emClip`: caps the per-bin emission at ±emClip.
* `impulseDb`: frames whose band median rises more than this above typical are treated as missing; the path coasts through them.
* `monotonic: 'down'`: frequency may not increase with time (a straight constant-speed pass). It is applied to the real track only, not to the null run.
* `stack: 'median'`: combines harmonics by median instead of mean.
* `guide` / `guideMult` / `guideTolHz` / `guideOnly`: tracks harmonic m inside m × fundamental ± tol.

**`ridge.js`** (new functions)
* `trackRidgeMulti(spec, seeds, opts)`: several clicks on one intermittent line, merged per frame.
* `cleanRidge(points, {winS, maxDevHz})`: drops points that deviate from a running median.

**Demo:** new "win s" (running-median window) and "clip" inputs.

## Stationary-tone and burst suppression on the real file
Line contrast is in dB over the neighbouring background (4096 window, 8192 FFT, hop 512):

| line | global median (`whiten:'freq'`) | running median 60 s | running median 120 s |
|---|---|---|---|
| 470 Hz hum, on from ≈1160 s (measured 1250–1500 s) | +9.5 | −0.4 | 0.0 |
| 75 Hz hum (1250–1500 s) | +13.0 | −0.3 | 0.0 |
| 245 Hz hum (0–90 s) | +5.9 | +0.1 | +0.4 |
| 120 Hz hum (0–90 s) | +7.0 | −0.1 | +0.6 |
| 180 Hz line lasting ~40 s (1060–1100 s) | +15.6 | +3.1 | +13.1 |
| **event 1 ridge, 240 s** | +16.5 | +17.5 | +17.2 |
| **event 2 ridge, 1160 s** | +22.2 | +20.8 | +21.9 |

The running median removes come-and-go hum completely and keeps the Doppler ridges. There is a trade-off: a window shorter than about 2–3× a constant-frequency segment also erases that segment, and the far approach and recede plateaus of a slow, distant aircraft are exactly such segments. Use about 120 s; the C6 tracks use 120 s.

Bursts are handled in the tracker:
* `impulseDb: 6`, `emClip: 15` and `monotonic: 'down'` together stopped event 2's fundamental from jumping onto the narrow-band burst clusters at ≈1175 s and ≈1197 s. Without `monotonic`, the path made a 25 Hz excursion at 1195 s.
* `stack: 'median'` instead pulled event 2 onto the 180 Hz line between 1050 and 1100 s, so it is not used.

Synthetic check (`robust.test.mjs`): a 600 Hz tone that switches on at 40 s is left at +16.8 dB by global whitening and reduced to +1.4 dB by a 20 s running median. With bursts added, tracking with the real-audio options gives h1 median 0.38 Hz, p95 1.04 Hz, and the guided h2 gives median 0.76 Hz, p95 2.57 Hz.

## Ridges (`fixtures/real/colsto_longisland/ridges.json`)
Reproduce with `node web/tests/track_colsto.mjs` (followed by `python fixtures/dsp/colsto_ridge_analysis.py` for the numbers below).
* STFT: 4096 window, 8192 FFT, hop 512, freq whitening with a 120 s window.
* h1: three seed clicks per event; harmonics [1,2,3] stacked; monotonic.
* h2 and h3: guided by the h1 track (×m ± 3m Hz), then cleaned.
* Format: `[{event, harmonic, method, points: [[t, f], ...], snr_db, meta}]`, in audio.wav time. Add 1900 s for orig.opus time.
* Tracking takes 1.1–1.7 s per event.

| event | h | points | time span | duration | f high → low | ratio r | v ≥ c(r−1)/(r+1) |
|---|---|---|---|---|---|---|---|
| 1 | 1 | 2182 | 201.2–276.0 s | 74.8 s | 172.0 → 97.0 Hz | 1.773 | 95.6 m/s |
| 1 | 2 | 1692 | 202.0–258.7 s | 56.7 s | 342.8 → 217.8 Hz | 1.574 | 76.5 m/s |
| 1 | 3 | 1263 | 205.0–258.2 s | 53.2 s | 509.2 → 331.1 Hz | 1.538 | 72.7 m/s |
| 2 | 1 | 1186 | 1143.8–1181.8 s | 37.9 s | 172.5 → 122.7 Hz | 1.406 | 57.9 m/s |
| 2 | 2 | 714 | 1144.6–1175.0 s | 30.4 s | 346.6 → 252.9 Hz | 1.370 | 53.6 m/s |
| 2 | 3 | 963 | 1147.1–1178.8 s | 31.7 s | 512.9 → 379.9 Hz | 1.350 | 51.1 m/s |

Ratios taken from the ridge extremes are **lower bounds on v**, because the tracked ridges do not reach the far-field asymptotes.

I also fitted the exact straight-line Doppler model (retarded time, c = 343 m/s, robust least squares, all harmonics jointly as f/m; `fixtures/dsp/colsto_ridge_analysis.py`):

| event | F0 | v | CPA distance d | t_cpa (emission time) | rms residual | asymptotic (c+v)/(c−v) |
|---|---|---|---|---|---|---|
| 1 | 113.06 Hz | 139.0 m/s | 6220 m | 237.32 s | 0.70 Hz | 2.36 |
| 2 | 139.34 Hz | 76.2 m/s | 1369 m | 1164.65 s | 1.09 Hz | 1.57 |

The formal uncertainties are small (v ±0.4–0.5 m/s, d ±22–49 m, t_cpa ±0.06 s), but these fits extrapolate well beyond the tracked span, especially event 1 (large d). Treat v and d as indicative.

**Time between the two CPAs:**
* Steepest-slope point of the fitted model curves, in received time: **237.32 s and 1164.65 s, Δ = 927.3 s**. Numerically, the steepest received-time slope falls exactly at t_rx = t_cpa(emission).
* Model-free, from the steepest slope of a 10 s Savitzky–Golay-smoothed fundamental: 234.85 s and 1169.14 s, Δ = 934.3 s.
* Received-time CPA, t_cpa + d/c: 255.45 s and 1168.64 s, Δ = 913.2 s.

So the separation is about 913–934 s depending on the definition, consistent with the ≈920 s noted in meta.json. Lane A should decide which definition the scoring uses.

Other observations:
* Event 2's flat 180 Hz line (1050–1100 s) switches on and off together with a 105→120 Hz line. It looks like machinery, not the aircraft's approach, and is not included in the tracks.
* Event 2's h3 track flattens near 1175–1179 s, where it crosses the burst cluster at ≈385 Hz; the last ~4 s of that track are doubtful.

Screenshots from the demo in the browser (running median 120 s, clip 25 dB, ridges from ridges.json: pink h1, yellow h2, cyan h3):
* `docs/img/lane_c_colsto_event1.png`
* `docs/img/lane_c_colsto_event2.png`

## Decoding the full 1 h `orig.opus` in the browser (Firefox 158)
The file is 44.8 MB, Opus, 48 kHz stereo, 3600.2 s long. I loaded it through `<input type=file>`.

| | result |
|---|---|
| Decode to 16 kHz mono (`decodeAudioData`) | **62.6 s** |
| STFT in the worker (4096/4096, hop 1024, fMax 1000; 56250×513) | 16.5 s |
| Firefox memory, sampled every 0.5 s | total working set 1.2 GB → **3.68 GB peak**; content process peak **2.55 GB** |

Decoding succeeded, so I did not implement a chunked fallback.

Memory is dominated by `decodeAudioData`: the decoded stereo AudioBuffer (2 × 230 MB at 16 kHz) plus the browser's internal 48 kHz decode buffers, plus our mono mix (230 MB). About 1 h is therefore the practical limit on 4–8 GB machines. Beyond that, the fix is WebCodecs `AudioDecoder` with chunked demuxing (Ogg and MP4 demuxers would be needed). That is not "simple", so it is deferred.

For a 1 h file at hop 512 and fMax 2 kHz, the spectrogram alone is about 460 MB. Use hop 1024 and/or fMax 1000 for whole-hour overviews, then recompute at full resolution for the region of interest.

All of the above timings were taken on a heavily loaded machine (other lanes at 90–100 % CPU).
