import { afterEach, describe, expect, test } from "bun:test";
import {
  artistsToPrefetch,
  cacheSpotifyTracksMetadata,
  clearSpotifySearchCacheForTests,
  getCachedTrackMetadata,
  getArtistTracksCacheEntryForTests,
  getPartyArtistTracks,
  normalizeRateLimits,
  prefetchArtistCatalogsForTests,
  searchPartyCatalog,
  seedArtistTracksCacheForTests,
  seedSearchCacheForTests,
  SpotifySearchRateLimitedError,
} from "../../src/server/services/spotify-search";
import { SpotifyApiError } from "../../src/server/services/spotify-errors";
import {
  applySpotifyRateLimit,
  resetSyncStateForTests,
} from "../../src/server/services/sync";
import { DEFAULT_RATE_LIMITS } from "@/shared/types";

const mockTrack = (id: string, name: string, artist = "Artist", artistId = "artist-1") => ({
  uri: `spotify:track:${id}`,
  id,
  name,
  artists: [{ id: artistId, name: artist }],
  album: { images: [{ url: `https://i.scdn.co/image/${id}` }] },
});

describe("normalizeRateLimits", () => {
  test("fills search defaults for legacy party config", () => {
    const limits = normalizeRateLimits({
      add: DEFAULT_RATE_LIMITS.add,
      upvote: DEFAULT_RATE_LIMITS.upvote,
      downvote: DEFAULT_RATE_LIMITS.downvote,
    } as typeof DEFAULT_RATE_LIMITS);
    expect(limits.search.count).toBe(5);
    expect(limits.partySearch.count).toBe(24);
  });
});

