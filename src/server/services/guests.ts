import type { Db } from "../db/schema";
import type { GuestAdminView, GuestMySongView, QueueItemStatus } from "@/shared/types";
import {
  getNextUpcomingItem,
  getQueueItems,
  getUpcomingPlayOrder,
  isGuestBoostBlocked,
  type QueueItemRow,
} from "./queue";

const TERMINAL_STATUSES: QueueItemStatus[] = ["played", "skipped", "vetoed"];
const ACTIVE_STATUSES: QueueItemStatus[] = ["pending", "queued", "playing"];

interface GuestStatsRow {
  id: string;
  display_name: string | null;
  boost_used: number;
  disabled: number;
  created_at: string;
  last_seen_at: string | null;
  last_ip: string | null;
  upvote_count: number;
  veto_count: number;
}

interface GuestSongRow {
  track_name: string;
  artist_name: string;
  added_at: string;
  status: string;
}

export function countGuestActiveSongs(
  db: Db,
  partyId: string,
  guestId: string,
): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS count FROM queue_items
       WHERE party_id = ? AND added_by_guest_id = ? AND from_seed = 0
         AND status IN ('pending', 'queued', 'playing')`,
    )
    .get(partyId, guestId) as { count: number };
  return row.count;
}

/** Label for where a guest's song sits in the virtual play order. */
export function formatGuestQueuePosition(
  itemId: string,
  status: string,
  upcoming: QueueItemRow[],
  nextItemId: string | null,
): string | null {
  if (status === "playing") return "Now playing";
  if (!ACTIVE_STATUSES.includes(status as QueueItemStatus)) return null;
  const idx = upcoming.findIndex((item) => item.id === itemId);
  if (idx < 0) return null;
  if (idx === 0 || itemId === nextItemId) return "Up next";
  return `#${idx + 1} in queue`;
}

export function getGuestMySongs(
  db: Db,
  partyId: string,
  guestId: string,
  boostUsed: boolean,
): { active: GuestMySongView[]; history: GuestMySongView[] } {
  const rows = db
    .query(
      `SELECT id, track_name, artist_name, album_art_url, upvote_count, veto_count,
              status, is_boosted, added_at, finished_at
       FROM queue_items
       WHERE party_id = ? AND added_by_guest_id = ? AND from_seed = 0
       ORDER BY added_at DESC`,
    )
    .all(partyId, guestId) as QueueItemRow[];

  const partyActive = getQueueItems(db, partyId, ACTIVE_STATUSES);
  const upcoming = getUpcomingPlayOrder(partyActive);
  const nextItemId = getNextUpcomingItem(partyActive)?.id ?? null;

  const active: GuestMySongView[] = [];
  const history: GuestMySongView[] = [];

  for (const row of rows) {
    const view: GuestMySongView = {
      id: row.id,
      trackName: row.track_name,
      artistName: row.artist_name,
      albumArtUrl: row.album_art_url,
      status: row.status,
      isBoosted: row.is_boosted === 1,
      upvoteCount: row.upvote_count,
      vetoCount: row.veto_count,
      addedAt: row.added_at,
      finishedAt: row.finished_at,
      queuePosition: formatGuestQueuePosition(
        row.id,
        row.status,
        upcoming,
        nextItemId,
      ),
      canBoost: false,
      canUnboost: false,
      canRemove: false,
    };

    if (ACTIVE_STATUSES.includes(row.status)) {
      view.canBoost =
        !boostUsed &&
        row.is_boosted === 0 &&
        !isGuestBoostBlocked(partyActive, row.id);
      view.canUnboost =
        row.is_boosted === 1 &&
        row.status !== "playing" &&
        boostUsed;
      view.canRemove = row.status !== "playing";
      active.push(view);
    } else if (TERMINAL_STATUSES.includes(row.status)) {
      history.push(view);
    }
  }

  active.sort((a, b) => {
    const idxA = upcoming.findIndex((item) => item.id === a.id);
    const idxB = upcoming.findIndex((item) => item.id === b.id);
    if (idxA < 0 && idxB < 0) return b.addedAt.localeCompare(a.addedAt);
    if (idxA < 0) return 1;
    if (idxB < 0) return -1;
    return idxA - idxB;
  });

  return { active, history };
}

