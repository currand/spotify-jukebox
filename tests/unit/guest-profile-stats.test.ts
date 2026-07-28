import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { getGuestProfileStats } from "../../src/server/services/guests";
import type { Db } from "../../src/server/db/schema";

function testDb(): Db {
  const db = new Database(":memory:") as Db;
  db.run(`
    CREATE TABLE parties (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      veto_threshold INTEGER NOT NULL,
      rate_limits TEXT NOT NULL,
      sync_generation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE guests (
      id TEXT PRIMARY KEY,
      party_id TEXT NOT NULL,
      session_token TEXT NOT NULL,
      display_name TEXT,
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
      status TEXT NOT NULL,
      added_by_guest_id TEXT,
      from_seed INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE votes (
      guest_id TEXT NOT NULL,
      queue_item_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guest_id, queue_item_id)
    )
  `);
  db.run(`
    CREATE TABLE vetoes (
      guest_id TEXT NOT NULL,
      queue_item_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guest_id, queue_item_id)
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

describe("getGuestProfileStats", () => {
  test("counts votes, vetoes, boosts, and song statuses", () => {
    const db = testDb();
    db.run(
      `INSERT INTO parties (id, slug, name, status, veto_threshold, rate_limits, sync_generation, created_at, updated_at)
       VALUES ('p', 'party', 'Party', 'on', 3, '{}', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO guests (id, party_id, session_token, display_name, created_at)
       VALUES ('g', 'p', 'tok', 'Guest', '2026-01-01T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO queue_items (
         id, party_id, spotify_uri, track_name, artist_name, status, added_by_guest_id, added_at
       ) VALUES
         ('q1', 'p', 'uri:1', 'A', 'Artist', 'playing', 'g', '2026-01-01T00:00:00.000Z'),
         ('q2', 'p', 'uri:2', 'B', 'Artist', 'played', 'g', '2026-01-02T00:00:00.000Z'),
         ('q3', 'p', 'uri:3', 'C', 'Artist', 'skipped', 'g', '2026-01-03T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO votes (guest_id, queue_item_id, created_at) VALUES ('g', 'q1', '2026-01-01T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO votes (guest_id, queue_item_id, created_at) VALUES ('g', 'q2', '2026-01-02T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO vetoes (guest_id, queue_item_id, created_at) VALUES ('g', 'q3', '2026-01-03T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO rate_limit_events (guest_id, action, created_at) VALUES ('g', 'boost', '2026-01-01T00:00:00.000Z')`,
    );

    expect(getGuestProfileStats(db, "p", "g")).toEqual({
      upvotesGiven: 2,
      downvotesGiven: 1,
      boostsGiven: 1,
      songsAdded: 3,
      songsInQueue: 1,
      songsPlayed: 1,
    });
  });
});
