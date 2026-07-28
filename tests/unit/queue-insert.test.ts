import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  DuplicateQueueItemError,
  insertQueueItem,
} from "../../src/server/services/queue";
import type { Db } from "../../src/server/db/schema";

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
    CREATE UNIQUE INDEX idx_queue_party_active_uri
      ON queue_items(party_id, spotify_uri)
      WHERE status IN ('pending', 'queued', 'playing')
  `);
  return db;
}

const track = {
  partyId: "party-1",
  uri: "spotify:track:abc",
  name: "Wonderwall",
  artistName: "Oasis",
  albumArtUrl: null,
  guestId: "guest-1",
};

describe("insertQueueItem", () => {
  test("rejects duplicate title match inside transaction", () => {
    const db = testDb();
    insertQueueItem(db, track);
    expect(() => insertQueueItem(db, track)).toThrow(DuplicateQueueItemError);
  });

  test("concurrent adds of same URI allow only one insert", async () => {
    const db = testDb();
    const results = await Promise.allSettled([
      Promise.resolve().then(() => insertQueueItem(db, track)),
      Promise.resolve().then(() => insertQueueItem(db, track)),
    ]);

    const successes = results.filter((result) => result.status === "fulfilled");
    const duplicates = results.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof DuplicateQueueItemError,
    );

    expect(successes).toHaveLength(1);
    expect(duplicates).toHaveLength(1);

    const count = db
      .query(`SELECT COUNT(*) as c FROM queue_items WHERE party_id = ?`)
      .get(track.partyId) as { c: number };
    expect(count.c).toBe(1);
  });

  test("dedup blocks re-add after played even when unique index would allow URI", () => {
    const db = testDb();
    const id = insertQueueItem(db, track);
    db.run(
      `UPDATE queue_items SET status = 'played', finished_at = ? WHERE id = ?`,
      [new Date().toISOString(), id],
    );
    expect(() => insertQueueItem(db, track)).toThrow(DuplicateQueueItemError);
  });

  test("dedup blocks Bee Gees title and artist variants", () => {
    const db = testDb();
    insertQueueItem(db, {
      ...track,
      uri: "spotify:track:album",
      name: "Stayin' Alive",
      artistName: "The Bee Gees",
    });
    expect(() =>
      insertQueueItem(db, {
        ...track,
        uri: "spotify:track:compilation",
        name: "Stayin Alive",
        artistName: "Bee Gees",
      }),
    ).toThrow(DuplicateQueueItemError);
  });

  test("dedup blocks same URI with different display name", () => {
    const db = testDb();
    const uri = "spotify:track:5ubvP9oKmxLUVq506fgLhk";
    insertQueueItem(db, {
      ...track,
      uri,
      name: "Stayin Alive",
      artistName: "Bee Gees",
    });
    expect(() =>
      insertQueueItem(db, {
        ...track,
        uri,
        name: 'Stayin\' Alive - From "Saturday Night Fever" Soundtrack',
        artistName: "Bee Gees",
      }),
    ).toThrow(DuplicateQueueItemError);
  });
});
