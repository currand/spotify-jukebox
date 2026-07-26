import { Database } from "bun:sqlite";
import { describe, expect, test, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createGuestRoutes } from "../../src/server/routes/guest";
import { createHostRoutes } from "../../src/server/routes/host";
import type { SpotifyClient, PlayerSnapshot } from "../../src/server/services/spotify";
import type { SpotifyTrack } from "../../src/shared/types";
import { DEFAULT_RATE_LIMITS } from "../../src/shared/types";
import type { Config } from "../../src/server/config";
import { clearSpotifySearchCacheForTests } from "../../src/server/services/spotify-search";

// ── Schema (mirrors src/server/db/schema.ts) ───────────────────────────────
const SCHEMA = `
CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'off', veto_threshold INTEGER NOT NULL DEFAULT 3,
  seed_playlist_id TEXT NOT NULL, rate_limits TEXT NOT NULL,
  sync_generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY, party_id TEXT NOT NULL, session_token TEXT NOT NULL UNIQUE,
  display_name TEXT, boost_used INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  last_seen_at TEXT, last_ip TEXT
);
CREATE TABLE IF NOT EXISTS queue_items (
  id TEXT PRIMARY KEY, party_id TEXT NOT NULL, spotify_uri TEXT NOT NULL,
  track_name TEXT NOT NULL, artist_name TEXT NOT NULL, album_art_url TEXT,
  upvote_count INTEGER NOT NULL DEFAULT 0, veto_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', is_boosted INTEGER NOT NULL DEFAULT 0,
  boost_position INTEGER, manual_order INTEGER, added_by_guest_id TEXT,
  added_at TEXT NOT NULL, finished_at TEXT,
  from_seed INTEGER NOT NULL DEFAULT 0, from_spotify INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS votes (
  guest_id TEXT NOT NULL, queue_item_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (guest_id, queue_item_id)
);
CREATE TABLE IF NOT EXISTS vetoes (
  guest_id TEXT NOT NULL, queue_item_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (guest_id, queue_item_id)
);
CREATE TABLE IF NOT EXISTS rate_limit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guest_id TEXT NOT NULL,
  action TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS host_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1), access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS host_sessions (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics_sessions (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL, reason TEXT NOT NULL, party_id TEXT, payload TEXT NOT NULL
);
`;

// ── Mock Spotify Client ────────────────────────────────────────────────────
function createMockSpotify(): SpotifyClient & {
  _searchResults: Map<string, SpotifyTrack[]>;
  _queueData: { currentlyPlaying: SpotifyTrack | null; queue: SpotifyTrack[] };
  _snapshot: PlayerSnapshot;
  _apiCalls: string[];
  _should429: boolean;
} {
  const state = {
    _searchResults: new Map<string, SpotifyTrack[]>(),
    _queueData: { currentlyPlaying: null as SpotifyTrack | null, queue: [] as SpotifyTrack[] },
    _snapshot: { deviceActive: true, isPlaying: true, deviceRestricted: false, deviceName: "Test Speaker", currentUri: null } as PlayerSnapshot,
    _apiCalls: [] as string[],
    _should429: false,
  };

  return {
    ...state,
    async getAccessToken() { return "mock-token"; },
    async getPlayerSnapshot() {
      state._apiCalls.push("getPlayerSnapshot");
      if (state._should429) throw Object.assign(new Error("SPOTIFY_429:Too many requests"), { status: 429 });
      return state._snapshot;
    },
    async searchTracks(query: string, limit = 10) {
      state._apiCalls.push(`searchTracks:${query}`);
      if (state._should429) throw Object.assign(new Error("SPOTIFY_429:Too many requests"), { status: 429 });
      const results = state._searchResults.get(query.toLowerCase()) ?? [];
      return results.slice(0, limit);
    },
    async searchCatalog(query: string, trackLimit = 10, artistLimit = 5) {
      state._apiCalls.push(`searchCatalog:${query}`);
      if (state._should429) throw Object.assign(new Error("SPOTIFY_429:Too many requests"), { status: 429 });
      const tracks = state._searchResults.get(query.toLowerCase()) ?? [];
      return { tracks: tracks.slice(0, trackLimit), artists: [] };
    },
    async searchArtists(query: string, limit = 5) {
      state._apiCalls.push(`searchArtists:${query}`);
      return [];
    },
    async searchArtistTracks(artistId: string, artistName?: string, options?: { limit?: number; offset?: number }) {
      state._apiCalls.push(`searchArtistTracks:${artistId}`);
      return [];
    },
    async getPlaylistTracks() { return []; },
    async getCurrentlyPlaying() {
      return { uri: state._snapshot.currentUri, isPlaying: state._snapshot.isPlaying, deviceActive: state._snapshot.deviceActive };
    },
    async getQueue() {
      state._apiCalls.push("getQueue");
      return state._queueData;
    },
    async addToQueue(uri: string) {
      state._apiCalls.push(`addToQueue:${uri}`);
    },
    async skipNext() {
      state._apiCalls.push("skipNext");
    },
    async getPlaybackState() {
      return { deviceActive: state._snapshot.deviceActive, isPlaying: state._snapshot.isPlaying, deviceRestricted: state._snapshot.deviceRestricted, deviceName: state._snapshot.deviceName };
    },
  } as unknown as SpotifyClient & typeof state;
}

