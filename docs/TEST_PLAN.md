# Jukebox — UAT/QAT Test Plan

**Scope:** Queuing mechanism, search, voting/vetoing, rate-limit resilience, edge cases  
**Out of scope:** Admin portal UI polish, Spotify OAuth flow, Docker/cloudflared config  
**Target:** Ensure large parties don't flood APIs and that queue/vote/veto outcomes are deterministic

---

## Real-World Usage Profile

| Factor | Value | Impact on testing |
|--------|-------|-------------------|
| Party duration | 2–3 hours (4 max) | Rate-limit event table growth is a non-issue (~1200 rows max) |
| Total guests | ≤50 | Upper bound for join/session tests |
| Active guests | ~15–20 | Most realistic load profile; 50-guest chaos tests are extreme upper bound |
| Device mix | iPhone + Android, many older devices | Mobile UX, small screens, fat-finger taps, connection drops |
| Tech skill | Many not adept at technology | Error messages must be clear; accidental double-taps must not break things |
| Spectators | Partners who may never interact | Read-only queue viewing must work without session; polling must not drain battery |

---

## 1. Rate-Limit & API Flooding Tests

### 1.1 Guest-level per-action rate limits

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 1.1.1 | Guest adds 4 tracks within a 20-min window (default limit is 3) | 4th add returns `429 RATE_LIMITED` with `retryAfterMs` | `checkRateLimit` returns `allowed: false`; error shape matches spec |
| 1.1.2 | Guest adds 3 tracks, waits 20 min, adds 1 more | 4th add succeeds | Sliding window resets; `countRecentActions` returns 0 |
| 1.1.3 | Guest upvotes 11 songs within 60 min (limit is 10) | 11th upvote returns 429 | Upvote rate-limit enforced independently |
| 1.1.4 | Guest vetoes 4 songs within 30 min (limit is 3) | 4th veto returns 429 | Veto rate-limit enforced independently |
| 1.1.5 | Guest does 7 searches within 60s (search limit is 6) | 7th search returns `SpotifySearchRateLimitedError` | Search rate-limit enforced; returns `RATE_LIMITED` with `retryAfterMs` |
| 1.1.6 | Rate-limited guest sees `retryAfterMs` and waits | After waiting, next action succeeds | UI can display countdown; backend enforces the window |

### 1.2 Party-wide search rate limit

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 1.2.1 | 8 guests each search once in a 30s window (party limit is 24/30s) | All 8 succeed (8 < 24) | `partySearchBuckets` counter ≤ 24 |
| 1.2.2 | ~15 active guests search different things in 30s | All succeed (15 < 24) | Realistic load — party budget is generous for actual usage |
| 1.2.3 | Party bucket is full but guest has personal quota remaining | Search rejected (party limit wins) | `assertSearchAllowed` checks party limit first |
| 1.2.4 | Party bucket resets after 30s window | All guests can search again | Window expiry clears counter |

### 1.3 Spotify API rate-limit backoff

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 1.3.1 | Spotify returns 429 with `Retry-After: 30` | `markRateLimited` sets `rateLimitedUntil` 30s in future | `computeRateLimitBackoffMs` takes max of Retry-After and exponential |
| 1.3.2 | Sync worker hits consecutive 429s | Exponential backoff: 1s → 2s → 4s → 8s → 16s → 32s → 60s cap | `consecutiveRateLimitHits` increments each time |
| 1.3.3 | Sync worker is rate-limited — guest adds a track | Guest add succeeds (only Spotify API ops are blocked) | Guest route doesn't call Spotify; `requestPartySync` bumps generation |
| 1.3.4 | Rate-limit clears, sync worker resumes | `consecutiveRateLimitHits` resets to 0; `rateLimitedUntil` cleared | `clearRateLimitIfExpired` fires on next tick |
| 1.3.5 | Party search causes Spotify 429 | Sync worker shares the same `markRateLimited` state | `applySpotifyRateLimit` called from both paths |

### 1.4 Search cache as rate-limit shield

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 1.4.1 | Multiple guests search "Queen" within 30 min | Only 1 Spotify API call; rest are cache hits | `SEARCH_CACHE_TTL_MS` = 30 min; `searchCache` returns cached `SearchResult` |
| 1.4.2 | Guest searches the same query twice in a row | Second search is instant (cache hit), no rate-limit consumption | `logCatalogSearch` reports `cacheHit: true`; `recordSearch` not called |
| 1.4.3 | Cache exceeds `SEARCH_CACHE_MAX_PER_PARTY` (60) | Oldest entries evicted (LRU) | `evictLruByPrefix` removes entries sorted by `lastAccessedAt` |
| 1.4.4 | Two guests search the same novel query simultaneously | Only 1 API call fires; second awaits the in-flight promise | `searchInFlight` dedup handles concurrent requests |
| 1.4.5 | Guest searches after cache TTL expires | Fresh Spotify API call; cache updates | `cached.expiresAt > Date.now()` check fails |

### 1.5 IP-level rate limiting

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 1.5.1 | Rapid join requests from same IP | Join endpoint blocked by `checkIpRateLimit` | Per-IP in-memory bucket |
| 1.5.2 | Different IPs join simultaneously | Both succeed (separate bucket keys) | Scoped by `ip:${scope}` key |

