import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  getDefaultGuestLimits,
  getDefaultRateLimits,
  setDefaultGuestLimits,
  setDefaultRateLimits,
} from "../../src/server/services/host-settings";
import {
  DEFAULT_BOOST_CAP,
  DEFAULT_DOWNVOTE_THRESHOLD,
  DEFAULT_RATE_LIMITS,
  factoryDefaultGuestLimits,
} from "../../src/shared/types";
import type { Db } from "../../src/server/db/schema";

function testDb(): Db {
  const db = new Database(":memory:") as Db;
  db.run(`
    CREATE TABLE host_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return db;
}

describe("getDefaultRateLimits", () => {
  test("returns code defaults when nothing configured", () => {
    const db = testDb();
    expect(getDefaultRateLimits(db)).toEqual(DEFAULT_RATE_LIMITS);
  });

  test("prefers DB settings over code defaults", () => {
    const db = testDb();
    const dbLimits = {
      ...DEFAULT_RATE_LIMITS,
      boost: { count: 4, windowMs: 5 * 60 * 1000 },
    };
    setDefaultRateLimits(db, dbLimits);
    expect(getDefaultRateLimits(db)).toEqual(dbLimits);
  });
});

describe("setDefaultRateLimits", () => {
  test("persists and normalizes saved defaults", () => {
    const db = testDb();
    const partial = {
      add: { count: 4, windowMs: 15 * 60 * 1000 },
    } as typeof DEFAULT_RATE_LIMITS;
    const saved = setDefaultRateLimits(db, partial);
    expect(saved.add).toEqual({ count: 4, windowMs: 15 * 60 * 1000 });
    expect(saved.upvote).toEqual(DEFAULT_RATE_LIMITS.upvote);
    expect(getDefaultRateLimits(db)).toEqual(saved);
  });
});

describe("setDefaultGuestLimits", () => {
  test("persists downvote threshold and boost cap with rate limits", () => {
    const db = testDb();
    const saved = setDefaultGuestLimits(db, {
      rateLimits: DEFAULT_RATE_LIMITS,
      downvoteThreshold: 5,
      boostCap: 2,
    });
    expect(getDefaultGuestLimits(db)).toEqual(saved);
  });

  test("reads legacy rate-limits-only storage", () => {
    const db = testDb();
    setDefaultRateLimits(db, DEFAULT_RATE_LIMITS);
    expect(getDefaultGuestLimits(db)).toEqual({
      rateLimits: DEFAULT_RATE_LIMITS,
      downvoteThreshold: DEFAULT_DOWNVOTE_THRESHOLD,
      boostCap: DEFAULT_BOOST_CAP,
    });
  });
});

describe("factoryDefaultGuestLimits", () => {
  test("matches shipped party defaults", () => {
    expect(factoryDefaultGuestLimits()).toEqual({
      rateLimits: DEFAULT_RATE_LIMITS,
      downvoteThreshold: 5,
      boostCap: 8,
    });
  });
});
