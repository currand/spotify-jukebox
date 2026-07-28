import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Db } from "../../src/server/db/schema";
import { findConflictingNamedGuest } from "../../src/server/services/guests";

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
  return db;
}

function insertGuest(
  db: Db,
  id: string,
  displayName: string,
  lastIp: string | null = "127.0.0.1",
) {
  db.run(
    `INSERT INTO guests (
      id, party_id, session_token, display_name, created_at, last_ip
    ) VALUES (?, 'party', ?, ?, '2026-01-01T00:00:00.000Z', ?)`,
    [id, `token-${id}`, displayName, lastIp],
  );
}

describe("findConflictingNamedGuest", () => {
  test("case-insensitive exact match conflicts", () => {
    const db = testDb();
    insertGuest(db, "g1", "David Curran");
    expect(
      findConflictingNamedGuest(db, "party", "david curran", "g2"),
    ).toEqual(
      expect.objectContaining({
        id: "g1",
        display_name: "David Curran",
        matchKind: "exact",
      }),
    );
  });

  test("similar names are flagged as fuzzy", () => {
    const db = testDb();
    insertGuest(db, "g1", "David Curran");
    expect(
      findConflictingNamedGuest(db, "party", "David Curren", "g2"),
    ).toEqual(
      expect.objectContaining({
        id: "g1",
        display_name: "David Curran",
        matchKind: "fuzzy",
      }),
    );
  });

  test("unrelated names do not conflict", () => {
    const db = testDb();
    insertGuest(db, "g1", "David Curran");
    expect(findConflictingNamedGuest(db, "party", "Alice Smith", "g2")).toBeNull();
  });
});
