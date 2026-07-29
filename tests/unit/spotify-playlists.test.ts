import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createSpotifyClient,
  spotifyApiPathFromNext,
  storeHostTokens,
} from "../../src/server/services/spotify";
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
  hostSetupTokenRequired: false,
  bindHost: "127.0.0.1",
  isProduction: false,
  secureCookies: false,
  spotifyApiBudgetCount: 90,
  spotifyApiBudgetWindowMs: 30_000,
  spotifyDailyWarnCalls: 8000,
  syncFastPoll: false,
  syncEndWindowMs: 7000,
  syncFallbackIntervalMs: 30_000,
  syncIdleIntervalMs: 60_000,
};

function testDb(): Db {
  const db = new Database(":memory:") as Db;
  db.run(
    `CREATE TABLE host_credentials (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
  storeHostTokens(db, testConfig, "access-token", "refresh-token", 3600);
  return db;
}

describe("spotifyApiPathFromNext", () => {
  test("strips configured API base URL", () => {
    expect(
      spotifyApiPathFromNext(
        "https://api.spotify.com/v1/me/playlists?offset=50&limit=50",
        "https://api.spotify.com/v1",
      ),
    ).toBe("/me/playlists?offset=50&limit=50");
  });

  test("parses full Spotify URLs when base URL differs", () => {
    expect(
      spotifyApiPathFromNext(
        "https://api.spotify.com/v1/me/playlists?offset=50&limit=50",
        "http://127.0.0.1:8080/v1",
      ),
    ).toBe("/me/playlists?offset=50&limit=50");
  });
});

describe("getUserPlaylists", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const originalFetch = globalThis.fetch;

  test("returns non-empty playlists with track counts from list API", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/me/playlists")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "seed-1",
                name: "Party Mix",
                collaborative: false,
                description: "  Ready to go  ",
                public: true,
                external_urls: { spotify: "https://open.spotify.com/playlist/seed-1" },
                images: [{ url: "https://i.scdn.co/image/seed-1" }],
                owner: { display_name: "Host" },
                items: { total: 42 },
              },
              {
                id: "empty-1",
                name: "Empty",
                collaborative: false,
                description: null,
                public: false,
                owner: { display_name: "Host" },
                tracks: { total: 0 },
              },
            ],
            next: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const client = createSpotifyClient(testDb(), testConfig);
    const playlists = await client.getUserPlaylists();

    expect(playlists).toEqual([
      {
        id: "seed-1",
        name: "Party Mix",
        trackCount: 42,
        imageUrl: "https://i.scdn.co/image/seed-1",
        description: "Ready to go",
        ownerName: "Host",
        isPublic: true,
        collaborative: false,
        spotifyUrl: "https://open.spotify.com/playlist/seed-1",
      },
    ]);
  });

  test("paginates through /me/playlists", async () => {
    let call = 0;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (!url.includes("/me/playlists")) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      call += 1;
      if (url.includes("offset=0") || !url.includes("offset=")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "page-1",
                name: "First Page",
                collaborative: false,
                description: null,
                public: true,
                owner: { display_name: "Host" },
                items: { total: 1 },
              },
            ],
            next: "https://api.spotify.com/v1/me/playlists?offset=50&limit=50",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "page-2",
              name: "Second Page",
              collaborative: true,
              description: null,
              public: null,
              owner: { display_name: "Friend" },
              items: { total: 5 },
            },
          ],
          next: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const client = createSpotifyClient(testDb(), testConfig);
    const playlists = await client.getUserPlaylists();

    expect(call).toBe(2);
    expect(playlists.map((item) => item.id)).toEqual(["page-1", "page-2"]);
    expect(playlists[1]?.collaborative).toBe(true);
  });
});
