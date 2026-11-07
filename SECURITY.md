# Security policy

## Reporting a vulnerability

Please report security issues **privately** through GitHub's private vulnerability reporting:
open <https://github.com/dazca/doppler-geoloc/security/advisories/new> (repository **Security** tab ->
**Report a vulnerability**). Do not open a public issue, pull request or discussion for a suspected vulnerability.

Include what you can: the affected component (web app, the data Worker at `doppler-data.azemar.eu`, the data
pipeline / GitHub workflows), steps to reproduce or a proof of concept, and the impact you expect.

This is a small personal project maintained on a best-effort basis: expect an acknowledgement within about a week.
Please give a reasonable time to fix before any public disclosure; you will be credited in the advisory unless you
prefer otherwise.

## Scope

In scope: the code in this repository and the deployed Worker / site built from it.
Out of scope: the third-party data sources and services it uses (adsb.lol, GitHub, Cloudflare, map and terrain tile
providers): report those to their owners. Denial-of-service by volume against the Worker is out of scope (it is
rate-limited per client).
