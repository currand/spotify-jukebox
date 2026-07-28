import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSpotifyClient, setSpotifyRateLimitHandler, setSpotifyRateLimitedGate } from "../../src/server/services/spotify";
import { SpotifyApiError } from "../../src/server/services/spotify-errors";
import type { Db } from "../../src/server/db/schema";
import type { Config } from "../../src/server/config";

const testConfig: Config = {
  env: "development",
  port: 3000,
  baseUrl: "http://127.0.0.1:3000",
  databasePath: ":memory:",
  spotifyMode: "live",
  spotifyApiBaseUrl: "https://api.spotify.com/v1",
  spotifyAccountsBaseUrl: "https://accounts.spotify.com",
  spotifyClientId: "client-id",
  spotifyClientSecret: "client-secret",
  spotifyRedirectUri: "http://127.0.0.1:3000/callback",
  encryptionKey: "01234567890123456789012345678901",
  hostSetupToken: null,
  isProduction: false,
  secureCookies: false,
  spotifyApiBudgetCount: 90,
  spotifyApiBudgetWindowMs: 30_000,
  spotifyDailyWarnCalls: 8000,
  syncFastPoll: false,
  syncEndWindowMs: 7000,
  syncFallbackIntervalMs: 30_000,
  syncIdleIntervalMs: 60_000,
  defaultRateLimits: null,
};

function emptyDb(): Db {
  return new Database(":memory:") as Db;
}

describe("spotify global backoff gate", () => {
  afterEach(() => {
    setSpotifyRateLimitedGate(null);
  });

  test("blocks outbound fetch when gate returns remaining ms", async () => {
    setSpotifyRateLimitedGate(() => 12_000);
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      fetchCalled = true;
      return Promise.resolve(new Response("{}"));
    }) as unknown as typeof fetch;

    const client = createSpotifyClient(emptyDb(), testConfig);

    await expect(client.searchTracks("abba")).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 12_000,
    });
    expect(fetchCalled).toBe(false);

    globalThis.fetch = originalFetch;
  });

  test("gate errors do not propagate through handler registration", async () => {
    let handlerCalls = 0;
    setSpotifyRateLimitHandler(() => {
      handlerCalls += 1;
    });
    setSpotifyRateLimitedGate(() => 5000);

    const client = createSpotifyClient(emptyDb(), testConfig);
    await expect(client.searchTracks("abba")).rejects.toBeInstanceOf(
      SpotifyApiError,
    );
    expect(handlerCalls).toBe(0);

    setSpotifyRateLimitHandler(null);
  });
});
