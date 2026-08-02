import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  buildEffectiveQueueSnapshot,
  dedupeSpotifyQueueTracks,
  findActiveQueueItemByUri,
  getManagedSpotifyQueueUris,
  getSpotifyBufferTrack,
  getSyncIntervalMs,
  computeAdaptiveSyncDelayMs,
  configureSyncPolling,
  getSyncState,
  markBootstrapPlaybackStarted,
  resetSyncStateForTests,
  runPartySyncForTests,
  runSyncTickForTests,
  setPartyTargetDevice,
  getVirtualNextToBuffer,
  inferPaddedSpotifyQueueLength,
  isSpotifyBufferOccupied,
  isUriBufferedInSpotify,
  normalizeSpotifyQueueSnapshot,
  partyNeedsSpotifyQueueSync,
  reconcileSpotifyBufferStatuses,
  reconcileSpotifyQueueTail,
  shouldSkipTerminalPlayback,
} from "../../src/server/services/sync";
import { getUpcomingPlayOrder, type QueueItemRow } from "../../src/server/services/queue";
import type { Db } from "../../src/server/db/schema";

import type { SpotifyTrack } from "@/shared/types";
import type { SpotifyClient } from "../../src/server/services/spotify";

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
  downvote_count: 0,
  status: "pending",
  is_boosted: 0,
  boost_position: null,
  boosted_by_guest_id: null,
  manual_order: null,
  added_by_guest_id: null,
  from_seed: 0,
  from_spotify: 0,
  added_at: "2026-01-01T00:00:00.000Z",
  finished_at: null,
  duration_ms: null,
  ...overrides,
});

