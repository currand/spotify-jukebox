import type { Db } from "../db/schema";
import type { ExportTrack, QueueItemStatus } from "@/shared/types";
import { isDuplicateTrack } from "@/shared/dedup";
import { newId } from "../crypto";
import type { TrackInfo } from "./spotify";

export interface QueueItemRow {
  id: string;
  party_id: string;
  spotify_uri: string;
  track_name: string;
  artist_name: string;
  album_art_url: string | null;
  upvote_count: number;
  veto_count: number;
  status: QueueItemStatus;
  is_boosted: number;
  boost_position: number | null;
  manual_order: number | null;
  added_by_guest_id: string | null;
  from_seed: number;
  from_spotify: number;
  added_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  guest_display_name?: string | null;
}

const ACTIVE_STATUSES: QueueItemStatus[] = ["pending", "queued", "playing"];

export function getQueueItems(
  db: Db,
  partyId: string,
  statuses?: QueueItemStatus[],
): QueueItemRow[] {
  if (statuses?.length) {
    const placeholders = statuses.map(() => "?").join(", ");
    return db
      .query(
        `SELECT q.*, g.display_name as guest_display_name
         FROM queue_items q
         LEFT JOIN guests g ON g.id = q.added_by_guest_id
         WHERE q.party_id = ? AND q.status IN (${placeholders})
         ORDER BY q.added_at ASC`,
      )
      .all(partyId, ...statuses) as QueueItemRow[];
  }
  return db
    .query(
      `SELECT q.*, g.display_name as guest_display_name
       FROM queue_items q
       LEFT JOIN guests g ON g.id = q.added_by_guest_id
       WHERE q.party_id = ?
       ORDER BY q.added_at ASC`,
    )
    .all(partyId) as QueueItemRow[];
}

function isIdleSeed(row: QueueItemRow): boolean {
  return row.from_seed === 1 && row.upvote_count === 0 && row.is_boosted === 0;
}

export function compareNormalQueue(a: QueueItemRow, b: QueueItemRow): number {
  if (a.manual_order != null && b.manual_order != null) {
    return a.manual_order - b.manual_order;
  }
  if (a.manual_order != null) return -1;
  if (b.manual_order != null) return 1;
  if (a.upvote_count !== b.upvote_count) {
    return b.upvote_count - a.upvote_count;
  }
  const aIdle = isIdleSeed(a);
  const bIdle = isIdleSeed(b);
  if (aIdle !== bIdle) return aIdle ? 1 : -1;
  return a.added_at.localeCompare(b.added_at);
}

export function getBoostLane(items: QueueItemRow[]): QueueItemRow[] {
  return items
    .filter(
      (i) =>
        i.is_boosted === 1 &&
        ACTIVE_STATUSES.includes(i.status) &&
        i.status !== "playing",
    )
    .sort((a, b) => {
      if (a.upvote_count !== b.upvote_count) {
        return b.upvote_count - a.upvote_count;
      }
      return (a.boost_position ?? 0) - (b.boost_position ?? 0);
    });
}