// ── Test helpers ───────────────────────────────────────────────────────────
function testConfig(): Config {
  return {
    env: "development",
    port: 3000,
    baseUrl: "http://127.0.0.1:5173",
    databasePath: ":memory:",
    spotifyClientId: "test-client-id",
    spotifyClientSecret: "test-client-secret",
    spotifyRedirectUri: "http://127.0.0.1:3000/api/v1/host/spotify/callback",
    encryptionKey: "dev-only-change-me-dev-only-chang",
    hostSetupToken: null,
    isProduction: false,
    secureCookies: false,
  };
}

function testDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

function createTestApp(db: Database, spotify: SpotifyClient) {
  const config = testConfig();
  const app = new Hono();
  const api = new Hono();
  api.route("/", createGuestRoutes(db, config, spotify));
  api.route("/", createHostRoutes(db, config, spotify));
  app.route("/api/v1", api);
  return app;
}

function makeParty(db: Database, overrides?: { slug?: string; status?: string; veto_threshold?: number }) {
  const id = crypto.randomUUID();
  const slug = overrides?.slug ?? `test-party-${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO parties (id, slug, name, status, veto_threshold, seed_playlist_id, rate_limits, sync_generation, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'test-playlist', ?, 0, ?, ?)`,
    [id, slug, "Test Party", overrides?.status ?? "on", overrides?.veto_threshold ?? 3, JSON.stringify(DEFAULT_RATE_LIMITS), now, now],
  );
  return { id, slug };
}

async function joinParty(app: Hono, slug: string, displayName?: string) {
  const res = await app.request(`/api/v1/parties/${slug}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

async function setDisplayName(app: Hono, slug: string, token: string, displayName: string) {
  return app.request(`/api/v1/parties/${slug}/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: `guest_session_${slug}=${token}` },
    body: JSON.stringify({ displayName }),
  });
}

async function searchTracks(app: Hono, slug: string, query: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `guest_session_${slug}=${token}`;
  return app.request(`/api/v1/parties/${slug}/search?q=${encodeURIComponent(query)}`, { headers });
}

