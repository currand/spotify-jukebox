import type { Db } from "../db/schema";
import type { PartyRateLimits } from "@/shared/types";

export type RateLimitAction = "add" | "upvote" | "veto" | "search";

export function countRecentActions(
  db: Db,
  guestId: string,
  action: RateLimitAction,
  windowMs: number,
): number {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = db
    .query(
      `SELECT COUNT(*) as count FROM rate_limit_events
       WHERE guest_id = ? AND action = ? AND created_at >= ?`,
    )
    .get(guestId, action, since) as { count: number };
  return row.count;
}

export function recordAction(
  db: Db,
  guestId: string,
  action: RateLimitAction,
): void {
  db.run(
    `INSERT INTO rate_limit_events (guest_id, action, created_at) VALUES (?, ?, ?)`,
    [guestId, action, new Date().toISOString()],
  );
}

export function checkRateLimit(
  db: Db,
  guestId: string,
  action: RateLimitAction,
  limits: PartyRateLimits,
): { allowed: boolean; retryAfterMs?: number } {
  const config = limits[action];
  const count = countRecentActions(db, guestId, action, config.windowMs);
  if (count < config.count) {
    return { allowed: true };
  }
  const oldest = db
    .query(
      `SELECT created_at FROM rate_limit_events
       WHERE guest_id = ? AND action = ?
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(guestId, action) as { created_at: string } | null;
  const retryAfterMs = oldest
    ? Math.max(
        0,
        new Date(oldest.created_at).getTime() +
          config.windowMs -
          Date.now(),
      )
    : config.windowMs;
  return { allowed: false, retryAfterMs };
}

export function remainingQuota(
  db: Db,
  guestId: string,
  limits: PartyRateLimits,
): Record<RateLimitAction, number> {
  return {
    add: Math.max(
      0,
      limits.add.count -
        countRecentActions(db, guestId, "add", limits.add.windowMs),
    ),
    upvote: Math.max(
      0,
      limits.upvote.count -
        countRecentActions(db, guestId, "upvote", limits.upvote.windowMs),
    ),
    veto: Math.max(
      0,
      limits.veto.count -
        countRecentActions(db, guestId, "veto", limits.veto.windowMs),
    ),
    search: Math.max(
      0,
      limits.search.count -
        countRecentActions(db, guestId, "search", limits.search.windowMs),
    ),
  };
}
