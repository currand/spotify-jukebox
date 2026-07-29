import type { Db } from "../db/schema";
import {
  factoryDefaultGuestLimits,
  type DefaultGuestLimits,
  type PartyRateLimits,
  type RateLimitConfig,
} from "@/shared/types";
import { normalizeRateLimits } from "./spotify-search";

export const DEFAULT_RATE_LIMITS_KEY = "default_rate_limits";

function isValidRateLimitConfig(value: unknown): value is RateLimitConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as RateLimitConfig;
  return (
    Number.isInteger(config.count) &&
    config.count >= 1 &&
    Number.isInteger(config.windowMs) &&
    config.windowMs >= 1000
  );
}

export function isValidPartyRateLimits(value: unknown): value is PartyRateLimits {
  if (!value || typeof value !== "object") return false;
  const limits = value as PartyRateLimits;
  return (
    isValidRateLimitConfig(limits.add) &&
    isValidRateLimitConfig(limits.upvote) &&
    isValidRateLimitConfig(limits.downvote) &&
    isValidRateLimitConfig(limits.boost) &&
    isValidRateLimitConfig(limits.search) &&
    isValidRateLimitConfig(limits.partySearch)
  );
}

export function isValidDownvoteThreshold(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 20;
}

export function isValidBoostCap(value: unknown): value is number | null {
  if (value == null) return true;
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 99;
}

function parseStoredGuestLimits(raw: unknown): DefaultGuestLimits | null {
  if (!raw || typeof raw !== "object") return null;

  if (isValidPartyRateLimits(raw)) {
    const base = factoryDefaultGuestLimits();
    return { ...base, rateLimits: normalizeRateLimits(raw) };
  }

  const stored = raw as Partial<DefaultGuestLimits>;
  if (!isValidPartyRateLimits(stored.rateLimits)) return null;
  if (!isValidDownvoteThreshold(stored.downvoteThreshold)) return null;
  if (!isValidBoostCap(stored.boostCap ?? null)) return null;

  return {
    rateLimits: normalizeRateLimits(stored.rateLimits),
    downvoteThreshold: stored.downvoteThreshold!,
    boostCap: stored.boostCap ?? null,
  };
}

function readStoredGuestLimits(db: Db): DefaultGuestLimits | null {
  const row = db
    .query(`SELECT value FROM host_settings WHERE key = ?`)
    .get(DEFAULT_RATE_LIMITS_KEY) as { value: string } | null;
  if (!row) return null;
  try {
    return parseStoredGuestLimits(JSON.parse(row.value));
  } catch {
    return null;
  }
}

export function getDefaultGuestLimits(db: Db): DefaultGuestLimits {
  return readStoredGuestLimits(db) ?? factoryDefaultGuestLimits();
}

export function getDefaultRateLimits(db: Db): PartyRateLimits {
  return getDefaultGuestLimits(db).rateLimits;
}

export function setDefaultGuestLimits(
  db: Db,
  limits: DefaultGuestLimits,
): DefaultGuestLimits {
  const normalized: DefaultGuestLimits = {
    rateLimits: normalizeRateLimits(limits.rateLimits),
    downvoteThreshold: limits.downvoteThreshold,
    boostCap: limits.boostCap ?? null,
  };
  if (
    !isValidPartyRateLimits(normalized.rateLimits) ||
    !isValidDownvoteThreshold(normalized.downvoteThreshold) ||
    !isValidBoostCap(normalized.boostCap)
  ) {
    throw new InvalidDefaultRateLimitsError();
  }
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO host_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [DEFAULT_RATE_LIMITS_KEY, JSON.stringify(normalized), now],
  );
  return normalized;
}

/** @deprecated use setDefaultGuestLimits */
export function setDefaultRateLimits(db: Db, limits: PartyRateLimits): PartyRateLimits {
  const base = readStoredGuestLimits(db) ?? factoryDefaultGuestLimits();
  return setDefaultGuestLimits(db, { ...base, rateLimits: limits }).rateLimits;
}

export class InvalidDefaultRateLimitsError extends Error {
  constructor() {
    super("Invalid guest limits");
    this.name = "InvalidDefaultRateLimitsError";
  }
}
