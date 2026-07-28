import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { Config } from "../config";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'off',
  veto_threshold INTEGER NOT NULL DEFAULT 3,
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
  veto_count INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS vetoes (
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
`;

export type Db = Database;

export function initDb(config: Config): Db {
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
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
  return db;
}
