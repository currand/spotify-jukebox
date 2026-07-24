import type { Db } from "../db/schema";
import type { GuestAdminView } from "@/shared/types";

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
