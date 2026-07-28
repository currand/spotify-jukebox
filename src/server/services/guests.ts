import type { Db } from "../db/schema";
import type {
  GuestAdminView,
  GuestProfileStats,
  GuestMySongView,
  QueueItemStatus,
} from "@/shared/types";
import { displayNameConflictKind, type DisplayNameConflictKind } from "@/shared/dedup";
import {
  getNextUpcomingItem,
  getQueueItems,
  getUpcomingPlayOrder,
  isGuestBoostBlocked,
  type QueueItemRow,
} from "./queue";

const TERMINAL_STATUSES: QueueItemStatus[] = [
  "played",
  "skipped",
  "downvoted",
  "unblocked",
];
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
  downvote_count: number;
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
  boostsLeft: number,
): { active: GuestMySongView[]; history: GuestMySongView[] } {
  const rows = db
    .query(
      `SELECT q.id, q.track_name, q.artist_name, q.album_art_url, q.upvote_count, q.downvote_count,
              q.status, q.is_boosted, q.added_at, q.finished_at, bg.display_name as booster_display_name
       FROM queue_items q
       LEFT JOIN guests bg ON bg.id = q.boosted_by_guest_id
       WHERE q.party_id = ? AND q.added_by_guest_id = ? AND q.from_seed = 0
       ORDER BY q.added_at DESC`,
    )
    .all(partyId, guestId) as Array<
    Pick<
      QueueItemRow,
      | "id"
      | "track_name"
      | "artist_name"
      | "album_art_url"
      | "upvote_count"
      | "downvote_count"
      | "status"
      | "is_boosted"
      | "added_at"
      | "finished_at"
    > & { booster_display_name?: string | null }
  >;

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
      boostedBy:
        row.is_boosted === 1 ? (row.booster_display_name ?? null) : null,
      upvoteCount: row.upvote_count,
      downvoteCount: row.downvote_count,
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
        boostsLeft > 0 &&
        row.is_boosted === 0 &&
        !isGuestBoostBlocked(partyActive, row.id);
      view.canUnboost =
        row.is_boosted === 1 && row.status !== "playing";
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

export function getGuestProfileStats(
  db: Db,
  partyId: string,
  guestId: string,
): GuestProfileStats {
  const upvotes = db
    .query(`SELECT COUNT(*) AS count FROM votes WHERE guest_id = ?`)
    .get(guestId) as { count: number };
  const downvotes = db
    .query(`SELECT COUNT(*) AS count FROM downvotes WHERE guest_id = ?`)
    .get(guestId) as { count: number };
  const boosts = db
    .query(
      `SELECT COUNT(*) AS count FROM rate_limit_events WHERE guest_id = ? AND action = 'boost'`,
    )
    .get(guestId) as { count: number };
  const songs = db
    .query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status IN ('pending', 'queued', 'playing') THEN 1 ELSE 0 END) AS in_queue,
         SUM(CASE WHEN status = 'played' THEN 1 ELSE 0 END) AS played
       FROM queue_items
       WHERE party_id = ? AND added_by_guest_id = ? AND from_seed = 0`,
    )
    .get(partyId, guestId) as {
    total: number;
    in_queue: number | null;
    played: number | null;
  };

  return {
    upvotesGiven: upvotes.count,
    downvotesGiven: downvotes.count,
    boostsGiven: boosts.count,
    songsAdded: songs.total,
    songsInQueue: songs.in_queue ?? 0,
    songsPlayed: songs.played ?? 0,
  };
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

interface NamedGuestRow {
  id: string;
  display_name: string;
  last_ip: string | null;
  session_token: string;
  boost_used: number;
}

/** Find another guest with an exact or similar display name. */
export function findConflictingNamedGuest(
  db: Db,
  partyId: string,
  name: string,
  excludeGuestId: string,
): (NamedGuestRow & { matchKind: DisplayNameConflictKind }) | null {
  const rows = db
    .query(
      `SELECT id, display_name, last_ip, session_token, boost_used FROM guests
       WHERE party_id = ? AND ${NAMED_GUEST_SQL} AND id != ?`,
    )
    .all(partyId, excludeGuestId) as NamedGuestRow[];

  let fuzzyMatch: (NamedGuestRow & { matchKind: "fuzzy" }) | null = null;
  for (const row of rows) {
    const kind = displayNameConflictKind(name, row.display_name);
    if (kind === "exact") return { ...row, matchKind: "exact" };
    if (kind === "fuzzy" && !fuzzyMatch) {
      fuzzyMatch = { ...row, matchKind: "fuzzy" };
    }
  }
  return fuzzyMatch;
}

/** Delete the anonymous guest and return the existing guest's session for reclaim. */
export function reclaimGuestSession(
  db: Db,
  newGuestId: string,
  existingGuestId: string,
): {
  id: string;
  displayName: string;
  boostUsed: boolean;
  tutorialSeen: boolean;
  sessionToken: string;
} {
  db.run(`DELETE FROM votes WHERE guest_id = ?`, [newGuestId]);
  db.run(`DELETE FROM downvotes WHERE guest_id = ?`, [newGuestId]);
  db.run(`DELETE FROM rate_limit_events WHERE guest_id = ?`, [newGuestId]);
  db.run(`DELETE FROM guests WHERE id = ?`, [newGuestId]);

  const existing = db
    .query(
      `SELECT id, display_name, session_token, boost_used, tutorial_seen FROM guests WHERE id = ?`,
    )
    .get(existingGuestId) as {
    id: string;
    display_name: string;
    session_token: string;
    boost_used: number;
    tutorial_seen: number;
  };

  return {
    id: existing.id,
    displayName: existing.display_name,
    boostUsed: existing.boost_used === 1,
    tutorialSeen: existing.tutorial_seen === 1,
    sessionToken: existing.session_token,
  };
}

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
        (SELECT COUNT(*) FROM downvotes ve WHERE ve.guest_id = g.id) AS downvote_count
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
  const activeBoostsStmt = db.query(
    `SELECT COUNT(*) AS count FROM queue_items
     WHERE party_id = ? AND added_by_guest_id = ? AND is_boosted = 1
       AND status IN ('pending', 'queued', 'playing')`,
  );

  return guests.map((guest) => {
    const songs = songsStmt.all(partyId, guest.id) as GuestSongRow[];
    const activeBoosts = activeBoostsStmt.get(partyId, guest.id) as {
      count: number;
    };
    return {
      id: guest.id,
      displayName: guest.display_name,
      disabled: guest.disabled === 1,
      boostUsed: activeBoosts.count > 0,
      createdAt: guest.created_at,
      lastSeenAt: guest.last_seen_at,
      lastIp: guest.last_ip,
      upvoteCount: guest.upvote_count,
      downvoteCount: guest.downvote_count,
      boostCount: activeBoosts.count,
      songsAdded: songs.map((song) => ({
        trackName: song.track_name,
        artistName: song.artist_name,
        addedAt: song.added_at,
        status: song.status,
      })),
    };
  });
}

export const STALE_GUEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function deleteGuestsAndRelatedData(db: Db, partyId: string, guestIds: string[]): number {
  if (guestIds.length === 0) return 0;
  const placeholders = guestIds.map(() => "?").join(", ");

  db.run(
    `DELETE FROM votes WHERE guest_id IN (${placeholders})`,
    guestIds,
  );
  db.run(
    `DELETE FROM downvotes WHERE guest_id IN (${placeholders})`,
    guestIds,
  );
  db.run(
    `DELETE FROM rate_limit_events WHERE guest_id IN (${placeholders})`,
    guestIds,
  );
  db.run(
    `UPDATE queue_items SET added_by_guest_id = NULL
     WHERE party_id = ? AND added_by_guest_id IN (${placeholders})`,
    [partyId, ...guestIds],
  );
  db.run(
    `UPDATE queue_items SET boosted_by_guest_id = NULL
     WHERE party_id = ? AND boosted_by_guest_id IN (${placeholders})`,
    [partyId, ...guestIds],
  );
  db.run(
    `DELETE FROM guests WHERE party_id = ? AND id IN (${placeholders})`,
    [partyId, ...guestIds],
  );
  return guestIds.length;
}

/** Remove inactive guests with no queue contributions (e.g. stale load-test sessions). */
export function purgeStalePartyGuests(
  db: Db,
  partyId: string,
  maxAgeMs = STALE_GUEST_MAX_AGE_MS,
): number {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const stale = db
    .query(
      `SELECT g.id FROM guests g
       WHERE g.party_id = ?
         AND COALESCE(g.last_seen_at, g.created_at) < ?
         AND NOT EXISTS (
           SELECT 1 FROM queue_items qi
           WHERE qi.party_id = g.party_id
             AND qi.added_by_guest_id = g.id
             AND qi.from_seed = 0
         )`,
    )
    .all(partyId, cutoff) as { id: string }[];

  return deleteGuestsAndRelatedData(
    db,
    partyId,
    stale.map((row) => row.id),
  );
}

/** Remove all guests and their votes/downvotes/rate limits; queue songs stay. */
export function clearPartyGuests(db: Db, partyId: string): number {
  const countRow = db
    .query(`SELECT COUNT(*) AS count FROM guests WHERE party_id = ?`)
    .get(partyId) as { count: number };
  const count = countRow.count;
  if (count === 0) return 0;

  const guestIds = db
    .query(`SELECT id FROM guests WHERE party_id = ?`)
    .all(partyId) as { id: string }[];
  return deleteGuestsAndRelatedData(
    db,
    partyId,
    guestIds.map((row) => row.id),
  );
}

/** Remove boost flags from a guest's active queue items and restore their boost allowance. */
export function clearGuestBoost(
  db: Db,
  partyId: string,
  guestId: string,
): number {
  const result = db.run(
    `UPDATE queue_items
     SET is_boosted = 0, boost_position = NULL, boosted_by_guest_id = NULL, status = 'pending'
     WHERE party_id = ? AND added_by_guest_id = ? AND is_boosted = 1
       AND status IN ('pending', 'queued')`,
    [partyId, guestId],
  );
  return result.changes ?? 0;
}

/** Clear a guest's rate-limit counters so they can add/upvote/downvote again. */
export function resetGuestRateLimits(
  db: Db,
  partyId: string,
  guestId: string,
): { cleared: number; boostsCleared: number } {
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
  const boostsCleared = clearGuestBoost(db, partyId, guestId);

  return { cleared: before.count, boostsCleared };
}
