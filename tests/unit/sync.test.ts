import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  buildEffectiveQueueSnapshot,
  getManagedSpotifyQueueUris,
  getSyncIntervalMs,
  getVirtualNextToBuffer,
  isUriBufferedInSpotify,
  partyHasPendingBufferWork,
  partyNeedsSpotifyQueueSync,
  reconcileSpotifyBufferStatuses,
  shouldSkipTerminalPlayback,
} from "../../src/server/services/sync";
import { getUpcomingPlayOrder, type QueueItemRow } from "../../src/server/services/queue";
import type { Db } from "../../src/server/db/schema";

import type { SpotifyTrack } from "@/shared/types";

function spotifyTrack(uri: string, name = "Track"): SpotifyTrack {
  return {
    uri,
    id: uri.split(":").pop() ?? uri,
    name,
    artists: [{ name: "Artist" }],
    album: { images: [] },
  };
}

const base = (overrides: Partial<QueueItemRow>): QueueItemRow => ({
  id: "1",
  party_id: "p",
  spotify_uri: "spotify:track:one",
  track_name: "t",
  artist_name: "a",
  album_art_url: null,
  upvote_count: 0,
  veto_count: 0,
  status: "pending",
  is_boosted: 0,
  boost_position: null,
  manual_order: null,
  added_by_guest_id: null,
  from_seed: 0,
  from_spotify: 0,
  added_at: "2026-01-01T00:00:00.000Z",
  finished_at: null,
  ...overrides,
});

describe("isUriBufferedInSpotify", () => {
  const uri = "spotify:track:abc123";

  test("detects track in upcoming queue", () => {
    expect(
      isUriBufferedInSpotify(uri, {
        currentlyPlaying: null,
        queue: [spotifyTrack("spotify:track:other"), spotifyTrack(uri)],
      }),
    ).toBe(true);
  });

  test("detects track as currently playing", () => {
    expect(
      isUriBufferedInSpotify(uri, {
        currentlyPlaying: spotifyTrack(uri),
        queue: [],
      }),
    ).toBe(true);
  });

  test("returns false when track is absent", () => {
    expect(
      isUriBufferedInSpotify(uri, {
        currentlyPlaying: spotifyTrack("spotify:track:other"),
        queue: [spotifyTrack("spotify:track:another")],
      }),
    ).toBe(false);
  });
});

describe("getManagedSpotifyQueueUris", () => {
  test("returns only active virtual queue URIs from Spotify queue", () => {
    const items = [
      base({ spotify_uri: "spotify:track:stale", status: "pending" }),
      base({ id: "2", spotify_uri: "spotify:track:played", status: "played" }),
    ];
    expect(
      getManagedSpotifyQueueUris(items, {
        queue: [
          { uri: "spotify:track:stale" },
          { uri: "spotify:track:foreign" },
          { uri: "spotify:track:played" },
        ],
      }),
    ).toEqual(["spotify:track:stale"]);
  });
});

