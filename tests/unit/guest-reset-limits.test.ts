import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  clearGuestBoost,
  resetGuestRateLimits,
} from "../../src/server/services/guests";
import type { Db } from "../../src/server/db/schema";

function testDb(): Db {
  const db = new Database(":memory:") as Db;
  db.run(`
    CREATE TABLE guests (
      id TEXT PRIMARY KEY,
      party_id TEXT NOT NULL,
      session_token TEXT NOT NULL,
      display_name TEXT,
      boost_used INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
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
      added_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER
    )
  `);
  db.run(`
    CREATE TABLE rate_limit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_id TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  return db;
}

describe("clearGuestBoost", () => {
  test("clears boost flags on active songs", () => {
    const db = testDb();
    db.run(
      `INSERT INTO guests (id, party_id, session_token, boost_used, disabled, created_at)
       VALUES ('guest', 'party', 'tok', 1, 0, '2026-01-01T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO queue_items (
        id, party_id, spotify_uri, track_name, artist_name, status,
        is_boosted, boost_position, added_by_guest_id, from_seed, added_at
      ) VALUES (
        'song', 'party', 'uri', 'Boosted Song', 'artist', 'queued',
        1, 1, 'guest', 0, '2026-01-01T00:00:00.000Z'
      )`,
    );

    expect(clearGuestBoost(db, "party", "guest")).toBe(1);

    const song = db
      .query(
        `SELECT status, is_boosted, boost_position FROM queue_items WHERE id = ?`,
      )
      .get("song") as {
      status: string;
      is_boosted: number;
      boost_position: number | null;
    };

    expect(song.is_boosted).toBe(0);
    expect(song.boost_position).toBeNull();
    expect(song.status).toBe("pending");
  });
});

describe("resetGuestRateLimits", () => {
  test("also clears boost state so guests are not stuck", () => {
    const db = testDb();
    db.run(
      `INSERT INTO guests (id, party_id, session_token, boost_used, disabled, created_at)
       VALUES ('guest', 'party', 'tok', 1, 0, '2026-01-01T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO queue_items (
        id, party_id, spotify_uri, track_name, artist_name, status,
        is_boosted, boost_position, added_by_guest_id, from_seed, added_at
      ) VALUES (
        'song', 'party', 'uri', 'Boosted Song', 'artist', 'pending',
        1, 1, 'guest', 0, '2026-01-01T00:00:00.000Z'
      )`,
    );
    db.run(
      `INSERT INTO rate_limit_events (guest_id, action, created_at)
       VALUES ('guest', 'upvote', '2026-01-01T00:00:00.000Z'),
              ('guest', 'boost', '2026-01-01T00:00:00.000Z')`,
    );

    const result = resetGuestRateLimits(db, "party", "guest");
    expect(result).toEqual({ cleared: 2, boostsCleared: 1 });

    const song = db
      .query(`SELECT is_boosted FROM queue_items WHERE id = ?`)
      .get("song") as { is_boosted: number };
    const limits = db
      .query(`SELECT COUNT(*) AS count FROM rate_limit_events WHERE guest_id = ?`)
      .get("guest") as { count: number };

    expect(song.is_boosted).toBe(0);
    expect(limits.count).toBe(0);
  });
});
