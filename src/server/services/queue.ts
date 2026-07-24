import type { Db } from "../db/schema";
import type { ExportTrack, QueueItemStatus } from "@/shared/types";

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
  added_at: string;
  finished_at: string | null;
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

export function compareNormalQueue(a: QueueItemRow, b: QueueItemRow): number {
  if (a.manual_order != null && b.manual_order != null) {
    return a.manual_order - b.manual_order;
  }
  if (a.manual_order != null) return -1;
  if (b.manual_order != null) return 1;
  if (a.upvote_count !== b.upvote_count) {
    return b.upvote_count - a.upvote_count;
  }
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
    .sort((a, b) => (a.boost_position ?? 0) - (b.boost_position ?? 0));
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

export function getPlayOrder(items: QueueItemRow[]): QueueItemRow[] {
  const playing = items.find((i) => i.status === "playing");
  const boost = getBoostLane(items);
  const normal = getNormalUpcoming(items);
  return [...(playing ? [playing] : []), ...boost, ...normal];
}

export function getUpcomingPlayOrder(items: QueueItemRow[]): QueueItemRow[] {
  return getPlayOrder(items).filter((i) => i.status !== "playing");
}

export function getNextUpcomingItem(items: QueueItemRow[]): QueueItemRow | null {
  return getUpcomingPlayOrder(items)[0] ?? null;
}

/** Pending next-up track — already first; upvote/boost won't change order. */
export function isGuestNextUpPendingLocked(
  items: QueueItemRow[],
  itemId: string,
): boolean {
  const next = getNextUpcomingItem(items);
  const item = items.find((i) => i.id === itemId);
  if (!next || !item || next.id !== itemId) return false;
  return item.status === "pending";
}

/** Guest cannot upvote/boost/veto a track already sent to Spotify's queue buffer. */
export function isGuestSpotifyBufferLocked(
  items: QueueItemRow[],
  itemId: string,
): boolean {
  const item = items.find((i) => i.id === itemId);
  if (!item || !["pending", "queued"].includes(item.status)) return true;
  return item.status === "queued";
}

export function isGuestUpvoteBlocked(
  items: QueueItemRow[],
  itemId: string,
): boolean {
  return (
    isGuestSpotifyBufferLocked(items, itemId) ||
    isGuestNextUpPendingLocked(items, itemId)
  );
}

export function isGuestBoostBlocked(
  items: QueueItemRow[],
  itemId: string,
): boolean {
  const item = items.find((i) => i.id === itemId);
  if (!item || !["pending", "queued"].includes(item.status)) return true;
  if (item.is_boosted === 1) return true;
  if (item.status === "queued") return true;
  return isGuestNextUpPendingLocked(items, itemId);
}

export function isGuestVetoBlocked(
  items: QueueItemRow[],
  itemId: string,
): boolean {
  return isGuestSpotifyBufferLocked(items, itemId);
}

export function markFinished(
  db: Db,
  itemId: string,
  status: QueueItemStatus,
): void {
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
  db.run(
    `UPDATE queue_items SET status = 'pending'
     WHERE party_id = ? AND status = 'queued'`,
    [partyId],
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

export function getDedupTitles(db: Db, partyId: string): string[] {
  const active = db
    .query(
      `SELECT track_name FROM queue_items
       WHERE party_id = ? AND status IN ('pending', 'queued', 'playing')`,
    )
    .all(partyId) as { track_name: string }[];
  const recent = db
    .query(
      `SELECT track_name FROM queue_items
       WHERE party_id = ? AND status IN ('played', 'skipped', 'vetoed')
       ORDER BY finished_at DESC LIMIT 20`,
    )
    .all(partyId) as { track_name: string }[];
  return [...active, ...recent].map((r) => r.track_name);
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
      : row.added_by_guest_id
        ? (row.guest_display_name ?? "Guest")
        : "Host";
  return {
    id: row.id,
    spotifyUri: row.spotify_uri,
    trackName: row.track_name,
    artistName: row.artist_name,
    albumArtUrl: row.album_art_url,
    upvoteCount: row.upvote_count,
    vetoCount: row.veto_count,
    status: row.status,
    isBoosted: row.is_boosted === 1,
    boostPosition: row.boost_position,
    addedBy,
    addedByGuestId: row.added_by_guest_id,
    addedAt: row.added_at,
  };
}

/** Tracks from an ended party in playback order, deduped by URI. */
export function getPartyExportTracks(db: Db, partyId: string): ExportTrack[] {
  const rows = db
    .query(
      `SELECT spotify_uri, track_name, artist_name, album_art_url, finished_at, added_at
       FROM queue_items
       WHERE party_id = ? AND status IN ('played', 'skipped', 'playing')
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
  for (const row of rows) {
    if (seen.has(row.spotify_uri)) continue;
    seen.add(row.spotify_uri);
    tracks.push({
      uri: row.spotify_uri,
      name: row.track_name,
      artistName: row.artist_name,
      albumArtUrl: row.album_art_url,
    });
  }
  return tracks;
}

export function isDuplicateError(error: unknown): boolean {
  return error instanceof Error && error.message === "DUPLICATE";
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
