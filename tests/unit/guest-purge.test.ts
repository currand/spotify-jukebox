import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  clearPartyGuests,
  purgeStalePartyGuests,
  STALE_GUEST_MAX_AGE_MS,
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
      veto_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
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
  db.run(`
    CREATE TABLE votes (
      guest_id TEXT NOT NULL,
      queue_item_id TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE vetoes (
      guest_id TEXT NOT NULL,
      queue_item_id TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE rate_limit_events (
      guest_id TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  return db;
}

describe("purgeStalePartyGuests", () => {
  test("removes inactive guests with no songs", () => {
    const db = testDb();
    const old = new Date(Date.now() - STALE_GUEST_MAX_AGE_MS - 60_000).toISOString();
    db.run(
      `INSERT INTO guests (id, party_id, session_token, display_name, boost_used, disabled, created_at, last_seen_at)
       VALUES ('g1', 'party-1', 'tok1', 'Alice', 0, 0, ?, ?)`,
      [old, old],
    );
    db.run(
      `INSERT INTO guests (id, party_id, session_token, display_name, boost_used, disabled, created_at, last_seen_at)
       VALUES ('g2', 'party-1', 'tok2', 'Bob', 0, 0, datetime('now'), datetime('now'))`,
    );

    expect(purgeStalePartyGuests(db, "party-1")).toBe(1);
    const remaining = db
      .query(`SELECT id FROM guests WHERE party_id = 'party-1'`)
      .all() as { id: string }[];
    expect(remaining.map((row) => row.id)).toEqual(["g2"]);
  });

  test("keeps stale guests who added songs", () => {
    const db = testDb();
    const old = new Date(Date.now() - STALE_GUEST_MAX_AGE_MS - 60_000).toISOString();
    db.run(
      `INSERT INTO guests (id, party_id, session_token, display_name, boost_used, disabled, created_at, last_seen_at)
       VALUES ('g1', 'party-1', 'tok1', 'Alice', 0, 0, ?, ?)`,
      [old, old],
    );
    db.run(
      `INSERT INTO queue_items (
        id, party_id, spotify_uri, track_name, artist_name, status,
        added_by_guest_id, from_seed, added_at
      ) VALUES ('q1', 'party-1', 'spotify:track:1', 'Song', 'Artist', 'played', 'g1', 0, ?)`,
      [old],
    );

    expect(purgeStalePartyGuests(db, "party-1")).toBe(0);
  });

  test("clearPartyGuests removes all guests", () => {
    const db = testDb();
    db.run(
      `INSERT INTO guests (id, party_id, session_token, display_name, boost_used, disabled, created_at)
       VALUES ('g1', 'party-1', 'tok1', 'Alice', 0, 0, datetime('now'))`,
    );
    expect(clearPartyGuests(db, "party-1")).toBe(1);
    expect(
      (db.query(`SELECT COUNT(*) AS count FROM guests`).get() as { count: number }).count,
    ).toBe(0);
  });
});