describe("reconcileSpotifyBufferStatuses", () => {
  function testDb(): Db {
    const db = new Database(":memory:") as Db;
    db.run(`
      CREATE TABLE queue_items (
        id TEXT PRIMARY KEY,
        party_id TEXT NOT NULL,
        spotify_uri TEXT NOT NULL,
        track_name TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        album_art_url TEXT,
        upvote_count INTEGER NOT NULL DEFAULT 0,
        veto_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        is_boosted INTEGER NOT NULL DEFAULT 0,
        boost_position INTEGER,
        manual_order INTEGER,
        added_by_guest_id TEXT,
      from_seed INTEGER NOT NULL DEFAULT 0,
      from_spotify INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL,
        finished_at TEXT
      )
    `);
    return db;
  }

  test("marks the Spotify buffer track as queued and demotes stale queued rows", () => {
    const db = testDb();
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, from_seed, added_at)
       VALUES ('spotify-next', 'p', 'spotify:track:next', 'Next', 'Artist', 'pending', 0, '2026-01-01T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, from_seed, added_at)
       VALUES ('stale', 'p', 'spotify:track:stale', 'Stale', 'Artist', 'queued', 0, '2026-01-02T00:00:00.000Z')`,
    );

    const items = [
      base({ id: "spotify-next", spotify_uri: "spotify:track:next", status: "pending" }),
      base({ id: "stale", spotify_uri: "spotify:track:stale", status: "queued" }),
    ];

    reconcileSpotifyBufferStatuses(db, "p", items, {
      currentlyPlaying: null,
      queue: [{ uri: "spotify:track:next", id: "x", name: "Next", artists: [{ name: "Artist" }], album: { images: [] } }],
    });

    const next = db
      .query(`SELECT status FROM queue_items WHERE id = ?`)
      .get("spotify-next") as { status: string };
    const stale = db
      .query(`SELECT status FROM queue_items WHERE id = ?`)
      .get("stale") as { status: string };

    expect(next.status).toBe("queued");
    expect(stale.status).toBe("pending");
  });

  test("imports an external Spotify queue track as queued", () => {
    const db = testDb();
    reconcileSpotifyBufferStatuses(db, "p", [], {
      currentlyPlaying: null,
      queue: [
        {
          uri: "spotify:track:external",
          id: "ext",
          name: "External Song",
          artists: [{ name: "DJ" }],
          album: { images: [{ url: "https://art.test/a.jpg" }] },
        },
      ],
    });

    const row = db
      .query(
        `SELECT status, track_name, artist_name, from_spotify FROM queue_items WHERE spotify_uri = ?`,
      )
      .get("spotify:track:external") as {
      status: string;
      track_name: string;
      artist_name: string;
      from_spotify: number;
    };

    expect(row.status).toBe("queued");
    expect(row.track_name).toBe("External Song");
    expect(row.artist_name).toBe("DJ");
    expect(row.from_spotify).toBe(1);
  });
});

describe("getVirtualNextToBuffer", () => {
  test("skips tracks already in Spotify and picks next pending virtual track", () => {
    const buffered = base({
      id: "buffered",
      spotify_uri: "spotify:track:buffered",
      status: "queued",
    });
    const boosted = base({
      id: "boost",
      spotify_uri: "spotify:track:boost",
      is_boosted: 1,
      boost_position: 1,
      added_at: "2026-01-02T00:00:00.000Z",
    });
    const later = base({
      id: "later",
      spotify_uri: "spotify:track:later",
      added_at: "2026-01-03T00:00:00.000Z",
    });
    const items = [buffered, boosted, later];
    const queueData = {
      currentlyPlaying: spotifyTrack("spotify:track:now"),
      queue: [spotifyTrack("spotify:track:buffered")],
    };

    expect(getVirtualNextToBuffer(items, queueData)).toBeNull();
    expect(getUpcomingPlayOrder(items).map((i) => i.id)).toEqual([
      "buffered",
      "boost",
      "later",
    ]);
  });

  test("returns first pending virtual track when Spotify buffer is empty", () => {
    const boosted = base({
      id: "boost",
      is_boosted: 1,
      boost_position: 1,
    });
    const normal = base({
      id: "normal",
      spotify_uri: "spotify:track:normal",
      added_at: "2026-01-02T00:00:00.000Z",
    });
    const next = getVirtualNextToBuffer([boosted, normal], {
      currentlyPlaying: spotifyTrack("spotify:track:now"),
      queue: [],
    });
    expect(next?.id).toBe("normal");
  });
});

describe("shouldSkipTerminalPlayback", () => {
  test("only skips vetoed or skipped tracks", () => {
    expect(shouldSkipTerminalPlayback(base({ status: "vetoed" }))).toBe(true);
    expect(shouldSkipTerminalPlayback(base({ status: "skipped" }))).toBe(true);
    expect(shouldSkipTerminalPlayback(base({ status: "pending" }))).toBe(false);
  });
});

describe("buildEffectiveQueueSnapshot", () => {
  test("fills currentlyPlaying from player snapshot when queue API omits it", () => {
    const items = [
      base({
        id: "playing",
        spotify_uri: "spotify:track:live",
        track_name: "Live Track",
        artist_name: "Live Artist",
        status: "pending",
      }),
    ];
    const effective = buildEffectiveQueueSnapshot(
      { currentlyPlaying: null, queue: [] },
      {
        deviceActive: true,
        isPlaying: true,
        deviceRestricted: false,
        deviceName: "Phone",
        currentUri: "spotify:track:live",
      },
      items,
    );
    expect(effective.currentlyPlaying?.uri).toBe("spotify:track:live");
    expect(effective.currentlyPlaying?.name).toBe("Live Track");
  });
});

describe("sync pacing helpers", () => {
  test("detects when party generation is ahead of last Spotify sync", () => {
    expect(partyNeedsSpotifyQueueSync({} as Db, "party-a", 2)).toBe(true);
  });

  test("uses idle interval when party is null", () => {
    expect(getSyncIntervalMs({} as Db, null)).toBe(20_000);
  });
});
