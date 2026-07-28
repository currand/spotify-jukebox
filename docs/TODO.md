# Bugs

## General UI

- [x] Flash of "Party is paused" when navigating My Songs → Queue (GH #6, #18) — only show paused/empty banners after queue loads

## Guest Search

- [x] Search bypasses global Spotify backoff during 429 (GH #12) — fixed: `spotifyFetch` gate + search precheck
- [x] Search 503 during rate limiting (GH #3) — fixed in prior sprint: stale cache + 429 with retryAfterMs

## Admin

## Spotify / cache

- [x] Sync worker 429 backoff (GH #1, #2) — fixed in prior sprint
- [x] Global API budget (GH #5) — 90 calls/30s token bucket in `spotifyFetch`
- [x] Extreme Retry-After / quota death spiral (GH #11) — gate stops re-hammering; honors long Retry-After; `last24h` in diagnostics

## Metrics history

## By design (not bugs)

_(none currently)_

## Enhancements (GH #7–#13)

- [x] Guest first-use tutorial (GH #7) — `tutorial_seen`, dismissable 3-step walkthrough
- [x] Configurable global Spotify API budget (GH #8) — env `SPOTIFY_API_BUDGET_*`, diagnostics snapshot
- [x] Boost lane sorts by upvotes within lane (GH #9) — `getBoostLane` upvote desc, `boost_position` tie-break
- [x] Configurable boost cap (GH #10) — `parties.boost_cap`, `BOOST_CAP` enforcement
- [x] Daily quota observability (GH #11) — `last24h` + diagnostics warning
- [x] Search bypasses backoff gate (GH #12) — fixed: `spotifyFetch` gate + search precheck
- [x] API instrumentation (GH #13) — caller attribution, recent calls, 429 timeline in diagnostics

## Data integrity

- [x] Duplicate add race (two tabs) — transaction + partial unique index on active `(party_id, spotify_uri)`
