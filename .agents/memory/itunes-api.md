---
name: iTunes Charts API
description: Working endpoints and fallback for country charts
---

- Primary: `https://itunes.apple.com/{country}/rss/toppodcasts/limit=100/json`
- Fallback: `https://itunes.apple.com/{country}/rss/topaudiopodcasts/limit=100/json`
- Apple Marketing Tools (`rss.applemarketingtools.com`) is NOT accessible from Replit — confirmed blocked
- Some countries return HTTP 404/403 — these simply don't have an Apple Podcasts presence
- On 404/403: throw a human-readable message "not available for this country" — don't retry
- On other errors (timeout, 5xx): retry up to 2 times with 1s/2s backoff
- Timeout set to 12 seconds per request

**Why:** Many countries in the picker don't have iTunes Podcast charts. Graceful degradation matters.

**How to apply:** `fetchTopCharts(country, limit)` in `discover.ts` handles all of this automatically.
