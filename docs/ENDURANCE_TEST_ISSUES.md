# Jukebox Endurance Test — Issues Found
**Date:** 2026-07-26
**Test environment:** Production (jukebox.currannet.net)
**Party:** test-1-v5vu ("Test 1")
**Duration:** ~20 minutes of actual test runtime across multiple runs

---

## Issue 1: Sync worker does not back off when Spotify returns 429s

**Severity:** High
**Component:** `src/server/services/sync.ts`
**Status:** Fixed (2026-07-26) — global 429 handler, sync early-return, minimum 15s backoff, `getNextSyncDelayMs`

## Issue 2: Search 503 errors during rate limiting

**Severity:** Medium
**Component:** `src/server/routes/guest.ts` (search endpoint)
**Status:** Fixed (2026-07-26) — stale cache on 429; uncached queries return 429 with `retryAfterMs`. Global `spotifyFetch` gate prevents search from calling Spotify during active backoff.

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
| Sync worker | ✅ Backs off on 429s; outbound gate blocks all Spotify calls during backoff |
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

---

## Daily quota / long Retry-After (GH #11)

When Spotify returns **429** with a **Retry-After of many minutes or hours**, the app is likely hitting a **daily or extended quota**, not a short burst limit.

**What to do:**

1. Open **Admin → Diagnostics** and check **24h API call count**. If it exceeds `SPOTIFY_DAILY_WARN_CALLS` (default 8000), expect prolonged backoff.
2. **Stop endurance tests** and wait for Retry-After to expire — do not restart guests or sync-heavy workloads.
3. Review **429 timeline** and **by caller (5m)** to see whether sync, search, or prefetch drove the spike.
4. Tune **`SPOTIFY_API_BUDGET_COUNT`** / **`SPOTIFY_API_BUDGET_WINDOW_MS`** if proactive throttling is too loose for your party size.

The sync worker honors long Retry-After values and blocks all outbound Spotify calls via the global gate until backoff clears.