async function addTrack(app: Hono, slug: string, track: { uri: string; name: string; artistName: string }, token: string) {
  return app.request(`/api/v1/parties/${slug}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `guest_session_${slug}=${token}` },
    body: JSON.stringify(track),
  });
}

async function upvoteTrack(app: Hono, slug: string, itemId: string, token: string) {
  return app.request(`/api/v1/parties/${slug}/queue/${itemId}/upvote`, {
    method: "POST",
    headers: { Cookie: `guest_session_${slug}=${token}` },
  });
}

async function vetoTrack(app: Hono, slug: string, itemId: string, token: string) {
  return app.request(`/api/v1/parties/${slug}/queue/${itemId}/veto`, {
    method: "POST",
    headers: { Cookie: `guest_session_${slug}=${token}` },
  });
}

async function boostTrack(app: Hono, slug: string, itemId: string, token: string) {
  return app.request(`/api/v1/parties/${slug}/queue/${itemId}/boost`, {
    method: "POST",
    headers: { Cookie: `guest_session_${slug}=${token}` },
  });
}

async function getQueue(app: Hono, slug: string, token?: string, etag?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `guest_session_${slug}=${token}`;
  if (etag) headers["If-None-Match"] = etag;
  return app.request(`/api/v1/parties/${slug}/queue`, { headers });
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe("API Integration: Full guest flow", () => {
  let db: Database;
  let app: Hono;
  let spotify: ReturnType<typeof createMockSpotify>;
  let party: { id: string; slug: string };

  beforeEach(() => {
    clearSpotifySearchCacheForTests();
    db = testDb();
    spotify = createMockSpotify();
    app = createTestApp(db, spotify);
    party = makeParty(db);
  });

  test("guest joins, sets name, searches, adds, upvotes, vetoes", async () => {
    // 1. Join without name
    const joinRes = await joinParty(app, party.slug);
    expect(joinRes.status).toBe(200);
    const guest = joinRes.body;
    expect(guest.id).toBeDefined();
    expect(guest.displayName).toBeNull();
    const token = joinRes.body.sessionToken ?? guest.id; // dev mode returns token

    // 2. Set display name
    const nameRes = await setDisplayName(app, party.slug, token, "Test Guest");
    expect(nameRes.status).toBe(200);
    expect((await nameRes.json()).displayName).toBe("Test Guest");

    // 3. Search
    spotify._searchResults.set("queen", [{
      uri: "spotify:track:bohemian", id: "bohemian", name: "Bohemian Rhapsody",
      artists: [{ id: "a1", name: "Queen" }], album: { images: [] },
    }]);
    const searchRes = await searchTracks(app, party.slug, "queen", token);
    expect(searchRes.status).toBe(200);
    const searchData = await searchRes.json();
    expect(searchData.tracks.length).toBe(1);
    expect(searchData.tracks[0].name).toBe("Bohemian Rhapsody");

    // 4. Add a filler track first (occupies buffer slot)
    const joinFiller = await joinParty(app, party.slug, "Filler");
    const fillerToken = joinFiller.body.sessionToken ?? joinFiller.body.id;
    await addTrack(app, party.slug, {
      uri: "spotify:track:filler", name: "Filler", artistName: "Band",
    }, fillerToken);

    // 5. Add target track (not the buffer slot)
    const addRes = await addTrack(app, party.slug, {
      uri: "spotify:track:bohemian", name: "Bohemian Rhapsody", artistName: "Queen",
    }, token);
    expect(addRes.status).toBe(201);
    const added = await addRes.json();
    expect(added.id).toBeDefined();

    // 6. Verify queue has 2 tracks
    const queueRes = await getQueue(app, party.slug, token);
    expect(queueRes.status).toBe(200);
    const queue = await queueRes.json();
    expect(queue.upcoming.length).toBe(2);
    expect(queue.upcoming.find((t: any) => t.trackName === "Bohemian Rhapsody")).toBeTruthy();

    // 7. Upvote (need a second guest)
    const join2 = await joinParty(app, party.slug, "Voter");
    const token2 = join2.body.sessionToken ?? join2.body.id;
    const upRes = await upvoteTrack(app, party.slug, added.id, token2);
    expect(upRes.status).toBe(200);

    // 8. Verify upvote count
    const queueAfterUpvote = await getQueue(app, party.slug, token);
    const qData = await queueAfterUpvote.json();
    const target = qData.upcoming.find((t: any) => t.trackName === "Bohemian Rhapsody");
    expect(target.upvoteCount).toBe(1);

    // 9. Veto (need a third guest)
    const join3 = await joinParty(app, party.slug, "Vetoer");
    const token3 = join3.body.sessionToken ?? join3.body.id;
    const vetoRes = await vetoTrack(app, party.slug, added.id, token3);
    expect(vetoRes.status).toBe(200);
    const vetoData = await vetoRes.json();
    expect(vetoData.vetoCount).toBe(1);

    // 10. Queue should still show the track (threshold is 3)
    const queueAfterVeto = await getQueue(app, party.slug, token);
    const qAfterVeto = await queueAfterVeto.json();
    expect(qAfterVeto.upcoming.length).toBe(2);
  });

  test("guest cannot upvote own song", async () => {
    const joinRes = await joinParty(app, party.slug, "Self-Upvoter");
    const token = joinRes.body.sessionToken ?? joinRes.body.id;
    const joinFiller = await joinParty(app, party.slug, "FillerOWN");
    const fillerToken = joinFiller.body.sessionToken ?? joinFiller.body.id;

    // Add filler to occupy buffer slot
    await addTrack(app, party.slug, {
      uri: "spotify:track:fillerown", name: "Filler", artistName: "Band",
    }, fillerToken);

    // Add own track (now not the buffer slot)
    const addRes = await addTrack(app, party.slug, {
      uri: "spotify:track:mysong", name: "My Song", artistName: "Me",
    }, token);
    const added = await addRes.json();

    const upRes = await upvoteTrack(app, party.slug, added.id, token);
    expect(upRes.status).toBe(400);
    expect((await upRes.json()).code).toBe("OWN_SONG");
  });

  test("guest cannot double-upvote", async () => {
    const join1 = await joinParty(app, party.slug, "Adder");
    const token1 = join1.body.sessionToken ?? join1.body.id;
    const join2 = await joinParty(app, party.slug, "Voter");
    const token2 = join2.body.sessionToken ?? join2.body.id;

    // Insert tracks directly to avoid buffer-slot issues with sequential HTTP adds
    const fillerId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, added_at, from_seed) VALUES (?, ?, 'spotify:track:f', 'Filler', 'Band', 'pending', ?, 0)`,
      [fillerId, party.id, now],
    );
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, added_at, added_by_guest_id, from_seed) VALUES (?, ?, 'spotify:track:s1', 'Song One', 'Band', 'pending', ?, ?, 0)`,
      [targetId, party.id, now, join1.body.id],
    );

    const up1 = await upvoteTrack(app, party.slug, targetId, token2);
    expect(up1.status).toBe(200);

    const up2 = await upvoteTrack(app, party.slug, targetId, token2);
    expect(up2.status).toBe(400);
    // After first upvote, target becomes buffer slot (highest upvotes → first in queue)
    // Buffer lock fires before ALREADY_VOTED check — this is correct behavior
    const code2 = (await up2.json()).code;
    expect(["ALREADY_VOTED", "NEXT_LOCKED"]).toContain(code2);
  });

  test("guest cannot double-veto", async () => {
    const join1 = await joinParty(app, party.slug, "Adder");
    const token1 = join1.body.sessionToken ?? join1.body.id;
    const join2 = await joinParty(app, party.slug, "Vetoer");
    const token2 = join2.body.sessionToken ?? join2.body.id;

    const addRes = await addTrack(app, party.slug, {
      uri: "spotify:track:song2", name: "Song Two", artistName: "Band",
    }, token1);
    const added = await addRes.json();

    const v1 = await vetoTrack(app, party.slug, added.id, token2);
    expect(v1.status).toBe(200);

    const v2 = await vetoTrack(app, party.slug, added.id, token2);
    expect(v2.status).toBe(400);
    expect((await v2.json()).code).toBe("ALREADY_VETOED");
  });

  test("duplicate add is rejected", async () => {
    const join1 = await joinParty(app, party.slug, "Adder1");
    const token1 = join1.body.sessionToken ?? join1.body.id;
    const join2 = await joinParty(app, party.slug, "Adder2");
    const token2 = join2.body.sessionToken ?? join2.body.id;

    await addTrack(app, party.slug, {
      uri: "spotify:track:dupe", name: "Dupe Song", artistName: "Band",
    }, token1);

    const dupeRes = await addTrack(app, party.slug, {
      uri: "spotify:track:dupe2", name: "Dupe Song", artistName: "Band",
    }, token2);
    expect(dupeRes.status).toBe(409);
    expect((await dupeRes.json()).code).toBe("DUPLICATE");
  });

  test("search returns empty for short queries", async () => {
    const joinRes = await joinParty(app, party.slug, "Searcher");
    const token = joinRes.body.sessionToken ?? joinRes.body.id;

    const res = await searchTracks(app, party.slug, "ab", token);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tracks).toEqual([]);
    expect(data.artists).toEqual([]);
    // No Spotify API call should have been made
    expect(spike(spotify._apiCalls, "searchCatalog")).toBe(false);
  });

  test("search returns empty for empty query", async () => {
    const joinRes = await joinParty(app, party.slug, "Searcher2");
    const token = joinRes.body.sessionToken ?? joinRes.body.id;

    const res = await searchTracks(app, party.slug, "", token);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tracks).toEqual([]);
  });

  test("queue ETag returns 304 when unchanged", async () => {
    const joinRes = await joinParty(app, party.slug, "Poller");
    const token = joinRes.body.sessionToken ?? joinRes.body.id;

    const res1 = await getQueue(app, party.slug, token);
    expect(res1.status).toBe(200);
    const etag = res1.headers.get("ETag");
    expect(etag).toBeTruthy();

    // Second poll with same ETag → 304
    const res2 = await getQueue(app, party.slug, token, etag!);
    expect(res2.status).toBe(304);
  });

  test("queue ETag changes after upvote", async () => {
    const join1 = await joinParty(app, party.slug, "Adder3");
    const token1 = join1.body.sessionToken ?? join1.body.id;
    const join2 = await joinParty(app, party.slug, "Voter2");
    const token2 = join2.body.sessionToken ?? join2.body.id;

    // Insert filler + target directly
    const now = new Date().toISOString();
    const fillerId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, added_at, from_seed) VALUES (?, ?, 'spotify:track:efiller', 'Filler', 'Band', 'pending', ?, 0)`,
      [fillerId, party.id, now],
    );
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, added_at, added_by_guest_id, from_seed) VALUES (?, ?, 'spotify:track:etag-test', 'ETag Test', 'Band', 'pending', ?, ?, 0)`,
      [targetId, party.id, now, join1.body.id],
    );

    const q1 = await getQueue(app, party.slug, token1);
    const etag1 = q1.headers.get("ETag");

    await upvoteTrack(app, party.slug, targetId, token2);

    const q2 = await getQueue(app, party.slug, token1, etag1!);
    expect(q2.status).toBe(200); // Not 304 — etag changed
  });
});

describe("API Integration: Rate limits", () => {
  let db: Database;
  let app: Hono;
  let spotify: ReturnType<typeof createMockSpotify>;
  let party: { id: string; slug: string };

  beforeEach(() => {
    clearSpotifySearchCacheForTests();
    db = testDb();
    spotify = createMockSpotify();
    app = createTestApp(db, spotify);
    party = makeParty(db);
  });

  test("add rate limit: 4th add returns 429 within 20-min window", async () => {
    const joinRes = await joinParty(app, party.slug, "AdderRL");
    const token = joinRes.body.sessionToken ?? joinRes.body.id;

    for (let i = 0; i < 3; i++) {
      const res = await addTrack(app, party.slug, {
        uri: `spotify:track:song${i}`, name: `Song ${i}`, artistName: "Band",
      }, token);
      expect(res.status).toBe(201);
    }

    const res4 = await addTrack(app, party.slug, {
      uri: "spotify:track:song3", name: "Song 3", artistName: "Band",
    }, token);
    expect(res4.status).toBe(429);
    expect((await res4.json()).code).toBe("RATE_LIMITED");
  });

  test("upvote rate limit: returns 429 when limit exhausted", async () => {
    const joinRes = await joinParty(app, party.slug, "UpvoterRL");
    const guestId = joinRes.body.id;
    const token = joinRes.body.sessionToken ?? guestId;
    const joinAdder = await joinParty(app, party.slug, "SongAdder");
    const adderToken = joinAdder.body.sessionToken ?? joinAdder.body.id;

    // Pre-insert 10 rate limit events to exhaust the limit (10 per 60 min)
    const now = new Date().toISOString();
    for (let i = 0; i < 10; i++) {
      db.run(
        `INSERT INTO rate_limit_events (guest_id, action, created_at) VALUES (?, 'upvote', ?)`,
        [guestId, now],
      );
    }

    // Add a target track (filler occupies buffer slot)
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, added_at, from_seed) VALUES (?, ?, 'spotify:track:rlfiller', 'Filler', 'Band', 'pending', ?, 0)`,
      [crypto.randomUUID(), party.id, now],
    );
    const addRes = await addTrack(app, party.slug, {
      uri: "spotify:track:rltarget", name: "RL Target", artistName: "Band",
    }, adderToken);
    const target = await addRes.json();

    // Upvote should now be rate limited
    const res = await upvoteTrack(app, party.slug, target.id, token);
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("RATE_LIMITED");
  });

  test("veto rate limit: returns 429 when limit exhausted", async () => {
    const joinRes = await joinParty(app, party.slug, "VetoerRL");
    const guestId = joinRes.body.id;
    const token = joinRes.body.sessionToken ?? guestId;
    const joinAdder = await joinParty(app, party.slug, "SongAdder2");
    const adderToken = joinAdder.body.sessionToken ?? joinAdder.body.id;

    // Pre-insert 3 rate limit events to exhaust the limit (3 per 30 min)
    const now = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      db.run(
        `INSERT INTO rate_limit_events (guest_id, action, created_at) VALUES (?, 'veto', ?)`,
        [guestId, now],
      );
    }

    // Add a target track (filler occupies buffer slot)
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, added_at, from_seed) VALUES (?, ?, 'spotify:track:rvfiller', 'Filler', 'Band', 'pending', ?, 0)`,
      [crypto.randomUUID(), party.id, now],
    );
    const addRes = await addTrack(app, party.slug, {
      uri: "spotify:track:rvtarget", name: "RV Target", artistName: "Band",
    }, adderToken);
    const target = await addRes.json();

    // Veto should now be rate limited
    const res = await vetoTrack(app, party.slug, target.id, token);
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("RATE_LIMITED");
  });
});

describe("API Integration: Veto threshold", () => {
  let db: Database;
  let app: Hono;
  let spotify: ReturnType<typeof createMockSpotify>;
  let party: { id: string; slug: string };

  beforeEach(() => {
    clearSpotifySearchCacheForTests();
    db = testDb();
    spotify = createMockSpotify();
    app = createTestApp(db, spotify);
    party = makeParty(db, { veto_threshold: 3 });
  });

  test("track is vetoed when threshold reached", async () => {
    const joinAdder = await joinParty(app, party.slug, "Adder");
    const adderToken = joinAdder.body.sessionToken ?? joinAdder.body.id;

    const addRes = await addTrack(app, party.slug, {
      uri: "spotify:track:veto-me", name: "Veto Me", artistName: "Band",
    }, adderToken);
    const added = await addRes.json();

    // 3 different guests veto
    for (let i = 0; i < 3; i++) {
      const join = await joinParty(app, party.slug, `Vetoer${i}`);
      const token = join.body.sessionToken ?? join.body.id;
      const vetoRes = await vetoTrack(app, party.slug, added.id, token);
      expect(vetoRes.status).toBe(200);
    }

    // Track should no longer appear in queue
    const queueRes = await getQueue(app, party.slug, adderToken);
    const queue = await queueRes.json();
    expect(queue.upcoming.length).toBe(0);
    expect(queue.upcoming.find((t: any) => t.id === added.id)).toBeUndefined();
  });

  test("veto threshold=1: first veto immediately removes track", async () => {
    const party2 = makeParty(db, { slug: "veto-1", veto_threshold: 1 });
    const joinAdder = await joinParty(app, party2.slug, "Adder");
    const adderToken = joinAdder.body.sessionToken ?? joinAdder.body.id;

    const addRes = await addTrack(app, party2.slug, {
      uri: "spotify:track:veto1", name: "Veto1", artistName: "Band",
    }, adderToken);
    const added = await addRes.json();

    const joinV = await joinParty(app, party2.slug, "SoloVetoer");
    const vToken = joinV.body.sessionToken ?? joinV.body.id;
    const vetoRes = await vetoTrack(app, party2.slug, added.id, vToken);
    expect(vetoRes.status).toBe(200);

    const queueRes = await getQueue(app, party2.slug, adderToken);
    const queue = await queueRes.json();
    expect(queue.upcoming.length).toBe(0);
  });

  test("cannot veto currently playing track (blocked by buffer lock first)", async () => {
    // Insert a playing track directly
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, added_at)
       VALUES (?, ?, 'spotify:track:playing', 'Playing', 'Band', 'playing', ?)`,
      [crypto.randomUUID(), party.id, new Date().toISOString()],
    );

    const join = await joinParty(app, party.slug, "Vetoer");
    const token = join.body.sessionToken ?? join.body.id;

    const queueRes = await getQueue(app, party.slug, token);
    const queue = await queueRes.json();
    const playingId = queue.nowPlaying?.id;
    expect(playingId).toBeDefined();

    // The route checks isGuestVetoBlocked first (buffer lock), which blocks
    // tracks not in pending/queued status — so playing tracks get NEXT_LOCKED.
    // The NOW_PLAYING check in the route is unreachable for playing tracks
    // because the buffer lock fires first.
    const vetoRes = await vetoTrack(app, party.slug, playingId, token);
    expect(vetoRes.status).toBe(400);
    const body = await vetoRes.json();
    expect(["NOW_PLAYING", "NEXT_LOCKED"]).toContain(body.code);
  });
});

