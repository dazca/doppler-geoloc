# Real-world test cases (Lane V)

Data live in `fixtures/real/<case>/` (`audio.wav` mono 16 kHz, `meta.json`, `spec.png` = quick 30 Hz+ spectrogram, per-bin median-normalised, 8192-pt FFT). Downloads are untrusted data and not for redistribution (licences in meta.json). Audio was fetched with `python -m yt_dlp -x`. Only `meta.json` values are ground truth; honesty notes below.

Honest summary: finding public audio with BOTH a precise spot and a UTC time is hard. Freesound dates are upload dates, previews are public but originals need login, geotags are coarse. Spotting channels give date + airport but not the exact fence spot and not the time of day. Only the colsto case is a continuous recording designed for this method.

| case | audio | location label | time label | aircraft | best use |
|---|---|---|---|---|---|
| `colsto_longisland` | 25 min crop (orig 1 h) | ~(40.87,-73.5), +-1.5 km (video claims ~100 m but we only have the rounded value) | Sept 8 only; year 2025 vs 2026 unknown; time of day unknown | two strong prop Doppler events 920 s apart (+ fainter ones) | first end-to-end test (two-event search) |
| `ksmo_2024-07-09` | 22 min | Santa Monica airport KSMO, +-1 km | date 2024-07-09 certain, time unknown | ~37 clips of GA props (tail numbers listed), a few jets, an S-76 | spectrogram/Doppler fit and single-flight matching |
| `lfmd_2022-07-17` | first 15 min of 54 | Cannes-Mandelieu LFMD, +-1.5 km | date certain, time unknown | mostly jets, 2 PC-12, 1 H145 | jet/heli/single-flight check |
| `sunderland_heli` | 7 min | Sunderland, +-5 km | upload date only | helicopter circling | negative control |

## colsto_longisland (best)
- Source: colsto's "Unknown location - raw audio" (https://youtu.be/4CxVxuMVkMc), linked from the explainer https://www.youtube.com/watch?v=UytYrhYLOKI. It is the actual test recording (1 h; we keep seconds 1900-3400 as `audio.wav`, `orig.opus` is the whole hour).
- Verified: two clear prop Doppler curves with harmonics, at audio.wav t~215 s and t~1135 s, exactly 920 s apart as in the video (f0 falling ~190 -> ~90 Hz). Fainter curves ~700-850 s and ~1180-1250 s. Strong impulsive noise and fixed hum tones (75/120/245/470 Hz).
- Label confidence: location is the video's answer (Street-View confirmed by colsto), rounded to 0.01 deg here (~1 km). Date: "Sept 8", year not stated, likely 2025 or 2026; UTC time unknown, so a pipeline must search the day (the 920 s offset constrains it; the video had no time either for this two-event run). Flights actually heard are unknown.
- Spec: `spec.png` (crop) and `spec_full_hour.png`.

## ksmo_2024-07-09
- https://youtu.be/SvevouTKkV4 (sk Airplanes, "I was there on July 9, 2024"). The description lists tail number + type with video timestamps, so each clip can be tied to an ADS-B flight (many GA planes at KSMO do broadcast). Clips are 20-60 s edits, so only single-flight scoring makes sense, not the 920 s offset trick.
- Verified: first 200 s show multi-harmonic prop sweeps (e.g. 25-45, 70-125, 125-150, 170-190 s).
- Weakness: spot not stated (airport fence), time of day unknown, extremely busy airspace.

## lfmd_2022-07-17
- https://youtu.be/AFdzfRa7DYY (Jimmyves; date and registrations listed). Download stalled so only 0-918 s were saved. Mostly jets; included as a jet and helicopter (H145 at ~371 s) sample.

## sunderland_heli
- https://freesound.org/people/freekit/sounds/747205/ . Circling helicopter, no clean Doppler pass, coarse geotag, upload date only. A negative control: the pipeline should report low confidence.

## Not found / rejected
- Freesound sounds with exact recording time and fine geotag (e.g. 820325 Whitehorse, CC0) have no coordinates and need login for the WAV.
- Wikimedia Commons search returned no audio of aircraft flyovers.

## Suggested order
1. colsto_longisland (spectrogram -> two-event ranges -> search; compare with colsto's reported spot).
2. ksmo clips with known tail numbers: test Doppler fit and the retarded-time model against the real track (fetch the ADS-B for that N-number/date, hypothesise the observer at KSMO).
3. lfmd PC-12 / H145 clips, then sunderland as a negative control.
