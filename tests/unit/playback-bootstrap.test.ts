import { Database } from "bun:sqlite";
import { describe, expect, test, beforeEach } from "bun:test";
import {
  bootstrapSpotifyPlayback,
  cleanupBootstrapPlaylist,
} from "../../src/server/services/playback-bootstrap";
import type { SpotifyClient, PlayerSnapshot } from "../../src/server/services/spotify";
import type { SpotifyConnectDevice, SpotifyTrack } from "../../src/shared/types";
import { DEFAULT_RATE_LIMITS } from "../../src/shared/types";
import {
  isSpotifyDeviceRestricted,
  mapSpotifyConnectDevice,
  sortSpotifyConnectDevices,
} from "../../src/server/services/spotify";

const SCHEMA = `
CREATE TABLE parties (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'off', downvote_threshold INTEGER NOT NULL DEFAULT 3,
  boost_cap INTEGER, seed_playlist_id TEXT NOT NULL, rate_limits TEXT NOT NULL,
  sync_generation INTEGER NOT NULL DEFAULT 0,
  bootstrap_playlist_id TEXT, target_spotify_device_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE queue_items (
  id TEXT PRIMARY KEY, party_id TEXT NOT NULL, spotify_uri TEXT NOT NULL,
  track_name TEXT NOT NULL, artist_name TEXT NOT NULL, album_art_url TEXT,
  upvote_count INTEGER NOT NULL DEFAULT 0, downvote_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', is_boosted INTEGER NOT NULL DEFAULT 0,
  boost_position INTEGER, manual_order INTEGER, added_by_guest_id TEXT,
  boosted_by_guest_id TEXT,
  added_at TEXT NOT NULL, finished_at TEXT,
  from_seed INTEGER NOT NULL DEFAULT 0, from_spotify INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER
);
CREATE TABLE guests (
  id TEXT PRIMARY KEY, party_id TEXT NOT NULL, session_token TEXT NOT NULL UNIQUE,
  display_name TEXT, boost_used INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
`;

function testDb(): Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