### 1.6 Realistic party load (15–20 active guests)

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 1.6.1 | 20 guests join over 2 minutes | All get sessions; no crashes | `guests` table populated correctly |
| 1.6.2 | 15 guests each add 2 tracks + search 3 times | Rate limits not hit within normal usage; search cache absorbs repeat queries | 15×2 = 30 adds (each guest well under 3/20min); 15×3 = 45 searches with heavy cache reuse |
| 1.6.3 | 15 guests upvote the same track | Final count is exactly 15; no duplicates | `SET upvote_count = upvote_count + 1` is atomic |
| 1.6.4 | 15 guests search different things in 30s | All succeed (15 < 24 party budget) | Realistic scenario — no 429s |
| 1.6.5 | 50 guests join but only 15 interact | 35 spectators see queue read-only; 15 active guests work normally | Spectators don't consume rate limits or search budget |

### 1.7 ETag / conditional GET (bandwidth saving)

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 1.7.1 | Guest polls queue; gets `ETag` header | Next poll with `If-None-Match` returns `304 Not Modified` when queue unchanged | `computeQueueEtag` returns same hash for same state |
| 1.7.2 | Track is upvoted between polls | `ETag` changes; 304 no longer returned | `upvote_count` change alters the etag |
| 1.7.3 | Queue state identical but `party.updated_at` differs | `ETag` changes | Admin config change bumps the etag |

### 1.8 Probe-guard middleware (scanner/host abuse)

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 1.8.1 | Request to `/wp-admin` or `.env` path | Returns 404 (scanner trap); rate-limited at 30/min per IP | `isScannerPath` matches; `checkIpRateLimit` enforced |
| 1.8.2 | Request to `/api/v1/host/spotify/status` (public status) | Never rate-limited by probe guard | `isHostProbePath` returns false for this path |

---

## 2. Queuing Mechanism (Determinism & Correctness)

### 2.1 Queue ordering

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 2.1.1 | 3 tracks in queue: 0, 2, 5 upvotes | Sorted by upvotes desc: 5 → 2 → 0 | `compareNormalQueue` returns correct order |
| 2.1.2 | 2 tracks tied at 3 upvotes, added at T1 and T2 | Earlier-added track ranks higher | Tiebreaker: `added_at ASC` |
| 2.1.3 | Track has `manual_order` set (admin reordered) | Manual order takes precedence over upvotes | `manual_order != null` branch |
| 2.1.4 | Boost lane has 3 items with varying upvotes and positions | Sorted by `upvote_count` DESC, then `boost_position` ASC | Higher upvotes play first within boost lane |
| 2.1.5 | Boost lane item AND normal items exist, no `queued` buffer | Boost lane leads: B0, B1, then normal sorted by upvotes | `getPlayOrder` returns `[...boost, ...normal]` |
| 2.1.6 | Item has `status: "queued"` (Spotify buffer) | Queued item pins first in upcoming order | `queued` item always first, then boost, then normal |
| 2.1.7 | Idle seed (0 upvotes, not boosted) vs same-upvote guest add | Guest add above idle seed | `isIdleSeed` check |
| 2.1.8 | Seed with 3 upvotes vs guest add with 0 upvotes | Seed above guest add (more upvotes) | Upvote count dominates |

### 2.2 Boost lane mechanics

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 2.2.1 | Guest boosts a pending track | `is_boosted=1`, `boost_position=N+1`, guest's `boost_used=1` | `nextBoostPosition` increments; `guests.boost_used` set |
| 2.2.2 | Guest boosts a track, then tries to boost another | Second boost returns `BOOST_USED` | One boost per guest per party |
| 2.2.3 | Guest boosts their own song | Allowed (spec says may boost any track) | No "own song" guard on boost |
| 2.2.4 | Guest tries to boost a track that's already boosted | Returns `ALREADY_BOOSTED` | `isGuestBoostBlocked` checks `is_boosted === 1` |
| 2.2.5 | Guest tries to boost the Spotify buffer track | Returns `NEXT_LOCKED` | `isGuestBufferSlotLocked` |
| 2.2.6 | Guest unboosts their track before it plays | `is_boosted=0`, `boost_position=NULL`, guest's `boost_used` restored | Boost slot returned to guest |
| 2.2.7 | Guest unboosts a track that's already playing | Returns `NOW_PLAYING` | Cannot unboost "playing" status |

### 2.3 Queue lifecycle: pending → queued → playing → terminal

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 2.3.1 | Sync worker picks next pending track for Spotify buffer | Status changes to `queued` via `addToQueue` | `fillSpotifyBufferIfEmpty` calls `spotify.addToQueue()` |
| 2.3.2 | Spotify starts playing a queued track | Status changes to `playing` | `reconcilePlayingState` detects URI match |
| 2.3.3 | Track finishes playing | Status changes to `played` + `finished_at` set | `markFinished` called during next sync |
| 2.3.4 | Admin or host skips the current track | Status changes to `skipped` + `finished_at` | `markFinished(db, item.id, "skipped")` |
| 2.3.5 | Track reaches `veto_threshold` via vetoes | Status changes to `vetoed` immediately | `markFinished` called synchronously on veto route |
| 2.3.6 | Guest removes their own pending track | Status changes to `skipped`; `boost_used` refunded if boosted | `DELETE /parties/:slug/me/songs/:itemId` |
| 2.3.7 | Guest adds track via two browser tabs simultaneously | Second add returns 409 DUPLICATE (transaction + partial unique index) | `insertQueueItem` + `idx_queue_party_active_uri` |
| 2.3.8 | Queue is cleared while a track is `queued` in Spotify | Cleared items marked `skipped`; next sync skips them if Spotify tries to play them | `shouldSkipTerminalPlayback` handles `vetoed`/`skipped` |
| 2.3.9 | Admin shuffles queue while sync worker is mid-buffer-fill | Shuffle marks items `pending`; sync tick re-evaluates on next cycle | `resetQueuedToPending` undoes in-flight buffer state |
| 2.3.10 | Track transitions `playing` → `played`; guest views "My Songs" | Track moves from active to history; `queuePosition` becomes null | `countGuestActiveSongs` no longer counts it |

