import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initDb } from "../../src/server/db/schema";
import type { Config } from "../../src/server/config";

const baseConfig: Config = {
  env: "development",
  port: 3000,
  baseUrl: "http://127.0.0.1:3000",
  databasePath: ":memory:",
  spotifyMode: "mock",
  spotifyApiBaseUrl: "http://127.0.0.1:8080/v1",
  spotifyAccountsBaseUrl: "http://127.0.0.1:8080",
  spotifyClientId: "mock-client",
  spotifyClientSecret: "mock-secret",
  spotifyRedirectUri: "http://127.0.0.1:3000/callback",
  encryptionKey: "dev-only-change-me-dev-only-chang",
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
};

describe("initDb migrations", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("renames legacy vetoes table to downvotes", () => {
    tempDir = mkdtempSync(join(tmpdir(), "jukebox-db-"));
    const dbPath = join(tempDir, "legacy.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE vetoes (
        guest_id TEXT NOT NULL,
        queue_item_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (guest_id, queue_item_id)
      );
    `);
    legacy.close();

    initDb({ ...baseConfig, databasePath: dbPath });

    const db = new Database(dbPath);
    const tables = db
      .query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[];
    db.close();

    expect(tables.some((row) => row.name === "downvotes")).toBe(true);
    expect(tables.some((row) => row.name === "vetoes")).toBe(false);
  });
});
