import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { getDedupTracks, markFinished } from "../../src/server/services/queue";
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
      added_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER
    )
  `);
  return db;
}

function insertItem(
  db: Db,
  overrides: {
    id: string;
    track_name: string;
    artist_name?: string;
    status: string;
    finished_at?: string | null;
  },
) {
  db.run(
    `INSERT INTO queue_items (
      id, party_id, spotify_uri, track_name, artist_name, status, added_at, finished_at
    ) VALUES (?, 'party', 'uri', ?, ?, ?, '2026-01-01T00:00:00.000Z', ?)`,
    [
      overrides.id,
      overrides.track_name,
      overrides.artist_name ?? "artist",
      overrides.status,
      overrides.finished_at ?? null,
    ],
  );
}

describe("getDedupTracks", () => {
  test("excludes removed songs so they can be re-added", () => {
    const db = testDb();
    insertItem(db, { id: "1", track_name: "Removed Song", status: "skipped", finished_at: "2026-01-02T00:00:00.000Z" });
    insertItem(db, { id: "2", track_name: "Played Song", artist_name: "Band", status: "played", finished_at: "2026-01-03T00:00:00.000Z" });
    insertItem(db, { id: "3", track_name: "Active Song", artist_name: "Band", status: "pending" });

    expect(getDedupTracks(db, "party")).toEqual([
      { trackName: "Active Song", artistName: "Band", durationMs: null },
      { trackName: "Played Song", artistName: "Band", durationMs: null },
    ]);
  });

  test("still blocks re-adding vetoed songs", () => {
    const db = testDb();
    insertItem(db, { id: "1", track_name: "Vetoed Song", artist_name: "Band", status: "vetoed", finished_at: "2026-01-02T00:00:00.000Z" });

    expect(getDedupTracks(db, "party")).toEqual([
      { trackName: "Vetoed Song", artistName: "Band", durationMs: null },
    ]);
  });
});

describe("markFinished", () => {
  test("does not overwrite guest-removed songs with played", () => {
    const db = testDb();
    insertItem(db, {
      id: "1",
      track_name: "Removed Song",
      status: "skipped",
      finished_at: "2026-01-02T00:00:00.000Z",
    });

    markFinished(db, "1", "played");

    const row = db
      .query(`SELECT status FROM queue_items WHERE id = ?`)
      .get("1") as { status: string };
    expect(row.status).toBe("skipped");
  });
});
