import { describe, expect, test } from "bun:test";
import {
  cacheSpotifyTracksMetadata,
  clearSpotifySearchCacheForTests,
  getCachedTrackMetadata,
  getPartyArtistTopTracks,
  normalizeRateLimits,
  prefetchArtistCatalogsForTests,
  searchPartyCatalog,
  SpotifySearchRateLimitedError,
} from "../../src/server/services/spotify-search";
import { DEFAULT_RATE_LIMITS } from "@/shared/types";

const mockTrack = (id: string, name: string, artist = "Artist") => ({
  uri: `spotify:track:${id}`,
  id,
  name,
  artists: [{ name: artist }],
  album: { images: [{ url: `https://i.scdn.co/image/${id}` }] },
});

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
      getArtistTopTracks: async () => [],
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
      getArtistTopTracks: async () => [],
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
      getArtistTopTracks: async () => [],
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

  test("caches track metadata including album art from search hits", async () => {
    clearSpotifySearchCacheForTests();
    const spotify = {
      searchTracks: async () => [mockTrack("t1", "Dancing Queen")],
      searchArtists: async () => [],
      getArtistTopTracks: async () => [],
    };
    const db = { query: () => ({ get: () => null }), run: () => {} } as never;

    await searchPartyCatalog(
      spotify as never,
      db,
      "party-1",
      "abba",
      null,
      DEFAULT_RATE_LIMITS,
    );

    const cached = getCachedTrackMetadata("spotify:track:t1");
    expect(cached?.name).toBe("Dancing Queen");
    expect(cached?.albumArtUrl).toBe("https://i.scdn.co/image/t1");
  });

  test("cacheSpotifyTracksMetadata stores playlist import tracks", () => {
    clearSpotifySearchCacheForTests();
    cacheSpotifyTracksMetadata([mockTrack("seed-1", "Seed Song", "Band")]);

    const cached = getCachedTrackMetadata("spotify:track:seed-1");
    expect(cached?.name).toBe("Seed Song");
    expect(cached?.artistName).toBe("Band");
  });
});

describe("artist catalog prefetch", () => {
  test("prefetch warms top-tracks cache for later guest requests", async () => {
    clearSpotifySearchCacheForTests();
    let topTrackCalls = 0;
    const spotify = {
      getArtistTopTracks: async () => {
        topTrackCalls += 1;
        return [mockTrack("hit", "Waterloo", "ABBA")];
      },
      searchTracks: async () => [mockTrack("song", "Mamma Mia", "ABBA")],
    };

    await prefetchArtistCatalogsForTests(spotify as never, "party-1", [
      { id: "artist-1", name: "ABBA" },
    ]);

    expect(topTrackCalls).toBe(1);

    const db = { query: () => ({ get: () => null }), run: () => {} } as never;
    const tracks = await getPartyArtistTopTracks(
      spotify as never,
      db,
      "party-1",
      "artist-1",
      "ABBA",
      null,
      DEFAULT_RATE_LIMITS,
    );

    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.name).toBe("Waterloo");
    expect(topTrackCalls).toBe(1);
  });
});
