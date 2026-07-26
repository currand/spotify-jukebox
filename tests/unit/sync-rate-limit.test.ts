import { afterEach, describe, expect, test } from "bun:test";
import { SpotifyApiError } from "../../src/server/services/spotify-errors";
import {
  applySpotifyRateLimit,
  getNextSyncDelayMs,
  getSyncIntervalMs,
  getSyncState,
  resetSyncStateForTests,
} from "../../src/server/services/sync";

describe("sync Spotify rate limit backoff", () => {
  afterEach(() => {
    resetSyncStateForTests();
  });

  test("applySpotifyRateLimit sets rateLimitedUntil from search/prefetch 429s", () => {
    applySpotifyRateLimit(new SpotifyApiError("SPOTIFY_429:{}", 429, 8000));

    const sync = getSyncState();
    expect(sync.rateLimitedUntil).not.toBeNull();
    expect(sync.rateLimitedUntil! - Date.now()).toBeGreaterThan(7000);
    expect(sync.lastError).toContain("retrying in");
  });

  test("getNextSyncDelayMs waits for backoff instead of polling at 10s", () => {
    applySpotifyRateLimit(new SpotifyApiError("SPOTIFY_429:{}", 429, 30_000));

    const delay = getNextSyncDelayMs({} as never, { id: "p", sync_generation: 1 });
    expect(delay).toBeGreaterThan(25_000);
    expect(delay).toBeLessThanOrEqual(30_000);
    expect(getSyncIntervalMs({} as never, { id: "p", sync_generation: 1 })).toBe(
      10_000,
    );
  });

  test("getNextSyncDelayMs uses normal interval when not rate limited", () => {
    const delay = getNextSyncDelayMs({} as never, { id: "p", sync_generation: 1 });
    expect(delay).toBe(10_000);
  });

  test("repeated 429s during active backoff extend window without escalating hits", () => {
    applySpotifyRateLimit(new SpotifyApiError("SPOTIFY_429:{}", 429, 5000));
    const firstUntil = getSyncState().rateLimitedUntil;

    applySpotifyRateLimit(new SpotifyApiError("SPOTIFY_429:{}", 429, 20_000));
    const secondUntil = getSyncState().rateLimitedUntil;

    expect(secondUntil).toBeGreaterThan(firstUntil!);
    expect(secondUntil! - Date.now()).toBeGreaterThan(15_000);
  });

  test("applySpotifyRateLimit ignores non-429 errors", () => {
    applySpotifyRateLimit(new SpotifyApiError("SPOTIFY_503:{}", 503, null));
    expect(getSyncState().rateLimitedUntil).toBeNull();
  });
});
