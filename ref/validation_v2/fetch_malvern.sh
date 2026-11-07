#!/bin/sh
cd "$(dirname "$0")/../.."
d=fixtures/real/v2_malvern_skydive_20260614
python -P ref/data/fetch_adsb.py --bbox 51.73,-2.83,52.43,-1.83 --start 2026-06-14T11:30Z --end 2026-06-14T14:30Z --out $d/tracks.json --site 52.0813,-2.33072 > $d/fetch.log 2>&1; echo "malvern done $?"