describe("normalizeSpotifyQueueSnapshot", () => {
  test("treats homogeneous padded queue as empty when track is not managed", () => {
    const phantom = spotifyTrack("spotify:track:7FXj7Qg3YorUxdrzvrcY25", "Phantom");
    const normalized = normalizeSpotifyQueueSnapshot(
      {
        currentlyPlaying: spotifyTrack("spotify:track:1mea3bSkSGXuIRvnydlB5b", "Viva La Vida"),
        queue: Array.from({ length: 10 }, () => phantom),
      },
      [],
    );
    expect(normalized.queue).toEqual([]);
    expect(getSpotifyBufferTrack(normalized)).toBeNull();
  });

  test("keeps padded queue when the track is in the virtual queue", () => {
    const buffered = spotifyTrack("spotify:track:buffered");
    const normalized = normalizeSpotifyQueueSnapshot(
      {
        currentlyPlaying: spotifyTrack("spotify:track:now"),
        queue: Array.from({ length: 10 }, () => buffered),
      },
      [base({ spotify_uri: "spotify:track:buffered", status: "queued" })],
    );
    expect(normalized.queue).toHaveLength(1);
    expect(normalized.queue[0]?.uri).toBe("spotify:track:buffered");
  });

  test("collapses alternating padded queue to two real tracks", () => {
    const a = spotifyTrack("spotify:track:a");
    const b = spotifyTrack("spotify:track:b");
    const padded = [a, b, a, b, a, b, a, b];
    expect(inferPaddedSpotifyQueueLength(padded)).toBe(2);
    expect(dedupeSpotifyQueueTracks(padded, null)).toEqual([a, b]);
  });

  test("drops terminal tracks from padded alternating queue", () => {
    const flyMe = spotifyTrack("spotify:track:7FXj7Qg3YorUxdrzvrcY25", "Fly Me");
    const myWay = spotifyTrack("spotify:track:3spdoTYpuCpmq19tuD0bOe", "My Way");
    const padded = [flyMe, myWay, flyMe, myWay, flyMe, myWay];
    const items = [
      base({ spotify_uri: "spotify:track:7FXj7Qg3YorUxdrzvrcY25", status: "played" }),
      base({ id: "2", spotify_uri: "spotify:track:3spdoTYpuCpmq19tuD0bOe", status: "playing" }),
      base({ id: "3", spotify_uri: "spotify:track:5Xak5fmy089t0FYmh3VJiY", status: "pending", track_name: "Black" }),
    ];
    const normalized = normalizeSpotifyQueueSnapshot(
      { currentlyPlaying: myWay, queue: padded },
      items,
    );
    expect(normalized.queue).toEqual([]);
    expect(getSpotifyBufferTrack(normalized, items)).toBeNull();
    expect(getVirtualNextToBuffer(items, normalized)?.track_name).toBe("Black");
  });

  test("skips pending row when same URI already played elsewhere", () => {
    const flyMeUri = "spotify:track:7FXj7Qg3YorUxdrzvrcY25";
    const items = [
      base({ spotify_uri: flyMeUri, status: "played", track_name: "Fly Me" }),
      base({
        id: "2",
        spotify_uri: "spotify:track:5Xak5fmy089t0FYmh3VJiY",
        status: "playing",
        track_name: "Black",
      }),
      base({
        id: "dup",
        spotify_uri: flyMeUri,
        status: "pending",
        track_name: "Fly Me duplicate",
      }),
      base({
        id: "4",
        spotify_uri: "spotify:track:2bku1YWarHpKlxVC2FB9dH",
        status: "pending",
        track_name: "Sabbath",
      }),
    ];
    const queueData = {
      currentlyPlaying: spotifyTrack("spotify:track:5Xak5fmy089t0FYmh3VJiY", "Black"),
      queue: [],
    };
    expect(getVirtualNextToBuffer(items, queueData)?.track_name).toBe("Sabbath");
  });

  test("buffers pending re-queue when same URI was skipped but not played", () => {
    const evenFlowUri = "spotify:track:6QewNVIDKdSl8Y3ycuHIei";
    const items = [
      base({ spotify_uri: evenFlowUri, status: "skipped", track_name: "Even Flow" }),
      base({
        id: "2",
        spotify_uri: "spotify:track:70C4NyhjD5OZUMzvWZ3njJ",
        status: "playing",
        track_name: "Piano Man",
      }),
      base({
        id: "3",
        spotify_uri: evenFlowUri,
        status: "pending",
        track_name: "Even Flow",
        added_at: "2026-01-03T00:00:00.000Z",
      }),
    ];
    const queueData = {
      currentlyPlaying: spotifyTrack("spotify:track:70C4NyhjD5OZUMzvWZ3njJ", "Piano Man"),
      queue: [],
    };
    expect(getVirtualNextToBuffer(items, queueData)?.track_name).toBe("Even Flow");
  });
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
        downvote_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        is_boosted INTEGER NOT NULL DEFAULT 0,
        boost_position INTEGER,
        boosted_by_guest_id TEXT,
        manual_order INTEGER,
        added_by_guest_id TEXT,
      from_seed INTEGER NOT NULL DEFAULT 0,
      from_spotify INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER
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

  test("skips queue head when it duplicates currently playing", () => {
    const now = {
      uri: "spotify:track:now",
      id: "now",
      name: "Now Playing",
      artists: [{ name: "Artist" }],
      album: { images: [] },
    };
    expect(
      getSpotifyBufferTrack({
        currentlyPlaying: now,
        queue: [now, { ...now, name: "Still duplicate" }],
      }),
    ).toBeNull();
    expect(
      getSpotifyBufferTrack({
        currentlyPlaying: now,
        queue: [
          now,
          {
            uri: "spotify:track:next",
            id: "next",
            name: "Next",
            artists: [{ name: "Artist" }],
            album: { images: [] },
          },
        ],
      })?.uri,
    ).toBe("spotify:track:next");
  });

  test("does not demote playing track when Spotify queue duplicates now playing", () => {
    const db = testDb();
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, from_seed, added_at)
       VALUES ('playing', 'p', 'spotify:track:now', 'Now', 'Artist', 'playing', 0, '2026-01-01T00:00:00.000Z')`,
    );
    const now = {
      uri: "spotify:track:now",
      id: "now",
      name: "Now Playing",
      artists: [{ name: "Artist" }],
      album: { images: [] },
    };
    reconcileSpotifyBufferStatuses(db, "p", [base({ id: "playing", spotify_uri: "spotify:track:now", status: "playing" })], {
      currentlyPlaying: now,
      queue: [now],
    });
    const row = db
      .query(`SELECT status FROM queue_items WHERE id = ?`)
      .get("playing") as { status: string };
    expect(row.status).toBe("playing");
  });

  test("does not demote queued rows when Spotify reports empty buffer", () => {
    const db = testDb();
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, from_seed, added_at)
       VALUES ('buffered', 'p', 'spotify:track:even', 'Even Flow', 'Artist', 'queued', 0, '2026-01-01T00:00:00.000Z')`,
    );
    reconcileSpotifyBufferStatuses(
      db,
      "p",
      [base({ id: "buffered", spotify_uri: "spotify:track:even", status: "queued" })],
      { currentlyPlaying: null, queue: [] },
    );
    const row = db
      .query(`SELECT status FROM queue_items WHERE id = ?`)
      .get("buffered") as { status: string };
    expect(row.status).toBe("queued");
  });

  test("demotes stale queued rows when Spotify reports now playing but no buffer", () => {
    const db = testDb();
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, from_seed, added_at)
       VALUES ('wrong', 'p', 'spotify:track:brown', 'Brown Eyed Girl', 'Artist', 'queued', 0, '2026-01-01T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, from_seed, added_at)
       VALUES ('next', 'p', 'spotify:track:rich', 'Rich Girl', 'Artist', 'pending', 0, '2026-01-02T00:00:00.000Z')`,
    );
    reconcileSpotifyBufferStatuses(
      db,
      "p",
      [
        base({ id: "wrong", spotify_uri: "spotify:track:brown", status: "queued" }),
        base({ id: "next", spotify_uri: "spotify:track:rich", status: "pending" }),
      ],
      {
        currentlyPlaying: spotifyTrack("spotify:track:myway", "My Way"),
        queue: [],
      },
      { aggressive: true },
    );
    const wrong = db
      .query(`SELECT status FROM queue_items WHERE id = ?`)
      .get("wrong") as { status: string };
    expect(wrong.status).toBe("pending");
  });

  test("imports Spotify queue tail tracks as locked pending rows", () => {
    const db = testDb();
    const now = {
      uri: "spotify:track:now",
      id: "now",
      name: "Now",
      artists: [{ name: "A" }],
      album: { images: [] },
    };
    reconcileSpotifyQueueTail(db, "p", {
      currentlyPlaying: now,
      queue: [
        now,
        {
          uri: "spotify:track:buffer",
          id: "buf",
          name: "Buffer",
          artists: [{ name: "A" }],
          album: { images: [] },
        },
        {
          uri: "spotify:track:tail",
          id: "tail",
          name: "Tail Song",
          artists: [{ name: "B" }],
          album: { images: [] },
        },
      ],
    });

    const row = db
      .query(
        `SELECT status, track_name, from_spotify FROM queue_items WHERE spotify_uri = ?`,
      )
      .get("spotify:track:tail") as {
      status: string;
      track_name: string;
      from_spotify: number;
    };

    expect(row.status).toBe("pending");
    expect(row.track_name).toBe("Tail Song");
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

  test("returns null when jukebox queued buffer is not visible in Spotify API", () => {
    const buffered = base({
      id: "buffered",
      spotify_uri: "spotify:track:even",
      status: "queued",
    });
    const next = base({
      id: "next",
      spotify_uri: "spotify:track:animal",
      status: "pending",
    });
    expect(
      getVirtualNextToBuffer([buffered, next], {
        currentlyPlaying: spotifyTrack("spotify:track:now"),
        queue: [],
      }),
    ).toBeNull();
  });
});

describe("shouldSkipTerminalPlayback", () => {
  test("only skips downvoted or skipped tracks", () => {
    expect(shouldSkipTerminalPlayback(base({ status: "downvoted" }))).toBe(true);
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
        deviceId: "device-1",
        progressMs: null,
        durationMs: null,
      },
      items,
    );
    expect(effective.currentlyPlaying?.uri).toBe("spotify:track:live");
    expect(effective.currentlyPlaying?.name).toBe("Live Track");
  });

  test("prefers active duplicate row over skipped sibling for player snapshot", () => {
    const evenFlowUri = "spotify:track:6QewNVIDKdSl8Y3ycuHIei";
    const items = [
      base({ spotify_uri: evenFlowUri, status: "skipped", track_name: "Even Flow" }),
      base({
        id: "2",
        spotify_uri: evenFlowUri,
        status: "queued",
        track_name: "Even Flow",
      }),
    ];
    const effective = buildEffectiveQueueSnapshot(
      { currentlyPlaying: null, queue: [] },
      {
        deviceActive: true,
        isPlaying: true,
        deviceRestricted: false,
        deviceName: "Phone",
        currentUri: evenFlowUri,
        deviceId: "device-1",
        progressMs: null,
        durationMs: null,
      },
      items,
    );
    expect(effective.currentlyPlaying?.uri).toBe(evenFlowUri);
    expect(findActiveQueueItemByUri(items, evenFlowUri)?.status).toBe("queued");
  });

  test("player snapshot wins over stale queue API currently playing", () => {
    const items = [
      base({
        id: "piano",
        spotify_uri: "spotify:track:70C4NyhjD5OZUMzvWZ3njJ",
        status: "played",
        track_name: "Piano Man",
      }),
      base({
        id: "even",
        spotify_uri: "spotify:track:6QewNVIDKdSl8Y3ycuHIei",
        status: "queued",
        track_name: "Even Flow",
      }),
    ];
    const effective = buildEffectiveQueueSnapshot(
      {
        currentlyPlaying: spotifyTrack("spotify:track:70C4NyhjD5OZUMzvWZ3njJ", "Piano Man"),
        queue: [],
      },
      {
        deviceActive: true,
        isPlaying: true,
        deviceRestricted: false,
        deviceName: "Phone",
        currentUri: "spotify:track:6QewNVIDKdSl8Y3ycuHIei",
        deviceId: "device-1",
        progressMs: null,
        durationMs: null,
      },
      items,
    );
    expect(effective.currentlyPlaying?.name).toBe("Even Flow");
  });

  test("ignores player snapshot when track only exists as skipped in the virtual queue", () => {
    const skippedUri = "spotify:track:skipped";
    const items = [
      base({ spotify_uri: skippedUri, status: "skipped", track_name: "Skipped Song" }),
      base({
        id: "2",
        spotify_uri: "spotify:track:next",
        status: "queued",
        track_name: "Next Song",
      }),
    ];
    const effective = buildEffectiveQueueSnapshot(
      { currentlyPlaying: null, queue: [] },
      {
        deviceActive: true,
        isPlaying: true,
        deviceRestricted: false,
        deviceName: "Phone",
        currentUri: skippedUri,
        deviceId: "device-1",
        progressMs: null,
        durationMs: null,
      },
      items,
    );
    expect(effective.currentlyPlaying).toBeNull();
  });

  test("ignores player snapshot when track only exists as played in the virtual queue", () => {
    const myWayUri = "spotify:track:3spdoTYpuCpmq19tuD0bOe";
    const items = [
      base({
        id: "played",
        spotify_uri: myWayUri,
        status: "played",
        track_name: "My Way",
      }),
      base({
        id: "other",
        spotify_uri: "spotify:track:other",
        status: "playing",
        track_name: "Other Song",
      }),
    ];
    const effective = buildEffectiveQueueSnapshot(
      { currentlyPlaying: null, queue: [] },
      {
        deviceActive: true,
        isPlaying: true,
        deviceRestricted: false,
        deviceName: "Phone",
        currentUri: myWayUri,
        deviceId: "device-1",
        progressMs: null,
        durationMs: null,
      },
      items,
    );
    expect(effective.currentlyPlaying).toBeNull();
    expect(findActiveQueueItemByUri(items, myWayUri)).toBeUndefined();
  });
});

describe("isSpotifyBufferOccupied", () => {
  test("trusts in-flight queued row when Spotify queue API is empty", () => {
    expect(
      isSpotifyBufferOccupied(
        { currentlyPlaying: null, queue: [] },
        [base({ status: "queued", spotify_uri: "spotify:track:even" })],
      ),
    ).toBe(true);
  });

  test("trusts canonical queued buffer when Spotify queue API omits it", () => {
    expect(
      isSpotifyBufferOccupied(
        {
          currentlyPlaying: spotifyTrack("spotify:track:now"),
          queue: [],
        },
        [base({ status: "queued", spotify_uri: "spotify:track:even" })],
      ),
    ).toBe(true);
  });
});

describe("sync pacing helpers", () => {
  test("detects when party generation is ahead of last Spotify sync", () => {
    expect(partyNeedsSpotifyQueueSync({} as Db, "party-a", 2)).toBe(true);
  });

  test("uses long interval when party is null", () => {
    expect(getSyncIntervalMs({} as Db, null)).toBe(15_000);
  });

  test("uses 10s interval when fast poll is enabled", () => {
    configureSyncPolling({
      syncFastPoll: true,
      syncEndWindowMs: 7000,
      syncFallbackIntervalMs: 30_000,
      syncIdleIntervalMs: 60_000,
    });
    expect(
      getSyncIntervalMs({} as Db, { id: "party-a", sync_generation: 0 }),
    ).toBe(10_000);
  });

  test("syncs immediately when party generation is pending and playback is active", () => {
    resetSyncStateForTests();
    markBootstrapPlaybackStarted("device-1", "Speaker");
    expect(
      getSyncIntervalMs({} as Db, { id: "party-a", sync_generation: 1 }),
    ).toBe(0);
  });

  test("waits out inactive device instead of tight-loop polling", () => {
    resetSyncStateForTests();
    configureSyncPolling({
      syncFastPoll: false,
      syncEndWindowMs: 7000,
      syncFallbackIntervalMs: 30_000,
      syncIdleIntervalMs: 60_000,
    });
    expect(
      getSyncIntervalMs({} as Db, { id: "party-a", sync_generation: 1 }),
    ).toBe(30_000);
  });

  test("schedules near-end poll from track timing", () => {
    resetSyncStateForTests();
    const capturedAt = Date.now();
    configureSyncPolling({
      syncFastPoll: false,
      syncEndWindowMs: 7000,
      syncFallbackIntervalMs: 30_000,
      syncIdleIntervalMs: 60_000,
    });
    const state = getSyncState();
    state.playbackTiming = {
      currentUri: "spotify:track:1",
      progressMs: 170_000,
      durationMs: 180_000,
      isPlaying: true,
      capturedAt,
    };
    expect(computeAdaptiveSyncDelayMs()).toBe(3000);
  });

  test("uses fallback interval when playing without timing", () => {
    resetSyncStateForTests();
    configureSyncPolling({
      syncFastPoll: false,
      syncEndWindowMs: 7000,
      syncFallbackIntervalMs: 30_000,
      syncIdleIntervalMs: 60_000,
    });
    const state = getSyncState();
    state.playbackTiming = {
      currentUri: "spotify:track:1",
      progressMs: null,
      durationMs: null,
      isPlaying: true,
      capturedAt: Date.now(),
    };
    expect(computeAdaptiveSyncDelayMs()).toBe(30_000);
  });

  test("uses idle interval when paused with no pending sync", () => {
    resetSyncStateForTests();
    configureSyncPolling({
      syncFastPoll: false,
      syncEndWindowMs: 7000,
      syncFallbackIntervalMs: 30_000,
      syncIdleIntervalMs: 60_000,
    });
    const state = getSyncState();
    state.playbackTiming = {
      currentUri: "spotify:track:1",
      progressMs: 90_000,
      durationMs: 180_000,
      isPlaying: false,
      capturedAt: Date.now(),
    };
    expect(computeAdaptiveSyncDelayMs()).toBe(60_000);
  });

  test("polls soon when track is near end", () => {
    resetSyncStateForTests();
    configureSyncPolling({
      syncFastPoll: false,
      syncEndWindowMs: 7000,
      syncFallbackIntervalMs: 30_000,
      syncIdleIntervalMs: 60_000,
    });
    const state = getSyncState();
    state.playbackTiming = {
      currentUri: "spotify:track:1",
      progressMs: 176_000,
      durationMs: 180_000,
      isPlaying: true,
      capturedAt: Date.now(),
    };
    expect(computeAdaptiveSyncDelayMs()).toBe(1000);
  });
});

describe("runSyncTick without active party", () => {
  test("refreshes player snapshot for admin status", async () => {
    resetSyncStateForTests();
    const db = {
      query: () => ({ get: () => null }),
    } as unknown as Db;
    const spotify = {
      getAccessToken: async () => "token",
      getPlayerSnapshot: async () => ({
        deviceActive: true,
        isPlaying: true,
        deviceRestricted: false,
        deviceId: "device-1",
        deviceName: "MacBook",
        currentUri: "spotify:track:1",
        progressMs: 1000,
        durationMs: 180_000,
      }),
    };
    await runSyncTickForTests(db, spotify as SpotifyClient);
    const state = getSyncState();
    expect(state.deviceActive).toBe(true);
    expect(state.isPlaying).toBe(true);
    expect(state.deviceName).toBe("MacBook");
    expect(state.spotifyReachable).toBe(true);
  });
});

describe("device transfer on target mismatch", () => {
  function partyDb(targetDeviceId = "target-device"): Db {
    const db = new Database(":memory:") as Db;
    db.run(`
      CREATE TABLE parties (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        downvote_threshold INTEGER NOT NULL DEFAULT 3,
        seed_playlist_id TEXT NOT NULL,
        rate_limits TEXT NOT NULL,
        sync_generation INTEGER NOT NULL DEFAULT 0,
        bootstrap_playlist_id TEXT,
        target_spotify_device_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE guests (
        id TEXT PRIMARY KEY,
        party_id TEXT NOT NULL,
        session_token TEXT NOT NULL UNIQUE,
        display_name TEXT,
        boost_used INTEGER NOT NULL DEFAULT 0,
        tutorial_seen INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        last_ip TEXT
      )
    `);
    db.run(`
      CREATE TABLE queue_items (
        id TEXT PRIMARY KEY,
        party_id TEXT NOT NULL,
        spotify_uri TEXT NOT NULL,
        track_name TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        album_art_url TEXT,
        upvote_count INTEGER NOT NULL DEFAULT 0,
        downvote_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        is_boosted INTEGER NOT NULL DEFAULT 0,
        boost_position INTEGER,
        boosted_by_guest_id TEXT,
        manual_order INTEGER,
        added_by_guest_id TEXT,
        from_seed INTEGER NOT NULL DEFAULT 0,
        from_spotify INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER
      )
    `);
    db.run(
      `INSERT INTO parties (id, slug, name, status, downvote_threshold, seed_playlist_id, rate_limits, target_spotify_device_id, created_at, updated_at)
       VALUES ('party-1', 'party', 'Party', 'on', 3, 'seed', '{}', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      [targetDeviceId],
    );
    return db;
  }

  const playingSnapshot = {
    deviceActive: true,
    isPlaying: true,
    deviceRestricted: false,
    deviceId: "old-device",
    deviceName: "Old Speaker",
    currentUri: "spotify:track:live",
    progressMs: 1000,
    durationMs: 180_000,
  };

  test("calls transferPlayback when playing device differs from target", async () => {
    resetSyncStateForTests();
    const db = partyDb("target-device");
    setPartyTargetDevice("target-device", "Target Speaker");
    const apiCalls: string[] = [];
    const spotify = {
      transferPlayback: async (deviceId: string, play?: boolean) => {
        apiCalls.push(`transferPlayback:${deviceId}:${String(play)}`);
      },
      getQueue: async () => ({
        currentlyPlaying: spotifyTrack("spotify:track:live"),
        queue: [],
      }),
      getAvailableDevices: async () => [],
      skipNext: async () => {},
      addToQueue: async () => {},
    } as unknown as SpotifyClient;

    await runPartySyncForTests(db, spotify, "party-1", playingSnapshot);

    expect(apiCalls).toEqual(["transferPlayback:target-device:true"]);
    const state = getSyncState();
    expect(state.deviceMismatch).toBe(true);
    expect(state.deviceTransferPending).toBe(true);
  });

  test("skips reconcile when devices mismatch", async () => {
    resetSyncStateForTests();
    const db = partyDb("target-device");
    setPartyTargetDevice("target-device", "Target Speaker");
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, from_seed, added_at)
       VALUES ('playing', 'party-1', 'spotify:track:live', 'Live', 'Artist', 'playing', 0, '2026-01-01T00:00:00.000Z')`,
    );
    const spotify = {
      transferPlayback: async () => {},
      getQueue: async () => {
        throw new Error("getQueue should not run during mismatch");
      },
      getAvailableDevices: async () => [],
    } as unknown as SpotifyClient;

    await runPartySyncForTests(db, spotify, "party-1", playingSnapshot);

    const row = db
      .query(`SELECT status FROM queue_items WHERE id = 'playing'`)
      .get() as { status: string };
    expect(row.status).toBe("playing");
  });

  test("clears mismatch and reconciles when devices match", async () => {
    resetSyncStateForTests();
    const db = partyDb("target-device");
    setPartyTargetDevice("target-device", "Target Speaker");
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, from_seed, added_at)
       VALUES ('playing', 'party-1', 'spotify:track:live', 'Live', 'Artist', 'playing', 0, '2026-01-01T00:00:00.000Z')`,
    );
    const apiCalls: string[] = [];
    const spotify = {
      transferPlayback: async () => {
        apiCalls.push("transferPlayback");
      },
      getQueue: async () => ({
        currentlyPlaying: spotifyTrack("spotify:track:live"),
        queue: [],
      }),
      getAvailableDevices: async () => [],
      skipNext: async () => {},
      addToQueue: async () => {},
    } as unknown as SpotifyClient;

    await runPartySyncForTests(db, spotify, "party-1", {
      ...playingSnapshot,
      deviceId: "target-device",
      deviceName: "Target Speaker",
    });

    expect(apiCalls).toEqual([]);
    const state = getSyncState();
    expect(state.deviceMismatch).toBe(false);
    expect(state.deviceTransferPending).toBe(false);
  });

  test("sets backoff when transfer fails", async () => {
    resetSyncStateForTests();
    const db = partyDb("target-device");
    setPartyTargetDevice("target-device", "Target Speaker");
    const spotify = {
      transferPlayback: async () => {
        throw new Error("SPOTIFY_500:Server error");
      },
      getAvailableDevices: async () => [],
    } as unknown as SpotifyClient;

    await runPartySyncForTests(db, spotify, "party-1", playingSnapshot);

    const state = getSyncState();
    expect(state.deviceMismatch).toBe(true);
    expect(state.deviceTransferRetryUntil).not.toBeNull();
    expect(state.lastError).toContain("retrying in");
  });
});
