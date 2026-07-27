import type { Db } from "../db/schema";
import type { PartyRateLimits, PartyStatus, PartyView } from "@/shared/types";
import { countActiveBoosts } from "./queue";

export interface PartyRow {
  id: string;
  slug: string;
  name: string;
  status: PartyStatus;
  veto_threshold: number;
  boost_cap: number | null;
  rate_limits: string;
  sync_generation: number;
  updated_at: string;
}

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
    vetoThreshold: party.veto_threshold,
    boostCap: party.boost_cap ?? null,
    rateLimits,
  };
}

export function getBoostCapStats(
  db: Db,
  partyId: string,
  boostCap: number | null,
): {
  boostsUsed: number;
  boostCap: number | null;
  boostsRemaining: number | null;
} {
  const boostsUsed = countActiveBoosts(db, partyId);
  return {
    boostsUsed,
    boostCap,
    boostsRemaining: boostCap != null ? Math.max(0, boostCap - boostsUsed) : null,
  };
}
