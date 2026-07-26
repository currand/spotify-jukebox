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
  summarizeMetricsSnapshotsByMinute,
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
    expect(METRICS_SNAPSHOT_INTERVAL_MS).toBe(10_000);
  });

  test("summarizes interval snapshots into one row per minute", () => {
    const sessionId = "session-a";
    const summarized = summarizeMetricsSnapshotsByMinute([
      {
        id: 3,
        sessionId,
        recordedAt: "2026-01-01T12:00:50.000Z",
        reason: "interval",
        partyId: null,
        rateLimitCount: 0,
        apiCallsTotal: 30,
        apiCallsLast5m: 8,
        syncRetryAfterMs: null,
      },
      {
        id: 2,
        sessionId,
        recordedAt: "2026-01-01T12:00:20.000Z",
        reason: "interval",
        partyId: null,
        rateLimitCount: 0,
        apiCallsTotal: 24,
        apiCallsLast5m: 6,
        syncRetryAfterMs: null,
      },
      {
        id: 1,
        sessionId,
        recordedAt: "2026-01-01T12:00:05.000Z",
        reason: "startup",
        partyId: null,
        rateLimitCount: 0,
        apiCallsTotal: 0,
        apiCallsLast5m: 0,
        syncRetryAfterMs: null,
      },
    ]);

    expect(summarized).toHaveLength(2);
    expect(summarized.find((entry) => entry.reason === "startup")?.id).toBe(1);
    const minute = summarized.find((entry) => entry.reason === "interval");
    expect(minute?.recordedAt).toBe("2026-01-01T12:00:00.000Z");
    expect(minute?.sampleCount).toBe(2);
    expect(minute?.id).toBe(3);
    expect(minute?.apiCallsLast5m).toBe(8);
    expect(minute?.apiCallsTotal).toBe(30);
  });
});
