# Bugs

## General UI

- [x] Flash of "Party is paused" when navigating My Songs → Queue (GH #6) — fixed: only show paused banner when party status is known

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

- Boost lane FIFO by `boost_position`; upvotes do not reorder boost lane (GH #9, SPEC + TEST_PLAN §2.5.1)

## Data integrity

- [x] Duplicate add race (two tabs) — transaction + partial unique index on active `(party_id, spotify_uri)`
