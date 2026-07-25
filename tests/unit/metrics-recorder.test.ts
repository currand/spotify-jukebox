import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { Db } from "../../src/server/db/schema";
import { buildHostDiagnostics } from "../../src/server/services/diagnostics";
import {
  getMetricsSnapshot,
  listMetricsSessions,
  listMetricsSnapshots,
  METRICS_SNAPSHOT_INTERVAL_MS,
  resetMetricsRecorderForTests,
  startMetricsRecorder,
} from "../../src/server/services/metrics-recorder";
import {
  clearSpotifyMetricsForTests,
  recordSpotifyApiCall,
  setSpotifyRateLimitListener,
} from "../../src/server/services/spotify-metrics";

function createMetricsDb(): Db {
  const db = new Database(":memory:") as Db;
  db.exec(`
    CREATE TABLE metrics_sessions (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE TABLE metrics_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      party_id TEXT,
      payload TEXT NOT NULL
    );
  `);
  return db;
}

describe("metrics recorder", () => {
  beforeEach(() => {
    resetMetricsRecorderForTests();
    clearSpotifyMetricsForTests();
    setSpotifyRateLimitListener(null);
  });

  afterEach(() => {
    resetMetricsRecorderForTests();
    clearSpotifyMetricsForTests();
    setSpotifyRateLimitListener(null);
  });

  test("creates a session and startup snapshot on app start", () => {
    const db = createMetricsDb();
    startMetricsRecorder(db, () => buildHostDiagnostics(null));

    const sessions = listMetricsSessions(db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.isCurrent).toBe(true);
    expect(sessions[0]?.snapshotCount).toBe(1);

    const snapshots = listMetricsSnapshots(db, sessions[0]!.id);
    expect(snapshots[0]?.reason).toBe("startup");
  });

  test("records rate-limit snapshots when Spotify returns 429", () => {
    const db = createMetricsDb();
    startMetricsRecorder(db, () => buildHostDiagnostics(null));

    recordSpotifyApiCall({ path: "/me/player", status: 429, elapsedMs: 4 });

    const session = listMetricsSessions(db)[0]!;
    const rateLimits = listMetricsSnapshots(db, session.id, {
      reason: "rate_limit",
    });
    expect(rateLimits).toHaveLength(1);

    const payload = getMetricsSnapshot(db, session.id, rateLimits[0]!.id);
    expect(payload?.spotifyApi.rateLimitCount).toBe(1);
  });

  test("closes prior open sessions when a new recorder starts", () => {
    const db = createMetricsDb();
    startMetricsRecorder(db, () => buildHostDiagnostics(null));
    const first = listMetricsSessions(db)[0]!.id;

    resetMetricsRecorderForTests();
    startMetricsRecorder(db, () => buildHostDiagnostics(null));

    const sessions = listMetricsSessions(db);
    expect(sessions).toHaveLength(2);
    const previous = sessions.find((session) => session.id === first);
    expect(previous?.endedAt).not.toBeNull();
    expect(sessions.find((session) => session.isCurrent)?.id).not.toBe(first);
  });

  test("interval snapshots use configured cadence", () => {
    expect(METRICS_SNAPSHOT_INTERVAL_MS).toBe(5000);
  });
});