export function countActiveBoosts(db: Db, partyId: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) as count FROM queue_items
       WHERE party_id = ? AND is_boosted = 1 AND status IN ('pending', 'queued', 'playing')`,
    )
    .get(partyId) as { count: number };
  return row.count;
}

export function getNormalUpcoming(items: QueueItemRow[]): QueueItemRow[] {
  return items
    .filter(
      (i) =>
        i.is_boosted === 0 &&
        (i.status === "pending" || i.status === "queued"),
    )
    .sort(compareNormalQueue);
}

/** Normal upcoming tracks the admin may reorder (excludes Spotify buffer and tail). */
export function getAdminReorderableNormal(items: QueueItemRow[]): QueueItemRow[] {
  return getNormalUpcoming(items).filter(
    (i) => i.status !== "queued" && i.from_spotify !== 1,
  );
}

/** Play order: now playing and Spotify-buffered track are canonical; rest is virtual. */
export function getPlayOrder(items: QueueItemRow[]): QueueItemRow[] {
  const playing = items.find((i) => i.status === "playing");
  const boost = getBoostLane(items);
  const normal = getNormalUpcoming(items);
  const queued = items.find((i) => i.status === "queued");

  let upcoming: QueueItemRow[];
  if (queued) {
    upcoming = [
      queued,
      ...boost.filter((i) => i.id !== queued.id),
      ...normal.filter((i) => i.id !== queued.id),
    ];
  } else if (
    !playing &&
    normal.length === 1 &&
    normal[0]!.status === "pending" &&
    boost.length > 0
  ) {
    // Sole pending normal is already "Sending to Spotify…" — boosts queue behind it.
    const pin = normal[0]!;
    upcoming = [
      pin,
      ...boost.filter((i) => i.id !== pin.id),
      ...normal.filter((i) => i.id !== pin.id),
    ];
  } else {
    upcoming = [...boost, ...normal];
  }

  return [...(playing ? [playing] : []), ...upcoming];
}

export function getUpcomingPlayOrder(items: QueueItemRow[]): QueueItemRow[] {
  return getPlayOrder(items).filter((i) => i.status !== "playing");
}

export function getNextUpcomingItem(items: QueueItemRow[]): QueueItemRow | null {
  return getUpcomingPlayOrder(items)[0] ?? null;
}

/**
 * Track in Spotify's buffer slot (`queued`) or next virtual track when buffer is empty.
 * `queued` / `playing` statuses are set by sync from Spotify — not virtual reordering.
 */
export function getSpotifyBufferItem(
  items: QueueItemRow[],
): QueueItemRow | null {
  return getUpcomingPlayOrder(items)[0] ?? null;
}

/** Pending next-up track — already first; upvote/boost won't change order. */
export function isGuestNextUpPendingLocked(
  items: QueueItemRow[],
  itemId: string,
): boolean {
  const item = items.find((i) => i.id === itemId);
  if (!item || item.status !== "pending") return false;
  const buffer = getSpotifyBufferItem(items);
  return buffer?.id === itemId;
}

/** Guest cannot reorder or veto tracks already in Spotify's queue. */
export function isGuestSpotifyBufferLocked(
  items: QueueItemRow[],
  itemId: string,
): boolean {
  const item = items.find((i) => i.id === itemId);
  if (!item || !["pending", "queued"].includes(item.status)) return true;
  if (item.status === "queued") return true;
  if (item.from_spotify === 1) return true;
  return false;
}

export function isSpotifyLockedItem(row: QueueItemRow): boolean {
  return (
    row.from_spotify === 1 &&
    (row.status === "queued" || row.status === "pending")
  );
}

function isGuestBufferSlotLocked(
  items: QueueItemRow[],
  itemId: string,
): boolean {
  const buffer = getSpotifyBufferItem(items);
  return buffer?.id === itemId;
}

export function isGuestUpvoteBlocked(
  items: QueueItemRow[],
  itemId: string,
): boolean {
  const item = items.find((i) => i.id === itemId);
  if (!item || !["pending", "queued"].includes(item.status)) return true;
  return isGuestBufferSlotLocked(items, itemId);
}

export function isGuestBoostBlocked(
  items: QueueItemRow[],
  itemId: string,
): boolean {
  const item = items.find((i) => i.id === itemId);
  if (!item || !["pending", "queued"].includes(item.status)) return true;
  if (item.is_boosted === 1) return true;
  return isGuestBufferSlotLocked(items, itemId);
}

export function isGuestVetoBlocked(
  items: QueueItemRow[],
  itemId: string,
): boolean {
  return isGuestSpotifyBufferLocked(items, itemId);
}

export function adoptSpotifyTrack(
  db: Db,
  partyId: string,
  track: TrackInfo,
  status: Extract<QueueItemStatus, "playing" | "queued" | "pending">,
): string {
  const existing = db
    .query(
      `SELECT id, status FROM queue_items
       WHERE party_id = ? AND spotify_uri = ?
         AND status IN ('pending', 'queued', 'playing')`,
    )
    .get(partyId, track.uri) as { id: string; status: QueueItemStatus } | null;

  if (existing) {
    if (existing.status === "playing" && status !== "playing") {
      return existing.id;
    }
    db.run(`UPDATE queue_items SET status = ? WHERE id = ?`, [status, existing.id]);
    return existing.id;
  }

  const id = newId();
  db.run(
    `INSERT INTO queue_items (
      id, party_id, spotify_uri, track_name, artist_name, album_art_url,
      upvote_count, veto_count, status, is_boosted, boost_position,
      manual_order, added_by_guest_id, from_seed, from_spotify, added_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 0, NULL, NULL, NULL, 0, 1, ?)`,
    [
      id,
      partyId,
      track.uri,
      track.name,
      track.artistName,
      track.albumArtUrl,
      status,
      new Date().toISOString(),
    ],
  );
  return id;
}

export function markFinished(
  db: Db,
  itemId: string,
  status: QueueItemStatus,
): void {
  const current = db
    .query(`SELECT status FROM queue_items WHERE id = ?`)
    .get(itemId) as { status: QueueItemStatus } | null;
  if (
    current &&
    (current.status === "skipped" || current.status === "vetoed") &&
    status === "played"
  ) {
    return;
  }
  db.run(
    `UPDATE queue_items SET status = ?, finished_at = ? WHERE id = ?`,
    [status, new Date().toISOString(), itemId],
  );
}

export function bumpSyncGeneration(db: Db, partyId: string): void {
  db.run(
    `UPDATE parties SET sync_generation = sync_generation + 1, updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), partyId],
  );
}

