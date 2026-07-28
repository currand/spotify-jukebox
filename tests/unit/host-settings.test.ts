import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Config } from "../../src/server/config";
import {
  getDefaultGuestLimits,
  getDefaultRateLimits,
  setDefaultGuestLimits,
  setDefaultRateLimits,
} from "../../src/server/services/host-settings";
import { DEFAULT_RATE_LIMITS, factoryDefaultGuestLimits } from "../../src/shared/types";
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

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    env: "development",
    port: 3000,
    baseUrl: "http://127.0.0.1:5173",
    databasePath: ":memory:",
    spotifyMode: "mock",
    spotifyApiBaseUrl: "https://api.spotify.com/v1",
    spotifyAccountsBaseUrl: "https://accounts.spotify.com",
    spotifyClientId: "mock",
    spotifyClientSecret: "mock",
    spotifyRedirectUri: "http://127.0.0.1:3000/callback",
    encryptionKey: "dev-only-change-me-32-chars-minimum!!",
    hostSetupToken: null,
    hostSetupTokenRequired: false,
    bindHost: "127.0.0.1",
    isProduction: false,
    secureCookies: false,
    spotifyApiBudgetCount: 90,
    spotifyApiBudgetWindowMs: 30_000,
    spotifyDailyWarnCalls: 8000,
    syncFastPoll: false,
    syncEndWindowMs: 7000,
    syncFallbackIntervalMs: 30_000,
    syncIdleIntervalMs: 60_000,
    defaultRateLimits: null,
    ...overrides,
  };
}

describe("getDefaultRateLimits", () => {
  test("returns code defaults when nothing configured", () => {
    const db = testDb();
    expect(getDefaultRateLimits(db, testConfig())).toEqual(DEFAULT_RATE_LIMITS);
  });

  test("returns env override when DB row missing", () => {
    const db = testDb();
    const envLimits = {
      ...DEFAULT_RATE_LIMITS,
      add: { count: 5, windowMs: 10 * 60 * 1000 },
    };
    expect(getDefaultRateLimits(db, testConfig({ defaultRateLimits: envLimits }))).toEqual(
      envLimits,
    );
  });

  test("prefers DB settings over env override", () => {
    const db = testDb();
    const dbLimits = {
      ...DEFAULT_RATE_LIMITS,
      boost: { count: 2, windowMs: 5 * 60 * 1000 },
    };
    setDefaultRateLimits(db, dbLimits);
    const envLimits = {
      ...DEFAULT_RATE_LIMITS,
      add: { count: 9, windowMs: 10 * 60 * 1000 },
    };
    expect(
      getDefaultRateLimits(db, testConfig({ defaultRateLimits: envLimits })),
    ).toEqual(dbLimits);
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
    expect(getDefaultRateLimits(db, testConfig())).toEqual(saved);
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
    expect(getDefaultGuestLimits(db, testConfig())).toEqual(saved);
  });

  test("reads legacy rate-limits-only storage", () => {
    const db = testDb();
    setDefaultRateLimits(db, DEFAULT_RATE_LIMITS);
    expect(getDefaultGuestLimits(db, testConfig())).toEqual({
      rateLimits: DEFAULT_RATE_LIMITS,
      downvoteThreshold: 3,
      boostCap: null,
    });
  });
});