describe("searchPartyCatalog", () => {
  afterEach(() => {
    resetSyncStateForTests();
  });

  test("returns cached results without calling Spotify twice", async () => {
    clearSpotifySearchCacheForTests();
    let calls = 0;
    const spotify = {
      searchCatalog: async () => {
        calls += 1;
        return { tracks: [], artists: [] };
      },
      searchArtistTracks: async () => [],
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
    expect(calls).toBe(1);
  });

  test("rejects short queries without Spotify calls", async () => {
    clearSpotifySearchCacheForTests();
    let calls = 0;
    const spotify = {
      searchCatalog: async () => {
        calls += 1;
        return { tracks: [], artists: [] };
      },
      searchArtistTracks: async () => [],
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
      searchCatalog: async () => ({ tracks: [], artists: [] }),
      searchArtistTracks: async () => [],
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
      searchCatalog: async () => ({
        tracks: [mockTrack("t1", "Dancing Queen")],
        artists: [],
      }),
      searchArtistTracks: async () => [],
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

  test("serves expired cache on Spotify 429", async () => {
    clearSpotifySearchCacheForTests();
    seedSearchCacheForTests("party-1", "abba", {
      tracks: [{
        id: "t1",
        uri: "spotify:track:t1",
        name: "Dancing Queen",
        artistName: "ABBA",
        albumArtUrl: null,
      }],
      artists: [{ id: "abba", name: "ABBA", imageUrl: null }],
    });

    const spotify = {
      searchCatalog: async () => {
        throw new SpotifyApiError("SPOTIFY_429:{}", 429, 5000);
      },
      searchArtistTracks: async () => [],
    };
    const db = { query: () => ({ get: () => null }), run: () => {} } as never;

    const result = await searchPartyCatalog(
      spotify as never,
      db,
      "party-1",
      "abba",
      null,
      DEFAULT_RATE_LIMITS,
    );

    expect(result.tracks[0]?.name).toBe("Dancing Queen");
  });

  test("throws SpotifySearchRateLimitedError when Spotify 429 and no cache", async () => {
    clearSpotifySearchCacheForTests();
    const spotify = {
      searchCatalog: async () => {
        throw new SpotifyApiError("SPOTIFY_429:{}", 429, 8000);
      },
      searchArtistTracks: async () => [],
    };
    const db = { query: () => ({ get: () => null }), run: () => {} } as never;

    await expect(
      searchPartyCatalog(
        spotify as never,
        db,
        "party-1",
        "abba",
        null,
        DEFAULT_RATE_LIMITS,
      ),
    ).rejects.toMatchObject({ retryAfterMs: 8000 });
  });

  test("skips Spotify when globally rate limited and no cache", async () => {
    clearSpotifySearchCacheForTests();
    applySpotifyRateLimit(new SpotifyApiError("SPOTIFY_429:{}", 429, 20_000));
    let calls = 0;
    const spotify = {
      searchCatalog: async () => {
        calls += 1;
        return { tracks: [], artists: [] };
      },
      searchArtistTracks: async () => [],
    };
    const db = { query: () => ({ get: () => null }), run: () => {} } as never;

    await expect(
      searchPartyCatalog(
        spotify as never,
        db,
        "party-1",
        "abba",
        null,
        DEFAULT_RATE_LIMITS,
      ),
    ).rejects.toBeInstanceOf(SpotifySearchRateLimitedError);
    expect(calls).toBe(0);
  });

  test("serves stale cache when globally rate limited", async () => {
    clearSpotifySearchCacheForTests();
    seedSearchCacheForTests(
      "party-1",
      "abba",
      { tracks: [{ id: "t1", uri: "u", name: "Dancing Queen", artistName: "ABBA", albumArtUrl: null }], artists: [] },
      { expired: true },
    );
    applySpotifyRateLimit(new SpotifyApiError("SPOTIFY_429:{}", 429, 20_000));
    let calls = 0;
    const spotify = {
      searchCatalog: async () => {
        calls += 1;
        return { tracks: [], artists: [] };
      },
      searchArtistTracks: async () => [],
    };
    const db = { query: () => ({ get: () => null }), run: () => {} } as never;

    const result = await searchPartyCatalog(
      spotify as never,
      db,
      "party-1",
      "abba",
      null,
      DEFAULT_RATE_LIMITS,
    );
    expect(calls).toBe(0);
    expect(result.tracks[0]?.name).toBe("Dancing Queen");
  });
});

describe("artistsToPrefetch", () => {
  test("only prefetches artists credited on catalog track hits", () => {
    const tracks = [
      mockTrack("1", "Even Flow", "Pearl Jam", "pj"),
      mockTrack("2", "Alive", "Pearl Jam", "pj"),
    ];
    const artists = [
      { id: "pj", name: "Pearl Jam" },
      { id: "beatles", name: "The Beatles" },
      { id: "evan", name: "Evanescence" },
    ];

    expect(artistsToPrefetch(artists, tracks)).toEqual([
      { id: "pj", name: "Pearl Jam", trackHits: 2 },
    ]);
  });

  test("prioritizes artists with more catalog track hits", () => {
    const tracks = [
      mockTrack("1", "A", "ABBA", "abba"),
      mockTrack("2", "B", "ABBA", "abba"),
      mockTrack("3", "C", "ABBA", "abba"),
      mockTrack("4", "D", "Cher", "cher"),
    ];
    const artists = [
      { id: "abba", name: "ABBA" },
      { id: "cher", name: "Cher" },
    ];

    expect(artistsToPrefetch(artists, tracks).map((artist) => artist.id)).toEqual([
      "abba",
      "cher",
    ]);
  });
});

describe("catalog artist seeding", () => {
  test("seeds artist cache from catalog track hits before prefetch", async () => {
    clearSpotifySearchCacheForTests();
    const beatlesTracks = [
      mockTrack("1", "Help!", "The Beatles", "beatles"),
      mockTrack("2", "Yesterday", "The Beatles", "beatles"),
      mockTrack("3", "Come Together", "The Beatles", "beatles"),
    ];
    const spotify = {
      searchCatalog: async () => ({
        tracks: beatlesTracks,
        artists: [{ id: "beatles", name: "The Beatles", imageUrl: null }],
      }),
      searchArtistTracks: async () => {
        throw new Error("prefetch should not block seeded response");
      },
    };
    const db = { query: () => ({ get: () => null }), run: () => {} } as never;

    await searchPartyCatalog(
      spotify as never,
      db,
      "party-1",
      "beatles",
      null,
      DEFAULT_RATE_LIMITS,
    );

    const entry = getArtistTracksCacheEntryForTests("party-1", "beatles");
    expect(entry?.complete).toBe(false);
    expect(entry?.all.map((track) => track.name)).toEqual([
      "Help!",
      "Yesterday",
      "Come Together",
    ]);
  });
});

describe("artist catalog prefetch", () => {
  test("prefetch warms artist tracks cache for later guest requests", async () => {
    clearSpotifySearchCacheForTests();
    let searchCalls = 0;
    const spotify = {
      searchArtistTracks: async () => {
        searchCalls += 1;
        return [mockTrack("song", "Mamma Mia", "ABBA", "artist-1")];
      },
    };

    await prefetchArtistCatalogsForTests(
      spotify as never,
      "party-1",
      [{ id: "artist-1", name: "ABBA" }],
      [mockTrack("warm", "Warm Up", "ABBA", "artist-1")],
    );

    expect(searchCalls).toBe(1);

    const db = { query: () => ({ get: () => null }), run: () => {} } as never;
    const tracks = await getPartyArtistTracks(
      spotify as never,
      db,
      "party-1",
      "artist-1",
      "ABBA",
      "all",
      null,
      DEFAULT_RATE_LIMITS,
    );

    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.name).toBe("Mamma Mia");
    expect(searchCalls).toBe(1);
  });

  test("credited filter prefers tracks by artist id", async () => {
    clearSpotifySearchCacheForTests();
    const spotify = {
      searchArtistTracks: async () => [
        mockTrack("a", "Real Hit", "ABBA", "artist-1"),
        mockTrack("b", "Feat", "Other", "other-artist"),
      ],
    };
    const db = { query: () => ({ get: () => null }), run: () => {} } as never;

    const credited = await getPartyArtistTracks(
      spotify as never,
      db,
      "party-1",
      "artist-1",
      "ABBA",
      "credited",
      null,
      DEFAULT_RATE_LIMITS,
    );

    expect(credited.map((t) => t.id)).toEqual(["a"]);
  });

  test("serves expired artist cache on Spotify 429", async () => {
    clearSpotifySearchCacheForTests();
    seedArtistTracksCacheForTests("party-1", "artist-1", [
      {
        id: "a",
        uri: "spotify:track:a",
        name: "Real Hit",
        artistName: "ABBA",
        albumArtUrl: null,
      },
    ]);

    const spotify = {
      searchArtistTracks: async () => {
        throw new SpotifyApiError("SPOTIFY_429:{}", 429, 5000);
      },
    };
    const db = { query: () => ({ get: () => null }), run: () => {} } as never;

    const tracks = await getPartyArtistTracks(
      spotify as never,
      db,
      "party-1",
      "artist-1",
      "ABBA",
      "all",
      null,
      DEFAULT_RATE_LIMITS,
    );

    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.name).toBe("Real Hit");
  });

  test("throws SpotifySearchRateLimitedError for artist tracks when uncached and rate limited", async () => {
    clearSpotifySearchCacheForTests();
    const spotify = {
      searchArtistTracks: async () => {
        throw new SpotifyApiError("SPOTIFY_429:{}", 429, 6000);
      },
    };
    const db = { query: () => ({ get: () => null }), run: () => {} } as never;

    await expect(
      getPartyArtistTracks(
        spotify as never,
        db,
        "party-1",
        "artist-1",
        "ABBA",
        "all",
        null,
        DEFAULT_RATE_LIMITS,
      ),
    ).rejects.toBeInstanceOf(SpotifySearchRateLimitedError);
  });
});