### 2.4 from_spotify adopted tracks

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 2.4.1 | Spotify has a track in its queue not in our virtual queue | Sync adopts it as `pending` with `from_spotify=1` | `reconcileSpotifyQueueTail` calls `adoptSpotifyTrack` |
| 2.4.2 | Guest tries to upvote a `from_spotify` track | Returns `NEXT_LOCKED` | `isGuestSpotifyBufferLocked` checks `from_spotify === 1` |
| 2.4.3 | Guest tries to boost a `from_spotify` track | Returns `NEXT_LOCKED` | `isGuestBoostBlocked` blocks it |
| 2.4.4 | Guest tries to veto a `from_spotify` track | Returns `NEXT_LOCKED` | `isGuestVetoBlocked` → `isGuestSpotifyBufferLocked` |
| 2.4.5 | Admin shuffles queue; `from_spotify` tracks excluded from reorderable list | Only non-queued, non-Spotify-tail tracks are reorderable | `getAdminReorderableNormal` filters them out |

### 2.5 Boost lane + voting interaction

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 2.5.1 | Boosted track gets upvoted | Upvote increments count; boost lane re-sorts by upvotes (GH #9) | `getBoostLane` sorts by `upvote_count` then `boost_position` |
| 2.5.2 | Normal track with 10 upvotes; boosted track with 0 upvotes | Boost lane still leads over normal queue | `getPlayOrder` puts boost before normal |
| 2.5.3 | Seeded track (`from_seed=1`) is boosted | Allowed — seed tracks can be boosted | No `from_seed` guard in boost endpoint |
| 2.5.4 | Admin moves a boosted track up | `manual_order` set, but boost lane ignores it | `getBoostLane` sorts by upvotes then `boost_position` only |

### 2.6 Sync worker race conditions

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 2.6.1 | Two adjacent sync ticks overlap (slow Spotify response) | Second tick serializes behind first via `withPartySyncLock` | `partySyncInFlight` chained promises |
| 2.6.2 | Admin force-sync while background sync is running | Admin sync runs after background completes | `forcePartySync` also uses `withPartySyncLock` |
| 2.6.3 | Multiple queue mutations before sync tick fires | Single sync picks up all changes | `requestPartySync` bumps `sync_generation` |
| 2.6.4 | Track added and then removed before sync sends it to Spotify | Never sent (status never `queued`) | `getVirtualNextToBuffer` skips non-`pending` items |

### 2.7 Spotify queue normalization

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 2.7.1 | Spotify reports padded queue (repeating prefix [A,B,A,B,A,B]) | Detected as pattern length 2; deduped to [A,B] | `inferPaddedSpotifyQueueLength` finds shortest prefix |
| 2.7.2 | Spotify queue has 20 copies of the same URI | Homogeneous padding detected; queue treated as empty if not managed | `normalizeSpotifyQueueSnapshot` drops it |
| 2.7.3 | Spotify queue has a terminal-status URI | Removed from normalized view | `isTerminalQueueUri` filter |
| 2.7.4 | Currently playing track is terminal in our DB | `currentlyPlaying` set to null | `normalizeSpotifyQueueSnapshot` handles stale state |

---

## 3. Search

### 3.1 Search functionality

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 3.1.1 | Guest searches for "Bohemian Rhapsody" | Returns matching tracks + related artists | `spotify.searchCatalog` called; results mapped correctly |
| 3.1.2 | Guest searches with query < 3 chars | Returns empty `{ tracks: [], artists: [] }` | `MIN_SEARCH_QUERY_LENGTH` guard — no API call |
| 3.1.3 | Guest searches empty query | Returns empty result | Early return before rate-limit check |
| 3.1.4 | Guest searches for an artist; clicks artist tab | Artist tracks fetched via `artist:{name}` search | `getPartyArtistTracks` calls `spotify.searchArtistTracks` |
| 3.1.5 | Artist drill-down with `?filter=credited` | Only tracks where artist is a credited performer | `pickArtistSearchTracks` filter applied |
| 3.1.6 | Artist drill-down with `?filter=all` | All tracks from the artist search | Full unfiltered list |
| 3.1.7 | Guest searches with special characters (accents, emojis) | Search handles gracefully; no crash | Unicode-safe `encodeURIComponent` in query building |

### 3.2 Search caching

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 3.2.1 | Guests A and B search identical query | Guest B gets cache hit (no Spotify API call) | `searchCache` hit; `recordSearch` not called for B |
| 3.2.2 | Guest searches the same query 30+ minutes later | Cache expired; fresh API call | `cached.expiresAt > Date.now()` fails |
| 3.2.3 | Artist drill-down tracks cached for 1 hour | Subsequent artist clicks are instant | `ARTIST_TRACKS_CACHE_TTL_MS` = 60 min |
| 3.2.4 | Cache hit for incomplete artist catalog | Background refresh scheduled (best-effort) | `scheduleArtistCatalogRefresh` fires non-blocking |
| 3.2.5 | Search catalog responses seed artist track cache | No extra API call for artists in catalog results | `seedArtistTracksFromCatalog` called |

### 3.3 Search + Rate limit interaction

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 3.3.1 | Guest rate-limited on search, but party has budget | `SpotifySearchRateLimitedError` thrown (guest limit wins) | `assertSearchAllowed` checks both limits |
| 3.3.2 | Host searches while no guest session | Only party-level search budget applied | `guestId` is `null` → `checkRateLimit` skipped |

### 3.4 Artist prefetch

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 3.4.1 | Catalog search returns 3 artists → prefetch triggered | Top artist gets 3 pages deep (30 tracks); others get 1 page | `artistsToPrefetch` sorts by `trackHits` |
| 3.4.2 | Prefetch runs while guest rate limit is exhausted | Prefetch succeeds (no guest rate limit check) | `prefetchArtistCatalogs` runs outside `assertSearchAllowed` |
| 3.4.3 | Prefetch hits Spotify 429 | Silently caught; no crash | `try/catch` in prefetch Promise |

---

## 4. Voting & Vetoing (Determinism)

### 4.1 Upvote mechanics

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 4.1.1 | Guest upvotes a pending track | `upvote_count` increments by 1; `votes` row inserted | Atomic DB update; `recordAction("upvote")` called |
| 4.1.2 | Guest upvotes the same track again | Returns `ALREADY_VOTED` | UNIQUE constraint on `(guest_id, queue_item_id)` |
| 4.1.3 | Guest upvotes their own song | Returns `OWN_SONG` | `item.added_by_guest_id === guest.id` check |
| 4.1.4 | Guest upvotes a track in Spotify buffer (queued or up-next) | Returns `NEXT_LOCKED` | `isGuestUpvoteBlocked` → `isGuestBufferSlotLocked` |
| 4.1.5 | Guest upvotes a track that's already playing | Blocked (status check rejects) | `!["pending", "queued"].includes(item.status)` |
| 4.1.6 | Anonymous guest (no display name) tries to upvote | Returns `DISPLAY_NAME_REQUIRED` | Display name required for all mutations |
| 4.1.7 | Banned guest tries to upvote | Returns `BANNED` | `requireGuest` checks `disabled` flag |

### 4.2 Veto mechanics

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 4.2.1 | Guest vetoes a pending track | `veto_count` increments; `vetoes` row inserted | Separate `vetoes` table |
| 4.2.2 | Veto count reaches `veto_threshold` (default 3) | Track immediately set to `vetoed`; sync triggered | `if (newCount >= party.veto_threshold)` branch |
| 4.2.3 | Track set to `vetoed` while already pending | Never sent to Spotify | `getVirtualNextToBuffer` skips non-`pending` |
| 4.2.4 | Track set to `vetoed` after already `queued` to Spotify | Sync skips it when it reaches the front | `shouldSkipTerminalPlayback` → `skipCurrentTrack` |
| 4.2.5 | 3 distinct guests each veto the same track | Threshold reached on 3rd veto; track becomes `vetoed` | Track removed from upcoming immediately |
| 4.2.6 | Guest vetoes a track that's currently playing | Returns `NOW_PLAYING` | Cannot veto what's playing |
| 4.2.7 | Guest vetoes the Spotify buffer track (queued) | Returns `NEXT_LOCKED` | `isGuestVetoBlocked` → `isGuestSpotifyBufferLocked` |
| 4.2.8 | Guest double-vetoes the same track | Returns `ALREADY_VETOED` | UNIQUE constraint |
| 4.2.9 | Host veto threshold is set to 1 | First veto immediately removes the track | Configurable threshold honored |

### 4.3 Deterministic race conditions (concurrent voting)

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 4.3.1 | 3 guests veto the same track at nearly the same time | SQLite serializes writes; threshold triggers exactly once | `SET veto_count = veto_count + 1` is atomic |
| 4.3.2 | N guests upvote the same track concurrently | Final count = N (no lost updates) | Denormalized counter via atomic increment |
| 4.3.3 | Guest removes their own song while another guest is vetoing it | One action wins; no crash | SQLite serialization |

### 4.4 Veto threshold edge cases

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 4.4.1 | Veto threshold = 3; 15 guests available | Only 3 vetos needed (absolute, not proportional) | Threshold is absolute |
| 4.4.2 | Party with only 2 named guests; threshold = 3 | Veto never triggers | Threshold cannot be met |
| 4.4.3 | Track reaches threshold via veto but is already playing | Cannot veto playing; already-past condition prevents | Route blocks veto of `playing` |

---

## 5. Deduplication

### 5.1 Title-based dedup

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 5.1.1 | Guest adds a track with identical title to an active item | Returns `DUPLICATE` (409) | Exact normalized title match |
| 5.1.2 | "Bohemian Rhapsody" vs "Bohemian Rhapsody (2011 Remaster)" | Levenshtein ratio ≥ 0.85 → DUPLICATE | Fuzzy match catches variations |
| 5.1.3 | Track played 21 songs ago | Not blocked (dedup only looks at recent 20) | `getDedupTracks` limits terminal history to 20 |
| 5.1.4 | Guest re-adds a track they previously removed (skipped) | Allowed (skipped not in dedup list) | `skipped` excluded from dedup |
| 5.1.5 | "Song" vs "Song (feat. Artist)" with same artist | Likely ≥ 0.85 → DUPLICATE | Artist name also compared |
| 5.1.6 | Same track title, different artist | Allowed (artist name differs) | `isDuplicateTrack` compares both |
| 5.1.7 | Guest types track name with typos (e.g. "Bohemian Rapsody") | May or may not match depending on Levenshtein distance — verify threshold behavior | Boundary case for 0.85 threshold |

---

## 6. Resilience & Edge Cases

### 6.1 Party on/off boundary

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 6.1.1 | Party is toggled `off` mid-party | Mutations return `PARTY_OFF` (403); sync worker stops | All guest routes check `isPartyOn` |
| 6.1.2 | Party toggled back `on` | Guest actions resume; existing queue intact | No data loss from off period |
| 6.1.3 | Guest loads the page while party is off | Can view but not mutate | `POST` routes blocked; `GET` routes work |
| 6.1.4 | Party ends (archived) while a track is playing | Playing track marked `played`; remaining marked `skipped` | `POST /parties/:id/end` bulk-updates |
| 6.1.5 | New party created while previous party is active | Previous archived; new party in `off` state; old party guests get `NOT_FOUND` | `getPartyBySlug` excludes archived |
| 6.1.6 | Guest from archived party tries to join new party | Session cookie scoped to old slug; new join creates fresh session | Slug-scoped cookies |
| 6.1.7 | Host creates new party with import from previous party | Previous party's tracks imported in play order | `getPartyExportTracks` returns terminal items |

### 6.2 Guest session persistence and expiry

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 6.2.1 | Guest session cookie expires (24h) | Next request treated as new guest | `guestSessionMiddleware` finds no matching token |
| 6.2.2 | Host session cookie expires (7d) | Host routes return 401 `UNAUTHORIZED` | `hostAuthMiddleware` checks `expires_at` |
| 6.2.3 | Guest closes browser and returns next day | New session; loses previous queue attribution | Cookie `maxAge` = 24h |
| 6.2.4 | Guest session exists but party was deleted | Middleware joins guest to party; party query returns null → 404 | `getPartyBySlug` returns null |

### 6.3 Host add bypasses guest restrictions

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 6.3.1 | Host adds a track | No rate limit applied; `added_by_guest_id` is NULL; attribution is "Host" | `isHost=true`; `checkRateLimit` skipped |
| 6.3.2 | Host adds a duplicate of an existing track | Returns `DUPLICATE` (409) — dedup still enforced | `isDuplicateTrack` runs regardless of `isHost` |
| 6.3.3 | Host adds 100 tracks rapidly | All succeed; sync processes one at a time | `requestPartySync` bumped; sync fills buffer gradually |
| 6.3.4 | Host adds a track with `name` and `artistName` provided | Uses provided metadata; no Spotify API call | `body.name && body.artistName` branch |
| 6.3.5 | Host adds a track without metadata; Spotify search fails | Falls back to "Unknown" name/artist; track still added | `try/catch` sets fallback values |

### 6.4 Guest session reclaim (name conflict)

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 6.4.1 | Guest A is "DJ Max"; Guest B tries "DJ Max" | `NAME_TAKEN` returned | `findSimilarNamedGuest` fuzzy match triggers |
| 6.4.2 | Guest B confirms reclaim from same IP as A | Succeeds; B gets A's session token; old guest deleted | `reclaimGuestSession` |
| 6.4.3 | Guest B confirms reclaim from different IP | `NAME_RECLAIM_DENIED` (403) | IP mismatch prevents session hijacking |
| 6.4.4 | Guest A is "DJ Max"; Guest B tries "DJ Mox" | Fuzzy match (Levenshtein ≥ 0.85) → `NAME_TAKEN` | Close variants caught |

### 6.5 Party export and history

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 6.5.1 | Party ends; host views history | `played`, `skipped`, `vetoed` tracks in reverse `finished_at` order | `GET /host/parties/:id/history` |
| 6.5.2 | Export includes tracks from seed playlist | Seed tracks that were played appear in export | `getPartyExportTracks` includes all terminal statuses |
| 6.5.3 | Export deduplicates by URI | Same URI re-added after skip → only first occurrence | `seen` Set dedup in `getPartyExportTracks` |
| 6.5.4 | Last ended party import | Previous party's export tracks imported as seed | `addTrackToParty` with `fromSeed=true` |

### 6.6 Guest session lifecycle

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 6.6.1 | Guest joins without a display name | Session created; `display_name` is null; mutations blocked | `requireGuest` checks `!guest.displayName` |
| 6.6.2 | Guest sets display name to a 50-character string | Truncated to 48 characters | `.slice(0, MAX_DISPLAY_NAME_LENGTH)` |
| 6.6.3 | Guest sets display name matching another guest (fuzzy) | Returns `NAME_TAKEN` (409) | `isDuplicateDisplayName` (Levenshtein ≥ 0.85) |
| 6.6.4 | Guest reclaims name from same IP | Succeeds (returns merged session) | `reclaimGuestSession` |
| 6.6.5 | Guest reclaims name from different IP | Returns `NAME_RECLAIM_DENIED` (403) | IP mismatch prevents hijacking |
| 6.6.6 | Host bans a guest | Guest actions return `BANNED`; queue items stay | `requireGuest` checks `disabled` |

### 6.7 Data integrity and persistence

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 6.7.1 | Server restarts with an active party | Queue, history, votes, vetoes all intact | SQLite persistence on Docker volume |
| 6.7.2 | Server restarts while a track is playing | Track continues playing; next sync re-adopts it | `reconcilePlayingState` adopts Spotify's current |
| 6.7.3 | Docker volume is empty (first run) | Fresh state; no errors | Graceful empty-state handling |
| 6.7.4 | `DELETE FROM votes WHERE guest_id = ?` concurrent with a vote insert | SQLite serialization prevents data loss | No phantom votes |

### 6.8 Empty/null/error states

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 6.8.1 | Empty queue (all terminal, nothing pending) | `nowPlaying: null`, `upcoming: []`, `nextItem: null` | No active items |
| 6.8.2 | Queue has 1 item that's now playing | Upcoming is empty; `nextItem` is null | `getNextUpcomingItem` returns null |
| 6.8.3 | Spotify returns empty device/no active device | `deviceActive: false`; guest actions still work; host sees warning | `getPlayerSnapshot` returns empty snapshot |
| 6.8.4 | Spotify refresh token is revoked | Sync marks `spotifyReachable: false`; host must re-auth | `SPOTIFY_REAUTH_REQUIRED` thrown |
| 6.8.5 | Spotify returns 403 "Restricted device" | `markDeviceRestricted`; host sees device warning | `isRestrictedDeviceError` |
| 6.8.6 | Track metadata lookup fails (Spotify search error) | Falls back to "Unknown" name/artist | `try/catch` in `handleAdd` |

### 6.9 Guest "My Songs" view

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 6.9.1 | Guest has 3 songs in queue, 2 played | Active list shows 3; history shows 2 | `getGuestMySongs` splits by status |
| 6.9.2 | Guest's song is up next | `queuePosition: "Up next"` | `formatGuestQueuePosition` checks `idx === 0` |
| 6.9.3 | Guest used boost on track A, then removed track A | `boost_used` refunded | `DELETE` route sets `boost_used = 0` |

---

## 7. Admin Queue Management (Host Overrides)

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 7.1 | Host shuffles the normal lane | All normal pending items get `manual_order` set to random indices; boost lane untouched | `shuffle` route; `resetQueuedToPending` called |
| 7.2 | Host force-nexts a track | Item gets `is_boosted=1` with next `boost_position`; Spotify buffer rebuilt | `force_next` action |
| 7.3 | Host moves a track up/down | `manual_order` swapped between adjacent items | `move_up` / `move_down` swap |
| 7.4 | Host moves track up when it's already first | No-op (returns `{ ok: true }`) | `swapIdx < 0` returns early |
| 7.5 | Host resets votes on a track | `upvote_count` set to 0; all vote rows deleted | `reset_votes` action |
| 7.6 | Host clears the entire upcoming queue | All pending/queued items set to `skipped`; now-playing untouched | `clear` route bulk-updates |
| 7.7 | Host "start from here" on item at position 3 | Items at positions 0,1,2 are skipped; item at 3 becomes next | `start-from` route |
| 7.8 | Host tries to start-from an item not in upcoming | Returns `NOT_FOUND` | `idx < 0` check |

---

## 8. Spotify Sync Worker Correctness

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 8.1 | Virtual queue has 3 items; Spotify buffer is empty | First virtual item sent to Spotify; status set to `queued` | `fillSpotifyBufferIfEmpty` sends 1 track per tick |
| 8.2 | Spotify currently playing track not in our DB (external) | Adopted as `playing` with "Unknown" metadata | `adoptSpotifyTrack` in `reconcilePlayingState` |
| 8.3 | Our `playing` track is now different from Spotify's current | Previous marked `played`; new adopted as `playing` | URI mismatch detection |
| 8.4 | Spotify buffer has a track not from our queue | Adopted as `queued` (externally added) | `reconcileSpotifyBufferStatuses` |
| 8.5 | Vetoed track is currently queued in Spotify | Sync skips it when it reaches the front | `shouldSkipTerminalPlayback` → `skipCurrentTrack` |
| 8.6 | No active queue items and nothing playing | Sync tick returns early (idle) | `!snapshot.deviceActive && !snapshot.currentUri` guard |
| 8.7 | Sync tick runs while party is off | Returns immediately (no active party) | `getActiveParty(db)` returns null |
| 8.8 | Queue has 30 pending tracks; sync fills buffer one at a time | Only 1 track pushed per tick; buffer fills gradually | One-at-a-time pacing |
| 8.9 | Spotify returns 204 on `/me/player` (no active device) | `deviceActive: false`; fallback to `/me/player/currently-playing` | Fallback path in `getPlayerSnapshot` |
| 8.10 | Both `/me/player` and `/me/player/currently-playing` return empty | `deviceActive: false`; sync returns early | Empty snapshot → early return |
| 8.11 | Spotify returns opaque (non-JSON) response | Treated as `deviceRestricted: true` | `readJsonBody` returns null → restricted snapshot |
| 8.12 | Sync worker rate-limit expires | `clearRateLimitIfExpired` resets state; sync resumes | Called at start of each tick |
| 8.13 | `partyNeedsSpotifyQueueSync` is false | Sync skips buffer operations; only reconciles playing state | `aggressiveBuffer` is false |
| 8.14 | Admin force-sync while already rate-limited | Throws `PartySyncError` with `RATE_LIMITED` (429) | `isRateLimited()` check |
| 8.15 | Spotify `getQueue()` returns vetoed track | `normalizeSpotifyQueueSnapshot` drops it | `isTerminalQueueUri` filters |

### 8.16 Metrics and diagnostics

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 8.16.1 | App starts; metrics session created | `startup` snapshot recorded; `currentSessionId` set | `startMetricsRecorder` inserts row |
| 8.16.2 | 10-second interval tick fires | `interval` snapshot recorded | `insertSnapshot` called; pruning caps at 4320 |
| 8.16.3 | Spotify 429 hits; rate-limit snapshot cooldown | `rate_limit` snapshot recorded (max once per 10s) | Cooldown enforced |
| 8.16.4 | Minute-bucket aggregation | 6 × 10s snapshots collapsed into 1 summary per minute | `summarizeMetricsSnapshotsByMinute` |
| 8.16.5 | App restarts; old session closed | Previous session gets `ended_at` | `closeOpenSessions` updates null rows |

---

## 9. Mobile-Specific & UX Resilience Tests

**Why these matter:** Many guests will be older, less tech-savvy, on a mix of iPhone and Android. The app must tolerate fat-finger taps, accidental double-submissions, connection drops, and app switching.

### 9.1 Accidental double-tap / double-submit

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 9.1.1 | Guest double-taps "Add" on a track | First add succeeds; second returns `DUPLICATE` (409) or `ALREADY_VOTED` | Dedup catches the race; no crash or duplicate queue entry |
| 9.1.2 | Guest double-taps "Upvote" | First succeeds; second returns `ALREADY_VOTED` | UNIQUE constraint on votes |
| 9.1.3 | Guest double-taps "Veto" | First succeeds; second returns `ALREADY_VETOED` | UNIQUE constraint on vetoes |
| 9.1.4 | Guest double-taps "Boost" | First succeeds; second returns `BOOST_USED` | `boost_used` flag set synchronously |
| 9.1.5 | Guest double-taps "Remove" on their own song | First removes it; second returns `NOT_OWNER` or `INVALID_ITEM` | Item already in terminal status |

### 9.2 Connection drops and recovery

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 9.2.1 | Guest loses WiFi briefly, then reconnects | Queue reloads on next poll; no data loss | SQLite is server-side; client just re-fetches |
| 9.2.2 | Guest submits add while offline | Request fails; app shows error; no partial state | HTTP error returned; no phantom queue entry |
| 9.2.3 | Guest's phone goes to sleep, wakes 10 min later | Queue refreshes on wake; shows current state | Polling resumes; ETag prevents redundant data transfer |
| 9.2.4 | Guest switches from WiFi to cellular mid-party | Seamless — server sees different IP; session cookie still valid | Session is cookie-based, not IP-locked |
| 9.2.5 | Guest switches from cellular to WiFi | Same as above — seamless transition | No IP-based session binding |

### 9.3 App switching and backgrounding

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 9.3.1 | Guest switches to another app, returns 5 min later | Queue refreshes; shows current state | Polling resumes on tab focus |
| 9.3.2 | Guest has 20 browser tabs open; switches to jukebox tab | No performance degradation | ETag + 304 prevents unnecessary data transfer |
| 9.3.3 | Guest opens jukebox in a second browser window | Both windows show same queue (shared session cookie) | Same session token in cookie |

### 9.4 Display name entry (older users)

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 9.4.1 | Guest enters a name with leading/trailing spaces | Name is trimmed before storage | `.trim()` applied |
| 9.4.2 | Guest enters a very long name (100+ chars) | Truncated to 48 characters | `MAX_DISPLAY_NAME_LENGTH` enforced |
| 9.4.3 | Guest enters an empty name after spaces are trimmed | Returns `DISPLAY_NAME_REQUIRED` | Empty-string check after trim |
| 9.4.4 | Guest enters name with only spaces | Trimmed to empty → `DISPLAY_NAME_REQUIRED` | Whitespace-only names rejected |
| 9.4.5 | Guest enters "bob" when "Bob" already exists | Fuzzy match (case-insensitive + Levenshtein) → `NAME_TAKEN` | `isDuplicateDisplayName` catches case variants |

### 9.5 Spectator experience (no interaction)

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 9.5.1 | Guest joins but never sets display name | Can view queue; cannot add/vote/veto/boost | `requireGuest` blocks mutations without name |
| 9.5.2 | Guest views queue as spectator (no name set) | Queue loads; shows track names, upvote counts, attribution | `GET /parties/:slug/queue` works without display name |
| 9.5.3 | Guest never interacts; party ends | Session cookie expires naturally; no cleanup needed | No orphaned data concern |

### 9.6 Network latency and slow devices

| # | Scenario | Expected | What to verify |
|---|----------|----------|----------------|
| 9.6.1 | Guest on slow 3G connection searches | Search results load (may take 2-3s); no timeout crash | Spotify API + search cache handles latency |
| 9.6.2 | Guest on slow connection adds a track | Add request completes; response shows success | No timeout; SQLite insert is fast |
| 9.6.3 | Multiple guests on slow connections polling simultaneously | Server handles concurrent polling without degradation | ETag + 304 reduces response size; SQLite is fast for reads |

---

## 10. Test Execution Strategy

### Automated test coverage to add

Priority list of missing unit tests:

1. **Rate-limit integration**: Test `checkRateLimit` + `recordAction` + sliding window across action types. Verify `remainingQuota` reflects actual usage.

2. **Party search bucket**: Test `checkPartySearchLimit` with concurrent calls. Verify 24/30s cap enforced across all guests.

3. **Spotify rate-limit backoff**: Test `computeRateLimitBackoffMs` with varying `consecutiveHits`. Test `markRateLimited` and `clearRateLimitIfExpired`.

4. **Search cache eviction**: Test LRU eviction at `SEARCH_CACHE_MAX_PER_PARTY`. Test `artistTracksCache` independent eviction.

5. **Sync worker locking**: Test `withPartySyncLock` serializes concurrent syncs. Test `partyNeedsSpotifyQueueSync` generation comparison.

6. **Veto threshold edge**: Test threshold checked *after* increment (atomic). Test threshold met during single request.

7. **Concurrent vote/veto**: Test SQLite UNIQUE constraint handling for duplicate inserts.

8. **Veto on already-played/skipped**: Test `markFinished` does not downgrade `skipped`/`vetoed` to `played`.

9. **Queue normalization**: Test `inferPaddedSpotifyQueueLength` with various repeat patterns. Test `isHomogeneousPadding`.

### QA test sequence (manual or automated)

```
Phase 1: Unit & Integration (CI) — run `bun test`
  - All existing tests pass
  - Add new tests from priority list above

Phase 2: Single-party happy path
  - Create party from seed playlist
  - 3 guests join, search, add tracks, upvote, veto, boost
  - Verify queue order matches spec
  - End party

Phase 3: Realistic load (15–20 active guests)
  - Create party
  - 15 guests join over 2 minutes
  - Each searches, adds 2 tracks, upvotes 3 songs
  - Verify no 429s within rate-limit budgets
  - Verify search cache absorbs repeat queries

Phase 4: Mobile + UX resilience
  - Test on iPhone Safari and Android Chrome
  - Double-tap "Add" twice quickly — verify no duplicate
  - Put phone to sleep, wake 10 min later — verify queue refreshes
  - Switch WiFi → cellular → WiFi — verify no session loss
  - Enter display name with spaces, typos, long strings
  - Verify spectator (no name) can view queue

Phase 5: Veto race
  - 3 guests veto the same track simultaneously
  - Verify track is vetoed exactly once

Phase 6: Resilience
  - Kill and restart the container while party is active
  - Verify queue intact, playing track continues
  - Force a 429 from Spotify (use rate-limit test script)
  - Verify exponential backoff and auto-recovery

Phase 7: Cross-device compatibility
  - Verify on iPhone 12+ (Safari)
  - Verify on Android 10+ (Chrome)
  - Verify on older Android (Chrome WebView)
  - Check touch targets are tappable on small screens
  - Verify ETag polling works across browsers
```

---

## 11. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Duplicate add race (two tabs) | Low | Low | Application-level dedup catches most cases; SQLite prevents DB corruption |
| Guest can't figure out how to add a song | Medium | Medium | Clear UI flow; join → set name → search → add |
| Spotify API 429 during party | Low | High | Search cache absorbs most queries; sync worker backs off; guests can still view queue |
| Guest accidentally vetoes wrong song | Medium | Low | Veto threshold (3) prevents single-veto removal; host can reset votes |
| Connection drops on older phones | Medium | Low | ETag polling is lightweight; queue refreshes on reconnect |
| Guest confused by "NEXT_LOCKED" error | Medium | Low | Error message explains "This song is up next" — clear enough for non-technical users |
| Spotify token expires mid-party | Low | High | Sync worker pauses; host sees re-auth prompt; guest actions unaffected |
| Rate-limit events table grows unbounded | Very Low | Very Low | 50 guests × 6 actions × 4 hours = ~1200 rows max; SQLite handles trivially |

---

## 12. Findings from Automated Testing

### 12.1 Buffer slot lock prevents double-voting (by design)

**Discovered during integration testing.** The `isGuestUpvoteBlocked` check fires before the `ALREADY_VOTED` check. When a guest upvotes a track, that track's `upvote_count` increments, potentially making it the highest-voted pending track — which makes it the buffer slot (first in `getUpcomingPlayOrder`). Once it's the buffer slot, `isGuestBufferSlotLocked` returns `true`, and subsequent upvotes on that track return `NEXT_LOCKED` instead of `ALREADY_VOTED`.

**Impact:** This is actually correct behavior — the buffer slot lock prevents any interaction (upvote, boost, veto) on the next-to-play track. The `ALREADY_VOTED` UNIQUE constraint on `(guest_id, queue_item_id)` still prevents database-level duplicates. The `NEXT_LOCKED` error is a higher-priority guard that fires first.

**Test adjustment:** Tests that expect `ALREADY_VOTED` on a track that was just upvoted must account for the buffer slot lock. Either:
- Accept both `ALREADY_VOTED` and `NEXT_LOCKED` as valid
- Pre-populate rate limit events to test rate limiting without the buffer slot interfering

### 12.2 Filler tracks needed for integration tests

Any test that upvotes/vetoes/boosts a track must ensure that track is NOT the first pending item in the queue (the buffer slot). Insert a "filler" track first to occupy the buffer slot, then test against subsequent tracks.

### 12.3 Sync worker interference in tests

The `startSyncWorker` call in `src/server/index.ts` starts immediately. In tests with a mocked Spotify client, the sync worker runs but makes no-op API calls. It does not interfere with test state because `getAccessToken()` returns null when no `host_credentials` exist. Tests should either:
- Mock the Spotify client to return null from `getAccessToken()` (current approach)
- Or avoid importing `startSyncWorker` in test setups