function seedParty(
  db: Database,
  overrides?: {
    name?: string;
    bootstrapPlaylistId?: string | null;
    targetDeviceId?: string | null;
  },
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO parties (id, slug, name, status, downvote_threshold, seed_playlist_id, rate_limits, bootstrap_playlist_id, target_spotify_device_id, created_at, updated_at)
     VALUES (?, ?, ?, 'off', 3, 'seed', ?, ?, ?, ?, ?)`,
    [
      id,
      `slug-${id.slice(0, 8)}`,
      overrides?.name ?? "Friday Night",
      JSON.stringify(DEFAULT_RATE_LIMITS),
      overrides?.bootstrapPlaylistId ?? null,
      overrides && "targetDeviceId" in overrides
        ? (overrides.targetDeviceId ?? null)
        : "speaker-1",
      now,
      now,
    ],
  );
  return id;
}

function seedTrack(db: Database, partyId: string, uri: string, status = "pending") {
  db.run(
    `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, added_at)
     VALUES (?, ?, ?, 'Track', 'Artist', ?, ?)`,
    [crypto.randomUUID(), partyId, uri, status, new Date().toISOString()],
  );
}

function createMockSpotify() {
  const state = {
    createdPlaylists: [] as { name: string; id: string }[],
    deletedPlaylists: [] as string[],
    playbackCalls: [] as { playlistId: string; deviceId: string }[],
    playlistsByName: new Map<string, string>(),
    nextId: 1,
  };

  const emptySnapshot: PlayerSnapshot = {
    deviceActive: true,
    isPlaying: false,
    deviceRestricted: false,
    deviceId: "speaker-1",
    deviceName: "Speaker",
    currentUri: null,
    progressMs: null,
    durationMs: null,
  };

  return {
    ...state,
    get createdPlaylists() {
      return state.createdPlaylists;
    },
    get deletedPlaylists() {
      return state.deletedPlaylists;
    },
    get playbackCalls() {
      return state.playbackCalls;
    },
    get playlistsByName() {
      return state.playlistsByName;
    },
    async getAccessToken() {
      return "token";
    },
    async getPlayerSnapshot() {
      return emptySnapshot;
    },
    async searchTracks() {
      return [];
    },
    async searchCatalog() {
      return { tracks: [], artists: [] };
    },
    async searchArtists() {
      return [];
    },
    async searchArtistTracks() {
      return [];
    },
    async getPlaylistTracks() {
      return [];
    },
    async getUserPlaylists() {
      return [];
    },
    async getCurrentlyPlaying() {
      return { uri: null, isPlaying: false, deviceActive: true };
    },
    async getQueue() {
      return { currentlyPlaying: null, queue: [] };
    },
    async addToQueue() {},
    async skipNext() {},
    async play() {},
    async pause() {},
    async getPlaybackState() {
      return {
        deviceActive: true,
        isPlaying: false,
        deviceRestricted: false,
        deviceName: "Speaker",
      };
    },
    async getAvailableDevices() {
      return [
        {
          id: "speaker-1",
          name: "Speaker",
          type: "Speaker",
          isActive: true,
          isRestricted: false,
          compatible: true,
        },
      ];
    },
    async findUserPlaylistByName(name) {
      const id = state.playlistsByName.get(name);
      return id ? { id, name } : null;
    },
    async createPrivatePlaylist(name) {
      const id = `pl-${state.nextId++}`;
      state.createdPlaylists.push({ name, id });
      state.playlistsByName.set(name, id);
      return { id, uri: `spotify:playlist:${id}` };
    },
    async addTracksToPlaylist() {},
    async startPlaylistPlayback(playlistId, deviceId) {
      state.playbackCalls.push({ playlistId, deviceId });
    },
    async transferPlayback() {},
    async deletePlaylist(id) {
      state.deletedPlaylists.push(id);
    },
  } satisfies SpotifyClient & {
    createdPlaylists: { name: string; id: string }[];
    deletedPlaylists: string[];
    playbackCalls: { playlistId: string; deviceId: string }[];
    playlistsByName: Map<string, string>;
  };
}

describe("spotify device compatibility", () => {
  test("marks TV devices incompatible", () => {
    const device = mapSpotifyConnectDevice({
      id: "tv-1",
      name: "Living Room",
      type: "TV",
      is_active: false,
      is_restricted: true,
    });
    expect(device.compatible).toBe(false);
    expect(isSpotifyDeviceRestricted({ type: "TV" })).toBe(true);
  });

  test("sorts active devices first", () => {
    const sorted = sortSpotifyConnectDevices([
      {
        id: "b",
        name: "Bedroom",
        type: "Speaker",
        isActive: false,
        isRestricted: false,
        compatible: true,
      },
      {
        id: "a",
        name: "Active Speaker",
        type: "Speaker",
        isActive: true,
        isRestricted: false,
        compatible: true,
      },
    ] satisfies SpotifyConnectDevice[]);
    expect(sorted[0]?.id).toBe("a");
  });
});

describe("bootstrapSpotifyPlayback", () => {
  let db: Database;

  beforeEach(() => {
    db = testDb();
  });

  test("creates playlist and starts playback on first turn on", async () => {
    const spotify = createMockSpotify();
    const partyId = seedParty(db, { name: "Friday Night" });
    seedTrack(db, partyId, "spotify:track:1");
    seedTrack(db, partyId, "spotify:track:2");

    const result = await bootstrapSpotifyPlayback(db, spotify, partyId);
    expect(result).toEqual({ ok: true, playlistId: "pl-1" });
    expect(spotify.createdPlaylists).toEqual([{ name: "Friday Night", id: "pl-1" }]);
    expect(spotify.playbackCalls).toEqual([{ playlistId: "pl-1", deviceId: "speaker-1" }]);
    const row = db
      .query(`SELECT bootstrap_playlist_id FROM parties WHERE id = ?`)
      .get(partyId) as { bootstrap_playlist_id: string };
    expect(row.bootstrap_playlist_id).toBe("pl-1");
  });

  test("skips when bootstrap playlist already exists with active queue", async () => {
    const spotify = createMockSpotify();
    const partyId = seedParty(db, {
      bootstrapPlaylistId: "existing",
      targetDeviceId: "speaker-1",
    });
    seedTrack(db, partyId, "spotify:track:1", "playing");

    const result = await bootstrapSpotifyPlayback(db, spotify, partyId);
    expect(result).toEqual({ skipped: true });
    expect(spotify.createdPlaylists).toHaveLength(0);
  });

  test("returns device required when target device missing", async () => {
    const spotify = createMockSpotify();
    const partyId = seedParty(db, { targetDeviceId: null });
    seedTrack(db, partyId, "spotify:track:1");

    const result = await bootstrapSpotifyPlayback(db, spotify, partyId);
    expect(result).toMatchObject({ ok: false, code: "DEVICE_REQUIRED" });
  });
});

describe("cleanupBootstrapPlaylist", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run(SCHEMA);
  });

  test("unfollows playlist and clears bootstrap_playlist_id", async () => {
    const spotify = createMockSpotify();
    const partyId = seedParty(db, {
      bootstrapPlaylistId: "pl-old",
      targetDeviceId: "speaker-1",
    });

    await cleanupBootstrapPlaylist(db, spotify, partyId);

    expect(spotify.deletedPlaylists).toEqual(["pl-old"]);
    const row = db
      .query(`SELECT bootstrap_playlist_id FROM parties WHERE id = ?`)
      .get(partyId) as { bootstrap_playlist_id: string | null };
    expect(row.bootstrap_playlist_id).toBeNull();
  });
});
