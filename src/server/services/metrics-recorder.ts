import type {
  HostDiagnostics,
  MetricsSessionSummary,
  MetricsSnapshotReason,
  MetricsSnapshotSummary,
} from "@/shared/types";
import type { Db } from "../db/schema";
import { newId } from "../crypto";
import { setSpotifyRateLimitListener } from "./spotify-metrics";

/** Persist diagnostics at 10s — admin UI summarizes to 1-minute buckets. */
export const METRICS_SNAPSHOT_INTERVAL_MS = 10_000;
/** Minimum gap between rate-limit-triggered snapshots. */
export const METRICS_RATE_LIMIT_SNAPSHOT_COOLDOWN_MS = 10_000;
/** Max interval snapshots retained per session (older intervals pruned). */
export const METRICS_MAX_INTERVAL_SNAPSHOTS = 4320;

let currentSessionId: string | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let lastRateLimitSnapshotAt = 0;

export function getCurrentMetricsSessionId(): string {
  return currentSessionId ?? "unknown";
}

function closeOpenSessions(db: Db, endedAt: string): void {
  db.run(`UPDATE metrics_sessions SET ended_at = ? WHERE ended_at IS NULL`, [
    endedAt,
  ]);
}

function pruneIntervalSnapshots(db: Db, sessionId: string): void {
  const row = db
    .query(
      `SELECT COUNT(*) as count FROM metrics_snapshots
       WHERE session_id = ? AND reason = 'interval'`,
    )
    .get(sessionId) as { count: number };
  const excess = row.count - METRICS_MAX_INTERVAL_SNAPSHOTS;
  if (excess <= 0) return;

  db.run(
    `DELETE FROM metrics_snapshots
     WHERE id IN (
       SELECT id FROM metrics_snapshots
       WHERE session_id = ? AND reason = 'interval'
       ORDER BY recorded_at ASC
       LIMIT ?
     )`,
    [sessionId, excess],
  );
}