export function resetQueuedToPending(db: Db, partyId: string): void {
  db.run(
    `UPDATE queue_items SET status = 'pending'
     WHERE party_id = ? AND status = 'queued'`,
    [partyId],
  );
}

export function nextBoostPosition(db: Db, partyId: string): number {
  const row = db
    .query(
      `SELECT MAX(boost_position) as maxPos FROM queue_items
       WHERE party_id = ? AND is_boosted = 1`,
    )
    .get(partyId) as { maxPos: number | null };
  return (row.maxPos ?? -1) + 1;
}

export function getDedupTracks(
  db: Db,
  partyId: string,
): { trackName: string; artistName: string; durationMs: number | null }[] {
  const active = db
    .query(
      `SELECT track_name, artist_name, duration_ms FROM queue_items
       WHERE party_id = ? AND status IN ('pending', 'queued', 'playing')`,
    )
    .all(partyId) as {
    track_name: string;
    artist_name: string;
    duration_ms: number | null;
  }[];
  const recent = db
    .query(
      `SELECT track_name, artist_name, duration_ms FROM queue_items
       WHERE party_id = ? AND status IN ('played', 'vetoed')
       ORDER BY finished_at DESC LIMIT 20`,
    )
    .all(partyId) as {
    track_name: string;
    artist_name: string;
    duration_ms: number | null;
  }[];
  return [...active, ...recent].map((r) => ({
    trackName: r.track_name,
    artistName: r.artist_name,
    durationMs: r.duration_ms,
  }));
}

export function markPriorItemsPlayed(
  db: Db,
  items: QueueItemRow[],
  currentItemId: string,
): void {
  const order = getPlayOrder(items);
  const idx = order.findIndex((i) => i.id === currentItemId);
  if (idx <= 0) return;
  for (let i = 0; i < idx; i++) {
    const item = order[i];
    if (item.status === "pending" || item.status === "queued") {
      markFinished(db, item.id, "played");
    }
  }
}

export function toQueueItemView(row: QueueItemRow) {
  const addedBy =
    row.from_seed === 1
      ? "From playlist"
      : row.from_spotify === 1
        ? "Spotify"
        : row.added_by_guest_id
          ? (row.guest_display_name ?? "Guest")
          : "Host";
  return {
    id: row.id,
    spotifyUri: row.spotify_uri,
    trackName: row.track_name,
    artistName: row.artist_name,
    albumArtUrl: row.album_art_url,
    durationMs: row.duration_ms,
    upvoteCount: row.upvote_count,
    vetoCount: row.veto_count,
    status: row.status,
    isBoosted: row.is_boosted === 1,
    boostPosition: row.boost_position,
    addedBy,
    addedByGuestId: row.added_by_guest_id,
    addedAt: row.added_at,
    spotifyLocked: isSpotifyLockedItem(row),
  };
}