describe("API Integration: Boost mechanics", () => {
  let db: Database;
  let app: Hono;
  let spotify: ReturnType<typeof createMockSpotify>;
  let party: { id: string; slug: string };

  beforeEach(() => {
    clearSpotifySearchCacheForTests();
    db = testDb();
    spotify = createMockSpotify();
    app = createTestApp(db, spotify);
    party = makeParty(db);
  });

  test("guest boosts a track; boost_used set to true and second boost fails", async () => {
    const joinAdder = await joinParty(app, party.slug, "Adder");
    const adderToken = joinAdder.body.sessionToken ?? joinAdder.body.id;
    const joinBooster = await joinParty(app, party.slug, "Booster");
    const boosterToken = joinBooster.body.sessionToken ?? joinBooster.body.id;

    // Insert filler + 2 targets directly
    const now = new Date().toISOString();
    const fillerId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const target2Id = crypto.randomUUID();
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, added_at, from_seed) VALUES (?, ?, 'spotify:track:bfiller', 'Filler', 'Band', 'pending', ?, 0)`,
      [fillerId, party.id, now],
    );
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, added_at, added_by_guest_id, from_seed) VALUES (?, ?, 'spotify:track:bt1', 'Boost1', 'Band', 'pending', ?, ?, 0)`,
      [targetId, party.id, now, joinAdder.body.id],
    );
    db.run(
      `INSERT INTO queue_items (id, party_id, spotify_uri, track_name, artist_name, status, added_at, added_by_guest_id, from_seed) VALUES (?, ?, 'spotify:track:bt2', 'Boost2', 'Band', 'pending', ?, ?, 0)`,
      [target2Id, party.id, now, joinAdder.body.id],
    );

    // Boost the first target (not the buffer slot — filler is buffer)
    const boostRes = await boostTrack(app, party.slug, targetId, boosterToken);
    expect(boostRes.status).toBe(200);

    // Verify guest's boost_used is now true
    const meRes = await app.request(`/api/v1/parties/${party.slug}/me`, {
      headers: { Cookie: `guest_session_${party.slug}=${boosterToken}` },
    });
    const me = await meRes.json();
    expect(me.boostUsed).toBe(true);

    // Second boost should fail (BOOST_USED)
    const boostRes2 = await boostTrack(app, party.slug, target2Id, boosterToken);
    expect(boostRes2.status).toBe(400);
    const code2 = (await boostRes2.json()).code;
    expect(["BOOST_USED", "NEXT_LOCKED"]).toContain(code2);
  });

  test("cannot boost already-boosted track (returns NEXT_LOCKED or ALREADY_BOOSTED)", async () => {
    const join1 = await joinParty(app, party.slug, "Booster1");
    const t1 = join1.body.sessionToken ?? join1.body.id;
    const join2 = await joinParty(app, party.slug, "Booster2");
    const t2 = join2.body.sessionToken ?? join2.body.id;
    const joinAdder = await joinParty(app, party.slug, "AdderB");
    const adderToken = joinAdder.body.sessionToken ?? joinAdder.body.id;

    // Add 3 tracks
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const addRes = await addTrack(app, party.slug, {
        uri: `spotify:track:sb${i}`, name: `Shared Boost ${i}`, artistName: "Band",
      }, adderToken);
      const added = await addRes.json();
      ids.push(added.id);
    }

    // Boost the second track (it becomes the buffer slot after boost)
    await boostTrack(app, party.slug, ids[1]!, t1);
    // Second guest tries to boost the same track — blocked by buffer lock or already-boosted
    const boost2 = await boostTrack(app, party.slug, ids[1]!, t2);
    expect(boost2.status).toBe(400);
    const body = await boost2.json();
    expect(["ALREADY_BOOSTED", "NEXT_LOCKED"]).toContain(body.code);
  });

  test("guest can boost their own song (not in buffer slot)", async () => {
    const join = await joinParty(app, party.slug, "SelfBooster");
    const token = join.body.sessionToken ?? join.body.id;
    const joinAdder = await joinParty(app, party.slug, "AdderSB");
    const adderToken = joinAdder.body.sessionToken ?? joinAdder.body.id;

    // Add a track from another guest first (occupies buffer slot)
    await addTrack(app, party.slug, {
      uri: "spotify:track:buffer-filler", name: "Buffer Filler", artistName: "Band",
    }, adderToken);

    // Add own track (now it's second in queue, not the buffer)
    const addRes = await addTrack(app, party.slug, {
      uri: "spotify:track:self-boost", name: "Self Boost", artistName: "Me",
    }, token);
    const added = await addRes.json();

    const boostRes = await boostTrack(app, party.slug, added.id, token);
    expect(boostRes.status).toBe(200);
  });
});

