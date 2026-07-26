import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  buildEffectiveQueueSnapshot,
  dedupeSpotifyQueueTracks,
  findActiveQueueItemByUri,
  getManagedSpotifyQueueUris,
  getSpotifyBufferTrack,
  getSyncIntervalMs,
  getVirtualNextToBuffer,
  inferPaddedSpotifyQueueLength,
  isSpotifyBufferOccupied,
  isUriBufferedInSpotify,
  normalizeSpotifyQueueSnapshot,
  partyHasPendingBufferWork,
  partyNeedsSpotifyQueueSync,
  reconcileSpotifyBufferStatuses,
  reconcileSpotifyQueueTail,
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
      },
      items,
    );
    expect(effective.currentlyPlaying?.name).toBe("Even Flow");
  });

  test("uses player snapshot when track only exists as played in the virtual queue", () => {
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
      },
      items,
    );
    expect(effective.currentlyPlaying?.uri).toBe(myWayUri);
    expect(effective.currentlyPlaying?.name).toBe("My Way");
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
    expect(getSyncIntervalMs({} as Db, null)).toBe(60_000);
  });

  test("uses 10s interval when party is active", () => {
    expect(
      getSyncIntervalMs({} as Db, { id: "party-a", sync_generation: 0 }),
    ).toBe(10_000);
  });
});