/** Tracks from an ended party in playback order, deduped by URI. */
export function getPartyExportTracks(db: Db, partyId: string): ExportTrack[] {
  const terminalRows = db
    .query(
      `SELECT spotify_uri, track_name, artist_name, album_art_url, finished_at, added_at
       FROM queue_items
       WHERE party_id = ? AND status IN ('played', 'skipped', 'vetoed')
       ORDER BY COALESCE(finished_at, added_at) ASC, added_at ASC`,
    )
    .all(partyId) as {
    spotify_uri: string;
    track_name: string;
    artist_name: string;
    album_art_url: string | null;
  }[];

  const seen = new Set<string>();
  const tracks: ExportTrack[] = [];
  for (const row of terminalRows) {
    if (seen.has(row.spotify_uri)) continue;
    seen.add(row.spotify_uri);
    tracks.push({
      uri: row.spotify_uri,
      name: row.track_name,
      artistName: row.artist_name,
      albumArtUrl: row.album_art_url,
    });
  }

  const activeItems = getQueueItems(db, partyId, ["pending", "queued", "playing"]);
  for (const item of getPlayOrder(activeItems)) {
    if (seen.has(item.spotify_uri)) continue;
    seen.add(item.spotify_uri);
    tracks.push({
      uri: item.spotify_uri,
      name: item.track_name,
      artistName: item.artist_name,
      albumArtUrl: item.album_art_url,
    });
  }

  return tracks;
}

export function isDuplicateError(error: unknown): boolean {
  return (
    error instanceof DuplicateQueueItemError ||
    (error instanceof Error && error.message === "DUPLICATE")
  );
}

export class DuplicateQueueItemError extends Error {
  constructor() {
    super("DUPLICATE");
    this.name = "DuplicateQueueItemError";
  }
}

function isActiveUriUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("unique constraint") ||
    message.includes("constraint failed") ||
    message.includes("idx_queue_party_active_uri")
  );
}

export interface InsertQueueItemInput {
  partyId: string;
  uri: string;
  name: string;
  artistName: string;
  albumArtUrl: string | null;
  durationMs?: number | null;
  guestId: string | null;
  fromSeed?: boolean;
  fromSpotify?: boolean;
}

/** Insert a queue item with dedup check inside a transaction (race-safe). */
export function insertQueueItem(db: Db, input: InsertQueueItemInput): string {
  try {
    return db.transaction(() => {
      const tracks = getDedupTracks(db, input.partyId);
      if (
        isDuplicateTrack(
          {
            trackName: input.name,
            artistName: input.artistName,
            durationMs: input.durationMs,
          },
          tracks,
        )
      ) {
        throw new DuplicateQueueItemError();
      }

      const id = newId();
      db.run(
        `INSERT INTO queue_items (
          id, party_id, spotify_uri, track_name, artist_name, album_art_url,
          upvote_count, veto_count, status, is_boosted, boost_position,
          manual_order, added_by_guest_id, from_seed, from_spotify, added_at,
          duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'pending', 0, NULL, NULL, ?, ?, ?, ?, ?)`,
        [
          id,
          input.partyId,
          input.uri,
          input.name,
          input.artistName,
          input.albumArtUrl,
          input.guestId,
          input.fromSeed ? 1 : 0,
          input.fromSpotify ? 1 : 0,
          new Date().toISOString(),
          input.durationMs ?? null,
        ],
      );
      return id;
    })();
  } catch (error) {
    if (
      error instanceof DuplicateQueueItemError ||
      isActiveUriUniqueViolation(error)
    ) {
      throw new DuplicateQueueItemError();
    }
    throw error;
  }
}

/** Remove a party and all dependent rows (failed create rollback). */
export function deletePartyCascade(db: Db, partyId: string): void {
  db.run(
    `DELETE FROM votes WHERE queue_item_id IN (SELECT id FROM queue_items WHERE party_id = ?)`,
    [partyId],
  );
  db.run(
    `DELETE FROM vetoes WHERE queue_item_id IN (SELECT id FROM queue_items WHERE party_id = ?)`,
    [partyId],
  );
  db.run(`DELETE FROM queue_items WHERE party_id = ?`, [partyId]);
  db.run(
    `DELETE FROM rate_limit_events WHERE guest_id IN (SELECT id FROM guests WHERE party_id = ?)`,
    [partyId],
  );
  db.run(`DELETE FROM guests WHERE party_id = ?`, [partyId]);
  db.run(`DELETE FROM parties WHERE id = ?`, [partyId]);
}

export function computeQueueEtag(items: QueueItemRow[], partyUpdatedAt: string): string {
  const payload = items
    .map(
      (i) =>
        `${i.id}:${i.status}:${i.upvote_count}:${i.veto_count}:${i.is_boosted}:${i.boost_position}:${i.manual_order}`,
    )
    .join("|");
  return `"${Bun.hash(`${partyUpdatedAt}|${payload}`).toString(16)}"`;
}
