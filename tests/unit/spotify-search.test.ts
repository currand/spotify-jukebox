import { describe, expect, test } from "bun:test";
import {
  clearSpotifySearchCacheForTests,
  normalizeRateLimits,
  searchPartyCatalog,
  SpotifySearchRateLimitedError,
} from "../../src/server/services/spotify-search";
import { DEFAULT_RATE_LIMITS } from "@/shared/types";

describe("normalizeRateLimits", () => {
  test("fills search defaults for legacy party config", () => {
    const limits = normalizeRateLimits({
      add: DEFAULT_RATE_LIMITS.add,
      upvote: DEFAULT_RATE_LIMITS.upvote,
      veto: DEFAULT_RATE_LIMITS.veto,
    } as typeof DEFAULT_RATE_LIMITS);
    expect(limits.search.count).toBe(6);
    expect(limits.partySearch.count).toBe(24);
  });
});

describe("searchPartyCatalog", () => {
  test("returns cached results without calling Spotify twice", async () => {
    clearSpotifySearchCacheForTests();
    let calls = 0;
    const spotify = {
      searchTracks: async () => {
        calls += 1;
        return [];
      },
      searchArtists: async () => {
        calls += 1;
        return [];
      },
    };

    const db = {
      query: () => ({ get: () => null, run: () => {} }),
      run: () => {},
    } as never;

    await searchPartyCatalog(
      spotify as never,
      db,
      "party-1",
      "abba",
      null,
      DEFAULT_RATE_LIMITS,
    );
    await searchPartyCatalog(
      spotify as never,
      db,
      "party-1",
      "abba",
      null,
      DEFAULT_RATE_LIMITS,
    );
    expect(calls).toBe(2);
  });

  test("rejects short queries without Spotify calls", async () => {
    clearSpotifySearchCacheForTests();
    let calls = 0;
    const spotify = {
      searchTracks: async () => {
        calls += 1;
        return [];
      },
      searchArtists: async () => {
        calls += 1;
        return [];
      },
    };
    const db = { query: () => ({ get: () => null }), run: () => {} } as never;
    const result = await searchPartyCatalog(
      spotify as never,
      db,
      "party-1",
      "ab",
      null,
      DEFAULT_RATE_LIMITS,
    );
    expect(result).toEqual({ tracks: [], artists: [] });
    expect(calls).toBe(0);
  });

  test("throws when party search budget is exceeded", async () => {
    clearSpotifySearchCacheForTests();
    const spotify = {
      searchTracks: async () => [],
      searchArtists: async () => [],
    };
    const db = { query: () => ({ get: () => null }), run: () => {} } as never;
    const tight = {
      ...DEFAULT_RATE_LIMITS,
      partySearch: { count: 1, windowMs: 30_000 },
    };

    await searchPartyCatalog(spotify as never, db, "party-2", "rock", null, tight);
    await expect(
      searchPartyCatalog(spotify as never, db, "party-2", "jazz", null, tight),
    ).rejects.toBeInstanceOf(SpotifySearchRateLimitedError);
  });
});
