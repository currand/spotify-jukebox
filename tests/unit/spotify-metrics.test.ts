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
    recordSpotifyApiCall({
      path: "/search?q=abba",
      status: 200,
      elapsedMs: 12,
      caller: "search",
    });
    recordSpotifyApiCall({
      path: "/me/player",
      status: 429,
      elapsedMs: 5,
      caller: "sync",
      retryAfterMs: 60_000,
    });

    const snapshot = getSpotifyApiMetricsSnapshot();
    expect(snapshot.total).toBe(2);
    expect(snapshot.byEndpoint.search).toBe(1);
    expect(snapshot.byEndpoint["player.state"]).toBe(1);
    expect(snapshot.rateLimitCount).toBe(1);
    expect(snapshot.last429At).not.toBeNull();
    expect(snapshot.byCallerLast5m.sync).toBe(1);
    expect(snapshot.recentApiCalls).toHaveLength(2);
    expect(snapshot.rateLimitTimeline).toHaveLength(1);
    expect(snapshot.rateLimitTimeline[0]?.caller).toBe("sync");
    expect(snapshot.firstRateLimit).not.toBeNull();
    expect(snapshot.firstRateLimit?.outboundCallIndex).toBe(2);
    expect(snapshot.firstRateLimit?.caller).toBe("sync");
    expect(snapshot.firstRateLimit?.path).toBe("/me/player");
    expect(snapshot.firstRateLimit?.retryAfterMs).toBe(60_000);
  });

  test("records firstRateLimit only once", () => {
    clearSpotifyMetricsForTests();
    recordSpotifyApiCall({
      path: "/search?q=abba",
      status: 429,
      elapsedMs: 5,
      caller: "search",
      retryAfterMs: 15_000,
    });
    recordSpotifyApiCall({
      path: "/me/player",
      status: 429,
      elapsedMs: 5,
      caller: "sync",
      retryAfterMs: 30_000,
    });

    const snapshot = getSpotifyApiMetricsSnapshot();
    expect(snapshot.rateLimitCount).toBe(2);
    expect(snapshot.firstRateLimit?.outboundCallIndex).toBe(1);
    expect(snapshot.firstRateLimit?.caller).toBe("search");
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
