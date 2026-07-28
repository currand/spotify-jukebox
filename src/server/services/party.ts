import type { Db } from "../db/schema";
import type {
  ArchivedPartyQueueSummary,
  ArchivedPartySummary,
  PartyRateLimits,
  PartyStatus,
  PartyView,
} from "@/shared/types";
import { bumpSyncGeneration, countActiveBoosts, getPartyExportTracks } from "./queue";
import { countNamedPartyGuests } from "./guests";

export interface PartyRow {
  id: string;
  slug: string;
  name: string;
  status: PartyStatus;
  downvote_threshold: number;
  boost_cap: number | null;
  rate_limits: string;
  sync_generation: number;
  updated_at: string;
  bootstrap_playlist_id?: string | null;
  target_spotify_device_id?: string | null;
}

export class ResumePartyError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "RESUME_NOT_AVAILABLE",
  ) {
    super(message);
    this.name = "ResumePartyError";
  }
}

const EMPTY_QUEUE_SUMMARY: ArchivedPartyQueueSummary = {
  playing: 0,
  pending: 0,
  queued: 0,
  played: 0,
  skipped: 0,
  downvoted: 0,
};

export function getActiveParty(db: Db): PartyRow | null {
  return db
    .query(`SELECT * FROM parties WHERE status = 'on' LIMIT 1`)
    .get() as PartyRow | null;
}

export function hasActiveParty(db: Db): boolean {
  return getActiveParty(db) != null;
}

export function getPartyBySlug(db: Db, slug: string): PartyRow | null {
  return db
    .query(`SELECT * FROM parties WHERE slug = ? AND status != 'archived'`)
    .get(slug) as PartyRow | null;
}

export function getPartyById(db: Db, id: string): PartyRow | null {
  return db
    .query(`SELECT * FROM parties WHERE id = ? AND status != 'archived'`)
    .get(id) as PartyRow | null;
}

export function getPartyByIdIncludingArchived(db: Db, id: string): PartyRow | null {
  return db.query(`SELECT * FROM parties WHERE id = ?`).get(id) as PartyRow | null;
}

export function getArchivedPartyById(db: Db, id: string): PartyRow | null {
  const party = getPartyByIdIncludingArchived(db, id);
  return party?.status === "archived" ? party : null;
}

export function getPartyQueueSummary(
  db: Db,
  partyId: string,
): ArchivedPartyQueueSummary {
  const rows = db
    .query(
      `SELECT status, COUNT(*) as count FROM queue_items WHERE party_id = ? GROUP BY status`,
    )
    .all(partyId) as { status: string; count: number }[];

  const summary = { ...EMPTY_QUEUE_SUMMARY };
  for (const row of rows) {
    const key = row.status as keyof ArchivedPartyQueueSummary;
    if (key in summary) {
      summary[key] = row.count;
    }
  }
  return summary;
}

export function canResumeParty(db: Db, partyId: string): boolean {
  const row = db
    .query(
      `SELECT COUNT(*) as count FROM queue_items
       WHERE party_id = ? AND status IN ('pending', 'queued', 'playing')`,
    )
    .get(partyId) as { count: number };
  return row.count > 0;
}

export function softArchiveActiveParties(db: Db, now = new Date().toISOString()): void {
  db.run(
    `UPDATE parties SET status = 'archived', updated_at = ? WHERE status IN ('on', 'off')`,
    [now],
  );
}

export function listArchivedParties(db: Db, limit = 50): ArchivedPartySummary[] {
  const parties = db
    .query(
      `SELECT id, name, slug, updated_at FROM parties
       WHERE status = 'archived'
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as {
    id: string;
    name: string;
    slug: string;
    updated_at: string;
  }[];

  return parties.map((party) => {
    const queueSummary = getPartyQueueSummary(db, party.id);
    const canResume = canResumeParty(db, party.id);
    return {
      partyId: party.id,
      partyName: party.name,
      slug: party.slug,
      archivedAt: party.updated_at,
      guestCount: countNamedPartyGuests(db, party.id),
      exportTrackCount: getPartyExportTracks(db, party.id).length,
      canResume,
      queueSummary,
    };
  });
}

export function resumeParty(db: Db, partyId: string): PartyRow {
  const party = getArchivedPartyById(db, partyId);
  if (!party) {
    throw new ResumePartyError("Party not found", "NOT_FOUND");
  }
  if (!canResumeParty(db, partyId)) {
    throw new ResumePartyError(
      "Party has no resumable queue state",
      "RESUME_NOT_AVAILABLE",
    );
  }

  const now = new Date().toISOString();
  softArchiveActiveParties(db, now);
  db.run(`UPDATE parties SET status = 'off', updated_at = ? WHERE id = ?`, [
    now,
    partyId,
  ]);
  bumpSyncGeneration(db, partyId);

  const resumed = getPartyById(db, partyId);
  if (!resumed) {
    throw new ResumePartyError("Party not found after resume", "NOT_FOUND");
  }
  return resumed;
}

export function isPartyOn(party: { status: PartyStatus | string }): boolean {
  return party.status === "on";
}

export const PARTY_OFF_RESPONSE = {
  error: "Party is off",
  code: "PARTY_OFF",
} as const;

export function formatPartyView(
  party: PartyRow,
  rateLimits: PartyRateLimits,
): PartyView {
  return {
    id: party.id,
    slug: party.slug,
    name: party.name,
    status: party.status,
    downvoteThreshold: party.downvote_threshold,
    boostCap: party.boost_cap ?? null,
    rateLimits,
    spotifyDeviceId: party.target_spotify_device_id ?? null,
  };
}

export function getPartyTargetDeviceId(db: Db, partyId: string): string | null {
  const row = db
    .query(`SELECT target_spotify_device_id FROM parties WHERE id = ?`)
    .get(partyId) as { target_spotify_device_id: string | null } | null;
  return row?.target_spotify_device_id ?? null;
}

export function getBoostCapStats(
  db: Db,
  partyId: string,
  boostCap: number | null,
): {
  boostsUsed: number;
  boostsRemaining: number | null;
  boostCap: number | null;
} {
  const boostsUsed = countActiveBoosts(db, partyId);
  return {
    boostsUsed,
    boostCap,
    boostsRemaining: boostCap != null ? Math.max(0, boostCap - boostsUsed) : null,
  };
}
