# Jukebox Endurance Test — Issues Found
**Date:** 2026-07-26
**Test environment:** Production (jukebox.REDACTED.example.com)
**Party:** test-1-v5vu ("Test 1")
**Duration:** ~20 minutes of actual test runtime across multiple runs

---

## Issue 1: Sync worker does not back off when Spotify returns 429s

**Severity:** High
**Component:** `src/server/services/sync.ts`

**Evidence:**
```
Rate limit count: 95
sync.retryAfterMs: null (NOT engaged)
Sync polling: 29 player.state + 44 player.queue calls in 5 min
```

**Expected behavior:** When any part of the system (sync worker, search API, prefetch) receives a Spotify 429, the sync worker should detect the rate limit and reduce polling frequency.

**Actual behavior:** The sync worker continues polling at its normal 10-second interval regardless of rate limits. The `rateLimitCount` climbs to 100+ while `retryAfterMs` remains `null`.

**Root cause:** The `applySpotifyRateLimit()` function is called from the search path (`searchPartyCatalog`) when a 429 is received. This sets `rateLimitedUntil` on the sync state. However, the sync worker's `runSyncTick()` checks `isRateLimited()` at the start of each tick. If the 429 occurs between ticks (during a search call), the next tick fires before the backoff state is set, or the state is cleared too quickly by `clearRateLimitIfExpired()`.

**Impact:** With 30 guests searching and the sync worker polling every 10s, total API calls reach ~35/min. Spotify's rate limit for search is much lower, leading to sustained 429s that never resolve because the sync worker keeps adding to the call volume.

---

## Issue 2: Search 503 errors during rate limiting

**Severity:** Medium
**Component:** `src/server/routes/guest.ts` (search endpoint)

**Evidence:**
```
13:02:32 [Leo] search "don't stop me now" → 503 ERR: Search unavailable
13:02:32 [Hank] search "wonderwall" → 503 ERR: Search unavailable
13:02:34 [Clara] search "party 215 version" → 503 ERR: Search unavailable
```

**Expected behavior:** When Spotify is rate-limiting search requests, the app should either serve cached results or return a graceful error with retry guidance.

**Actual behavior:** The app returns 503 "Search unavailable" to guests. This happens because `searchPartyCatalog` catches the `SpotifyApiError` from the 429 and the route handler returns 503.

**Impact:** Guests see "Search unavailable" and cannot find tracks. The search cache should absorb repeat queries, but during heavy load with varied queries, the cache hit rate drops to ~16-40%, leaving many guests unable to search.

---

## Issue 3: Guest session not preserved across endurance test runs

**Severity:** Low (test infrastructure)
**Component:** `scripts/endurance-test.ts`

**Evidence:**
```
88 guests in the party (many duplicates: Alice ×7, Bob ×6, etc.)
```

**Expected behavior:** The endurance test should reuse existing guest sessions or create sessions only once per guest.

**Actual behavior:** Each test run creates new guest sessions. Over multiple runs, the party accumulates hundreds of duplicate guest entries. The test script joins fresh guests every time instead of tracking and reusing sessions from previous runs.

**Fix (for next run):** Use a two-step approach:
1. `join-guests.ts` — joins guests once, saves session tokens to `data/guests-{slug}.json`
2. `endurance-test.ts` — reads tokens from file, skips join step

---

## Issue 4: Endurance test action pacing too aggressive (v1)

**Severity:** Low (test infrastructure)
**Component:** `scripts/endurance-test.ts`

**Evidence:** 30 guests performing actions every 5-30 seconds generated ~35 API calls/min, which overwhelmed Spotify's rate limits within minutes.

**Expected behavior:** Simulate realistic party behavior — guests arrive gradually, have natural pauses, and action frequency matches real-world usage.

**Actual behavior:** All 30 guests joined within seconds and started searching/adding immediately. The combined search + sync worker API calls exceeded Spotify's rate limit within ~3 minutes.

**Fix (v3):** Implemented phased behavior with staggered arrivals (1 guest every 2 minutes over 60 minutes) and activity rates that vary by phase (35% during arrival, 15% during peak, 8% during wind-down).

---

## Issue 5: Duplicate detection shows 409 but guest keeps trying

**Severity:** Low
**Component:** `scripts/endurance-test.ts`

**Evidence:**
```
13:04:55 [Hank] add_dup "Mr. Brightside" already in queue → 409
13:05:03 [Olive] add_dup "Wonderwall" already in queue → 409
```

**Expected behavior:** Once a guest sees a 409 duplicate error, they should not try to add the same track again.

**Actual behavior:** The test script doesn't track which tracks are already in the queue across guests. Multiple guests try to add the same popular songs, hitting duplicate detection repeatedly.

**Impact:** Wasted API calls and misleading error logs. Not a bug in the app, but reduces test effectiveness.

---

## Summary of app behavior observed

| Behavior | Status |
|----------|--------|
| Guest join flow | ✅ Works correctly |
| Display name setting | ✅ Works correctly |
| Search (when not rate-limited) | ✅ Returns real Spotify results |
| Add track (search-then-add) | ✅ Real tracks added successfully |
| Duplicate detection | ✅ Returns 409 with correct message |
| Upvote | ✅ Works correctly |
| Veto | ✅ Works correctly (threshold enforcement) |
| Boost | ✅ Works correctly (one per guest) |
| Queue ordering | ✅ Boost lane leads, upvotes sort normal queue |
| Rate limiting (per-guest) | ✅ Enforced correctly |
| Sync worker | ⚠️ Works but does not back off on 429s |
| Search caching | ✅ Works (40% hit rate with varied queries) |
| ETag/conditional GET | ✅ 304 returned when queue unchanged |

---

## Recommendations for next test run

1. **Wait for rate limits to fully clear** (at least 5 minutes after last 429)
2. **Use v3 script** with phased behavior and staggered arrivals
3. **Use join-guests.ts** to create sessions once, then pass token file to endurance test
4. **Reduce initial search load** — start with 10 guests, scale to 30 over 30 minutes
5. **Skip fewer tracks** — admin skip every 60s instead of 30s to reduce API calls
6. **Monitor rate limit count** — if it exceeds 20, pause the test and wait for cooldown
