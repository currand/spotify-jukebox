import { Database } from "bun:sqlite";
import { describe, expect, test, beforeEach } from "bun:test";
import { DEFAULT_RATE_LIMITS } from "../../src/shared/types";
import {
  canResumeParty,
  listArchivedParties,
  resumeParty,
  ResumePartyError,
  softArchiveActiveParties,
} from "../../src/server/services/party";
import { getPartyExportTracks, insertQueueItem } from "../../src/server/services/queue";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'off', veto_threshold INTEGER NOT NULL DEFAULT 3,
  boost_cap INTEGER,
  seed_playlist_id TEXT NOT NULL, rate_limits TEXT NOT NULL,
  sync_generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY, party_id TEXT NOT NULL, session_token TEXT NOT NULL UNIQUE,
  display_name TEXT, boost_used INTEGER NOT NULL DEFAULT 0,
  tutorial_seen INTEGER NOT NULL DEFAULT 0,
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
`;

function testDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

function insertParty(
  db: Database,
  overrides?: {
    id?: string;
    slug?: string;
    name?: string;
    status?: string;
    updated_at?: string;
  },
) {
  const id = overrides?.id ?? crypto.randomUUID();
  const now = overrides?.updated_at ?? new Date().toISOString();
  db.run(
    `INSERT INTO parties (id, slug, name, status, veto_threshold, boost_cap, seed_playlist_id, rate_limits, sync_generation, created_at, updated_at)
     VALUES (?, ?, ?, ?, 3, NULL, 'seed', ?, 0, ?, ?)`,
    [
      id,
      overrides?.slug ?? `party-${id.slice(0, 8)}`,
      overrides?.name ?? "Test Party",
      overrides?.status ?? "archived",
      JSON.stringify(DEFAULT_RATE_LIMITS),
      now,
      now,
    ],
  );
  return id;
}

describe("party resume helpers", () => {
  let db: Database;

  beforeEach(() => {
    db = testDb();
  });

  test("canResumeParty is true when active queue items exist", () => {
    const partyId = insertParty(db);
    insertQueueItem(db, {
      partyId,
      uri: "spotify:track:1",
      name: "Song A",
      artistName: "Artist",
      albumArtUrl: null,
      guestId: null,
    });
    expect(canResumeParty(db, partyId)).toBe(true);
  });

  test("canResumeParty is false when all queue items are terminal", () => {
    const partyId = insertParty(db);
    const itemId = insertQueueItem(db, {
      partyId,
      uri: "spotify:track:1",
      name: "Song A",
      artistName: "Artist",
      albumArtUrl: null,
      guestId: null,
    });
    db.run(`UPDATE queue_items SET status = 'played', finished_at = ? WHERE id = ?`, [
      new Date().toISOString(),
      itemId,
    ]);
    expect(canResumeParty(db, partyId)).toBe(false);
  });

  test("listArchivedParties returns parties ordered by archivedAt desc", () => {
    const older = insertParty(db, {
      name: "Older",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const newer = insertParty(db, {
      name: "Newer",
      updated_at: "2026-02-01T00:00:00.000Z",
    });
    insertQueueItem(db, {
      partyId: newer,
      uri: "spotify:track:1",
      name: "Upcoming",
      artistName: "Artist",
      albumArtUrl: null,
      guestId: null,
    });

    const parties = listArchivedParties(db);
    expect(parties.map((p) => p.partyId)).toEqual([newer, older]);
    expect(parties[0]?.canResume).toBe(true);
    expect(parties[1]?.canResume).toBe(false);
  });

  test("resumeParty reactivates archived party and archives current active party", () => {
    const archivedId = insertParty(db, { slug: "old-party", status: "archived" });
    insertQueueItem(db, {
      partyId: archivedId,
      uri: "spotify:track:1",
      name: "Song A",
      artistName: "Artist",
      albumArtUrl: null,
      guestId: null,
    });

    const activeId = insertParty(db, { slug: "current-party", status: "on" });
    insertQueueItem(db, {
      partyId: activeId,
      uri: "spotify:track:2",
      name: "Song B",
      artistName: "Artist",
      albumArtUrl: null,
      guestId: null,
    });

    const resumed = resumeParty(db, archivedId);
    expect(resumed.id).toBe(archivedId);
    expect(resumed.status).toBe("off");
    expect(resumed.slug).toBe("old-party");

    const active = db
      .query(`SELECT status FROM parties WHERE id = ?`)
      .get(activeId) as { status: string };
    expect(active.status).toBe("archived");
    expect(canResumeParty(db, activeId)).toBe(true);
  });

  test("resumeParty rejects fully terminal legacy parties", () => {
    const partyId = insertParty(db);
    const itemId = insertQueueItem(db, {
      partyId,
      uri: "spotify:track:1",
      name: "Song A",
      artistName: "Artist",
      albumArtUrl: null,
      guestId: null,
    });
    db.run(`UPDATE queue_items SET status = 'skipped', finished_at = ? WHERE id = ?`, [
      new Date().toISOString(),
      itemId,
    ]);

    expect(() => resumeParty(db, partyId)).toThrow(ResumePartyError);
    try {
      resumeParty(db, partyId);
    } catch (e) {
      expect(e).toBeInstanceOf(ResumePartyError);
      expect((e as ResumePartyError).code).toBe("RESUME_NOT_AVAILABLE");
    }
  });

  test("getPartyExportTracks appends upcoming items in play order", () => {
    const partyId = insertParty(db);
    const playedId = insertQueueItem(db, {
      partyId,
      uri: "spotify:track:played",
      name: "Played",
      artistName: "Artist",
      albumArtUrl: null,
      guestId: null,
    });
    db.run(`UPDATE queue_items SET status = 'played', finished_at = ? WHERE id = ?`, [
      "2026-01-01T00:00:00.000Z",
      playedId,
    ]);
    insertQueueItem(db, {
      partyId,
      uri: "spotify:track:pending",
      name: "Pending",
      artistName: "Artist",
      albumArtUrl: null,
      guestId: null,
    });

    const tracks = getPartyExportTracks(db, partyId);
    expect(tracks.map((t) => t.uri)).toEqual([
      "spotify:track:played",
      "spotify:track:pending",
    ]);
  });

  test("softArchiveActiveParties preserves queue item statuses", () => {
    const partyId = insertParty(db, { status: "on" });
    const itemId = insertQueueItem(db, {
      partyId,
      uri: "spotify:track:1",
      name: "Song A",
      artistName: "Artist",
      albumArtUrl: null,
      guestId: null,
    });
    db.run(`UPDATE queue_items SET status = 'queued' WHERE id = ?`, [itemId]);

    softArchiveActiveParties(db);

    const party = db
      .query(`SELECT status FROM parties WHERE id = ?`)
      .get(partyId) as { status: string };
    const item = db
      .query(`SELECT status FROM queue_items WHERE id = ?`)
      .get(itemId) as { status: string };
    expect(party.status).toBe("archived");
    expect(item.status).toBe("queued");
  });
});