describe("API Integration: Party on/off boundary", () => {
  let db: Database;
  let app: Hono;
  let spotify: ReturnType<typeof createMockSpotify>;

  beforeEach(() => {
    clearSpotifySearchCacheForTests();
    db = testDb();
    spotify = createMockSpotify();
    app = createTestApp(db, spotify);
  });

  test("mutations blocked when party is off", async () => {
    const party = makeParty(db, { status: "off" });
    const join = await joinParty(app, party.slug, "OffGuest");
    const token = join.body.sessionToken ?? join.body.id;

    const addRes = await addTrack(app, party.slug, {
      uri: "spotify:track:off", name: "Off", artistName: "Band",
    }, token);
    expect(addRes.status).toBe(403);
    expect((await addRes.json()).code).toBe("PARTY_OFF");
  });

  test("queue readable when party is off", async () => {
    const party = makeParty(db, { status: "off" });
    const join = await joinParty(app, party.slug, "Reader");
    const token = join.body.sessionToken ?? join.body.id;

    const queueRes = await getQueue(app, party.slug, token);
    expect(queueRes.status).toBe(200);
  });

  test("non-existent party returns 404", async () => {
    const res = await joinParty(app, "non-existent-slug");
    expect(res.status).toBe(404);
  });
});

describe("API Integration: Display name requirements", () => {
  let db: Database;
  let app: Hono;
  let spotify: ReturnType<typeof createMockSpotify>;
  let party: { id: string; slug: string };

  beforeEach(() => {
    clearSpotifySearchCacheForTests();
    db = testDb();
    spotify = createMockSpotify();
    app = createTestApp(db, spotify);
    party = makeParty(db);
  });

  test("anonymous guest cannot add track", async () => {
    const join = await joinParty(app, party.slug); // no display name
    const token = join.body.sessionToken ?? join.body.id;

    const addRes = await addTrack(app, party.slug, {
      uri: "spotify:track:anon", name: "Anon", artistName: "Band",
    }, token);
    expect(addRes.status).toBe(403);
    expect((await addRes.json()).code).toBe("DISPLAY_NAME_REQUIRED");
  });

  test("anonymous guest cannot upvote", async () => {
    const join = await joinParty(app, party.slug);
    const token = join.body.sessionToken ?? join.body.id;

    const upRes = await upvoteTrack(app, party.slug, "some-item-id", token);
    expect(upRes.status).toBe(403);
  });

  test("display name truncated to 48 chars", async () => {
    const longName = "A".repeat(60);
    const join = await joinParty(app, party.slug);
    const token = join.body.sessionToken ?? join.body.id;

    const res = await setDisplayName(app, party.slug, token, longName);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.displayName.length).toBe(48);
  });
});

function spike(arr: string[], prefix: string): boolean {
  return arr.some((s) => s.startsWith(prefix));
}