export function touchGuestLastSeen(
  db: Db,
  guestId: string,
  ip?: string | null,
): void {
  const now = new Date().toISOString();
  if (ip) {
    db.run(`UPDATE guests SET last_seen_at = ?, last_ip = ? WHERE id = ?`, [
      now,
      ip,
      guestId,
    ]);
    return;
  }
  db.run(`UPDATE guests SET last_seen_at = ? WHERE id = ?`, [now, guestId]);
}

const NAMED_GUEST_SQL = `display_name IS NOT NULL AND TRIM(display_name) != ''`;

export function countNamedPartyGuests(db: Db, partyId: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS count FROM guests
       WHERE party_id = ? AND ${NAMED_GUEST_SQL}`,
    )
    .get(partyId) as { count: number };
  return row.count;
}

export function getPartyGuestAdminViews(
  db: Db,
  partyId: string,
): GuestAdminView[] {
  const guests = db
    .query(
      `SELECT g.id, g.display_name, g.boost_used, g.disabled, g.created_at, g.last_seen_at, g.last_ip,
        (SELECT COUNT(*) FROM votes v WHERE v.guest_id = g.id) AS upvote_count,
        (SELECT COUNT(*) FROM vetoes ve WHERE ve.guest_id = g.id) AS veto_count
       FROM guests g
       WHERE g.party_id = ? AND ${NAMED_GUEST_SQL}
       ORDER BY COALESCE(g.last_seen_at, g.created_at) DESC`,
    )
    .all(partyId) as GuestStatsRow[];

  const songsStmt = db.query(
    `SELECT track_name, artist_name, added_at, status
     FROM queue_items
     WHERE party_id = ? AND added_by_guest_id = ? AND from_seed = 0
     ORDER BY added_at DESC`,
  );

  return guests.map((guest) => {
    const songs = songsStmt.all(partyId, guest.id) as GuestSongRow[];
    return {
      id: guest.id,
      displayName: guest.display_name,
      disabled: guest.disabled === 1,
      boostUsed: guest.boost_used === 1,
      createdAt: guest.created_at,
      lastSeenAt: guest.last_seen_at,
      lastIp: guest.last_ip,
      upvoteCount: guest.upvote_count,
      vetoCount: guest.veto_count,
      boostCount: guest.boost_used === 1 ? 1 : 0,
      songsAdded: songs.map((song) => ({
        trackName: song.track_name,
        artistName: song.artist_name,
        addedAt: song.added_at,
        status: song.status,
      })),
    };
  });
}

/** Remove all guests and their votes/vetoes/rate limits; queue songs stay. */
export function clearPartyGuests(db: Db, partyId: string): number {
  const countRow = db
    .query(`SELECT COUNT(*) AS count FROM guests WHERE party_id = ?`)
    .get(partyId) as { count: number };
  const count = countRow.count;
  if (count === 0) return 0;

  db.run(
    `DELETE FROM votes WHERE guest_id IN (SELECT id FROM guests WHERE party_id = ?)`,
    [partyId],
  );
  db.run(
    `DELETE FROM vetoes WHERE guest_id IN (SELECT id FROM guests WHERE party_id = ?)`,
    [partyId],
  );
  db.run(
    `DELETE FROM rate_limit_events WHERE guest_id IN (SELECT id FROM guests WHERE party_id = ?)`,
    [partyId],
  );
  db.run(
    `UPDATE queue_items SET added_by_guest_id = NULL
     WHERE party_id = ? AND added_by_guest_id IS NOT NULL`,
    [partyId],
  );
  db.run(`DELETE FROM guests WHERE party_id = ?`, [partyId]);
  return count;
}

/** Clear a guest's rate-limit counters so they can add/upvote/veto again. */
export function resetGuestRateLimits(
  db: Db,
  partyId: string,
  guestId: string,
): { cleared: number } {
  const guest = db
    .query(`SELECT id FROM guests WHERE id = ? AND party_id = ?`)
    .get(guestId, partyId) as { id: string } | null;
  if (!guest) {
    throw new Error("NOT_FOUND");
  }

  const before = db
    .query(`SELECT COUNT(*) AS count FROM rate_limit_events WHERE guest_id = ?`)
    .get(guestId) as { count: number };

  db.run(`DELETE FROM rate_limit_events WHERE guest_id = ?`, [guestId]);

  return { cleared: before.count };
}
