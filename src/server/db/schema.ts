import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { Config } from "../config";

const DEFAULT_RATE_LIMITS_KEY = "default_rate_limits";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'off',
  downvote_threshold INTEGER NOT NULL DEFAULT 3,
  seed_playlist_id TEXT NOT NULL,
  rate_limits TEXT NOT NULL,
  sync_generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL REFERENCES parties(id),
  session_token TEXT NOT NULL UNIQUE,
  display_name TEXT,
  boost_used INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_items (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL REFERENCES parties(id),
  spotify_uri TEXT NOT NULL,
  track_name TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  album_art_url TEXT,
  upvote_count INTEGER NOT NULL DEFAULT 0,
  downvote_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  is_boosted INTEGER NOT NULL DEFAULT 0,
  boost_position INTEGER,
  manual_order INTEGER,
  added_by_guest_id TEXT REFERENCES guests(id),
  added_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_queue_party_status ON queue_items(party_id, status);
CREATE INDEX IF NOT EXISTS idx_queue_party_added ON queue_items(party_id, added_at);

CREATE TABLE IF NOT EXISTS votes (
  guest_id TEXT NOT NULL REFERENCES guests(id),
  queue_item_id TEXT NOT NULL REFERENCES queue_items(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (guest_id, queue_item_id)
);

CREATE TABLE IF NOT EXISTS downvotes (
  guest_id TEXT NOT NULL REFERENCES guests(id),
  queue_item_id TEXT NOT NULL REFERENCES queue_items(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (guest_id, queue_item_id)
);

CREATE TABLE IF NOT EXISTS rate_limit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id TEXT NOT NULL REFERENCES guests(id),
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_guest ON rate_limit_events(guest_id, action, created_at);

CREATE TABLE IF NOT EXISTS host_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS host_sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics_sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES metrics_sessions(id),
  recorded_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  party_id TEXT,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_session ON metrics_snapshots(session_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_reason ON metrics_snapshots(session_id, reason);

CREATE TABLE IF NOT EXISTS host_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export type Db = Database;

function tableExists(db: Db, name: string): boolean {
  const row = db
    .query(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { ok: number } | null;
  return row != null;
}

function runOptional(db: Db, sql: string): void {
  try {
    db.run(sql);
  } catch {
    /* already migrated or not applicable */
  }
}

function migrateVetoTableName(db: Db): void {
  if (tableExists(db, "vetoes") && !tableExists(db, "downvotes")) {
    db.run(`ALTER TABLE vetoes RENAME TO downvotes`);
  }
}

function migratePartyRateLimitsJson(db: Db): void {
  const rows = db
    .query(`SELECT id, rate_limits FROM parties`)
    .all() as { id: string; rate_limits: string }[];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.rate_limits) as Record<string, unknown>;
      if (!parsed.veto || parsed.downvote) continue;
      parsed.downvote = parsed.veto;
      delete parsed.veto;
      db.run(`UPDATE parties SET rate_limits = ? WHERE id = ?`, [
        JSON.stringify(parsed),
        row.id,
      ]);
    } catch {
      /* skip invalid JSON */
    }
  }
}

function migrateHostSettingsGuestLimitsJson(db: Db): void {
  const row = db
    .query(`SELECT value FROM host_settings WHERE key = ?`)
    .get(DEFAULT_RATE_LIMITS_KEY) as { value: string } | null;
  if (!row) return;
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    let changed = false;

    if (
      typeof parsed.vetoThreshold === "number" &&
      parsed.downvoteThreshold == null
    ) {
      parsed.downvoteThreshold = parsed.vetoThreshold;
      delete parsed.vetoThreshold;
      changed = true;
    }

    const rateLimits = parsed.rateLimits;
    if (rateLimits && typeof rateLimits === "object") {
      const limits = rateLimits as Record<string, unknown>;
      if (limits.veto && !limits.downvote) {
        limits.downvote = limits.veto;
        delete limits.veto;
        changed = true;
      }
    }

    if (
      parsed.veto &&
      !parsed.downvote &&
      parsed.add &&
      !parsed.rateLimits
    ) {
      parsed.downvote = parsed.veto;
      delete parsed.veto;
      changed = true;
    }

    if (changed) {
      db.run(`UPDATE host_settings SET value = ? WHERE key = ?`, [
        JSON.stringify(parsed),
        DEFAULT_RATE_LIMITS_KEY,
      ]);
    }
  } catch {
    /* skip invalid JSON */
  }
}

function migrateVetoToDownvote(db: Db): void {
  migrateVetoTableName(db);
  runOptional(
    db,
    `ALTER TABLE parties RENAME COLUMN veto_threshold TO downvote_threshold`,
  );
  runOptional(
    db,
    `ALTER TABLE queue_items RENAME COLUMN veto_count TO downvote_count`,
  );
  db.run(`UPDATE queue_items SET status = 'downvoted' WHERE status = 'vetoed'`);
  db.run(
    `UPDATE rate_limit_events SET action = 'downvote' WHERE action = 'veto'`,
  );
  migratePartyRateLimitsJson(db);
  migrateHostSettingsGuestLimitsJson(db);
}

export function initDb(config: Config): Db {
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrateVetoTableName(db);
  db.exec(SCHEMA);
  for (const sql of [
    `ALTER TABLE queue_items ADD COLUMN from_seed INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE queue_items ADD COLUMN from_spotify INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE guests ADD COLUMN last_seen_at TEXT`,
    `ALTER TABLE guests ADD COLUMN last_ip TEXT`,
    `ALTER TABLE guests ADD COLUMN tutorial_seen INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE parties ADD COLUMN boost_cap INTEGER`,
    `ALTER TABLE queue_items ADD COLUMN duration_ms INTEGER`,
    `ALTER TABLE queue_items ADD COLUMN boosted_by_guest_id TEXT REFERENCES guests(id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_party_active_uri
      ON queue_items(party_id, spotify_uri)
      WHERE status IN ('pending', 'queued', 'playing')`,
  ]) {
    try {
      db.run(sql);
    } catch {
      /* column already exists */
    }
  }
  migrateVetoToDownvote(db);
  return db;
}
