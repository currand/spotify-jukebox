import { describe, expect, test } from "bun:test";
import {
  classifySpotifyEndpoint,
  clearSpotifyMetricsForTests,
  getSearchMetricsSnapshot,
  getSpotifyApiMetricsSnapshot,
  recordSearchActivity,
  recordSpotifyApiCall,
} from "../../src/server/services/spotify-metrics";

describe("classifySpotifyEndpoint", () => {
  test("maps common paths", () => {
    expect(classifySpotifyEndpoint("/search?q=test&type=track")).toBe("search");
    expect(classifySpotifyEndpoint("/me/player/queue")).toBe("player.queue");
    expect(classifySpotifyEndpoint("/me/player")).toBe("player.state");
    expect(classifySpotifyEndpoint("/artists/abc/top-tracks?market=US")).toBe(
      "artists.top-tracks",
    );
  });
});

describe("spotify metrics", () => {
  test("counts api calls and 429s", () => {
    clearSpotifyMetricsForTests();
    recordSpotifyApiCall({ path: "/search?q=abba", status: 200, elapsedMs: 12 });
    recordSpotifyApiCall({ path: "/me/player", status: 429, elapsedMs: 5 });

    const snapshot = getSpotifyApiMetricsSnapshot();
    expect(snapshot.total).toBe(2);
    expect(snapshot.byEndpoint.search).toBe(1);
    expect(snapshot.byEndpoint["player.state"]).toBe(1);
    expect(snapshot.rateLimitCount).toBe(1);
    expect(snapshot.last429At).not.toBeNull();
  });

  test("tracks search cache hits and recent activity", () => {
    clearSpotifyMetricsForTests();
    recordSearchActivity({
      partyId: "party-1",
      query: "abba",
      source: "guest",
      cacheHit: true,
      kind: "catalog",
    });
    recordSearchActivity({
      partyId: "party-1",
      query: "queen",
      source: "prefetch",
      cacheHit: false,
      kind: "artist-tracks",
    });

    const snapshot = getSearchMetricsSnapshot();
    expect(snapshot.total).toBe(2);
    expect(snapshot.cacheHits).toBe(1);
    expect(snapshot.cacheMisses).toBe(1);
    expect(snapshot.prefetchCount).toBe(1);
    expect(snapshot.recent[0]?.query).toBe("queen");
  });
});
