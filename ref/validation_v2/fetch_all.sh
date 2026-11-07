#!/bin/sh
# Lane V2: fetch ADS-B for each case (window = stream span +-1 h; bbox ~ +-0.35 deg lat, +-0.5 deg lon around the site).
cd "$(dirname "$0")/../.."
f() { d=fixtures/real/$1; python -P ref/data/fetch_adsb.py --bbox $2 --start $3 --end $4 --out $d/tracks.json --site $5 --keep-ground > $d/fetch.log 2>&1; echo "$1 done $?"; }
f v2_ksmo_live_20230826 33.67,-118.95,34.37,-117.95 2023-08-26T18:00Z 2023-08-27T00:00Z 34.0185,-118.4480
f v2_teuge_20260802 51.90,5.55,52.60,6.55 2026-08-02T07:00Z 2026-08-02T14:30Z 52.2447,6.0467
f v2_egelsbach_20251011 49.61,8.14,50.31,9.14 2025-10-11T12:30Z 2025-10-11T17:30Z 49.9629,8.6421
f v2_teuge_20260406 51.90,5.55,52.60,6.55 2026-04-06T07:30Z 2026-04-06T16:00Z 52.2447,6.0467
f v2_egelsbach_20230912 49.61,8.14,50.31,9.14 2023-09-12T14:30Z 2023-09-12T19:00Z 49.9629,8.6421