function readActivePartyId(db: Db): string | null {
  try {
    const party = db
      .query(
        `SELECT id FROM parties WHERE status IN ('on', 'off') ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { id: string } | null;
    return party?.id ?? null;
  } catch {
    return null;
  }
}

function insertSnapshot(
  db: Db,
  sessionId: string,
  reason: MetricsSnapshotReason,
  diagnostics: HostDiagnostics,
): void {
  const recordedAt = new Date().toISOString();
  db.run(
    `INSERT INTO metrics_snapshots (session_id, recorded_at, reason, party_id, payload)
     VALUES (?, ?, ?, ?, ?)`,
    [
      sessionId,
      recordedAt,
      reason,
      readActivePartyId(db),
      JSON.stringify(diagnostics),
    ],
  );

  if (reason === "interval") {
    pruneIntervalSnapshots(db, sessionId);
  }
}

function recordRateLimitSnapshot(
  db: Db,
  snapshotDiagnostics: () => HostDiagnostics,
): void {
  if (!currentSessionId) return;
  const now = Date.now();
  if (now - lastRateLimitSnapshotAt < METRICS_RATE_LIMIT_SNAPSHOT_COOLDOWN_MS) {
    return;
  }
  lastRateLimitSnapshotAt = now;
  insertSnapshot(db, currentSessionId, "rate_limit", snapshotDiagnostics());
}

export function startMetricsRecorder(
  db: Db,
  snapshotDiagnostics: () => HostDiagnostics,
): void {
  if (intervalHandle) return;

  const now = new Date().toISOString();
  closeOpenSessions(db, now);

  currentSessionId = newId();
  db.run(`INSERT INTO metrics_sessions (id, started_at) VALUES (?, ?)`, [
    currentSessionId,
    now,
  ]);

  insertSnapshot(db, currentSessionId, "startup", snapshotDiagnostics());

  setSpotifyRateLimitListener(() => {
    recordRateLimitSnapshot(db, snapshotDiagnostics);
  });

  intervalHandle = setInterval(() => {
    if (!currentSessionId) return;
    insertSnapshot(
      db,
      currentSessionId,
      "interval",
      snapshotDiagnostics(),
    );
  }, METRICS_SNAPSHOT_INTERVAL_MS);
}

export function listMetricsSessions(db: Db): MetricsSessionSummary[] {
  const currentId = currentSessionId;
  const rows = db
    .query(
      `SELECT
         s.id,
         s.started_at,
         s.ended_at,
         COUNT(sn.id) as snapshot_count,
         SUM(CASE WHEN sn.reason = 'rate_limit' THEN 1 ELSE 0 END) as rate_limit_snapshot_count
       FROM metrics_sessions s
       LEFT JOIN metrics_snapshots sn ON sn.session_id = s.id
       GROUP BY s.id
       ORDER BY s.started_at DESC
       LIMIT 50`,
    )
    .all() as {
    id: string;
    started_at: string;
    ended_at: string | null;
    snapshot_count: number;
    rate_limit_snapshot_count: number;
  }[];

  return rows.map((row) => ({
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    snapshotCount: row.snapshot_count,
    rateLimitSnapshotCount: row.rate_limit_snapshot_count,
    isCurrent: row.id === currentId,
  }));
}

function mapSnapshotSummary(row: {
  id: number;
  session_id: string;
  recorded_at: string;
  reason: string;
  party_id: string | null;
  payload: string;
}): MetricsSnapshotSummary {
  const payload = JSON.parse(row.payload) as HostDiagnostics;
  return {
    id: row.id,
    sessionId: row.session_id,
    recordedAt: row.recorded_at,
    reason: row.reason as MetricsSnapshotReason,
    partyId: row.party_id,
    rateLimitCount: payload.spotifyApi.rateLimitCount,
    apiCallsTotal: payload.spotifyApi.total,
    apiCallsLast5m: payload.spotifyApi.last5m,
    syncRetryAfterMs: payload.sync.retryAfterMs,
  };
}

function minuteBucketKey(iso: string): string {
  const date = new Date(iso);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

/** Collapse 10s interval snapshots into one summary row per UTC minute. */
export function summarizeMetricsSnapshotsByMinute(
  snapshots: MetricsSnapshotSummary[],
): MetricsSnapshotSummary[] {
  const summarized: MetricsSnapshotSummary[] = [];
  const intervalBuckets = new Map<string, MetricsSnapshotSummary[]>();

  for (const snapshot of snapshots) {
    if (snapshot.reason !== "interval") {
      summarized.push(snapshot);
      continue;
    }
    const key = minuteBucketKey(snapshot.recordedAt);
    const bucket = intervalBuckets.get(key) ?? [];
    bucket.push(snapshot);
    intervalBuckets.set(key, bucket);
  }

  for (const [minuteIso, bucket] of intervalBuckets) {
    const latest = bucket.reduce((newest, current) =>
      new Date(current.recordedAt).getTime() > new Date(newest.recordedAt).getTime()
        ? current
        : newest,
    );
    summarized.push({
      ...latest,
      recordedAt: minuteIso,
      rateLimitCount: Math.max(...bucket.map((entry) => entry.rateLimitCount)),
      apiCallsLast5m: Math.max(...bucket.map((entry) => entry.apiCallsLast5m)),
      apiCallsTotal: latest.apiCallsTotal,
      syncRetryAfterMs: bucket.reduce<number | null>((peak, entry) => {
        const value = entry.syncRetryAfterMs ?? 0;
        if (value <= 0) return peak;
        return peak == null ? value : Math.max(peak, value);
      }, null),
      sampleCount: bucket.length,
    });
  }

  return summarized.sort(
    (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
  );
}

export function listMetricsSnapshots(
  db: Db,
  sessionId: string,
  options?: {
    reason?: MetricsSnapshotReason;
    limit?: number;
    granularity?: "raw" | "minute";
  },
): MetricsSnapshotSummary[] {
  const limit = options?.limit ?? 500;
  const reason = options?.reason;
  const granularity = options?.granularity ?? "raw";
  const rawLimit =
    granularity === "minute" ? Math.min(10_000, limit * 6) : limit;

  const rows = reason
    ? (db
        .query(
          `SELECT id, session_id, recorded_at, reason, party_id, payload
           FROM metrics_snapshots
           WHERE session_id = ? AND reason = ?
           ORDER BY recorded_at DESC
           LIMIT ?`,
        )
        .all(sessionId, reason, rawLimit) as {
        id: number;
        session_id: string;
        recorded_at: string;
        reason: string;
        party_id: string | null;
        payload: string;
      }[])
    : (db
        .query(
          `SELECT id, session_id, recorded_at, reason, party_id, payload
           FROM metrics_snapshots
           WHERE session_id = ?
           ORDER BY recorded_at DESC
           LIMIT ?`,
        )
        .all(sessionId, rawLimit) as {
        id: number;
        session_id: string;
        recorded_at: string;
        reason: string;
        party_id: string | null;
        payload: string;
      }[]);

  const snapshots = rows.map(mapSnapshotSummary);
  if (granularity !== "minute") {
    return snapshots;
  }
  return summarizeMetricsSnapshotsByMinute(snapshots).slice(0, limit);
}

export function getMetricsSnapshot(
  db: Db,
  sessionId: string,
  snapshotId: number,
): HostDiagnostics | null {
  const row = db
    .query(
      `SELECT payload FROM metrics_snapshots
       WHERE id = ? AND session_id = ?`,
    )
    .get(snapshotId, sessionId) as { payload: string } | null;
  if (!row) return null;
  return JSON.parse(row.payload) as HostDiagnostics;
}

/** @internal test helper */
export function resetMetricsRecorderForTests(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  setSpotifyRateLimitListener(null);
  currentSessionId = null;
  lastRateLimitSnapshotAt = 0;
}
