import type { HostDiagnostics } from "@/shared/types";
import { DEFAULT_PARTY_SEARCH_LIMIT } from "@/shared/types";
import type { Db } from "../db/schema";
import {
  getMetricsUptimeMs,
  getSearchMetricsSnapshot,
  getSpotifyApiMetricsSnapshot,
} from "./spotify-metrics";
import { getSearchCacheSnapshot, getPartySearchBudgetSnapshot, normalizeRateLimits } from "./spotify-search";
import { getSyncState } from "./sync";
import { getCurrentMetricsSessionId } from "./metrics-recorder";

export function getActivePartyDiagnosticsContext(db: Db): {
  partyId: string | null;
  partySearchLimit: number;
} {
  const party = db
    .query(
      `SELECT id, rate_limits FROM parties WHERE status IN ('on', 'off') ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as { id: string; rate_limits: string } | null;
  return {
    partyId: party?.id ?? null,
    partySearchLimit: party
      ? normalizeRateLimits(JSON.parse(party.rate_limits)).partySearch.count
      : DEFAULT_PARTY_SEARCH_LIMIT.count,
  };
}

export function buildHostDiagnostics(
  partyId: string | null,
  partySearchLimit = DEFAULT_PARTY_SEARCH_LIMIT.count,
): HostDiagnostics {
  const sync = getSyncState();
  const retryAfterMs =
    sync.rateLimitedUntil != null
      ? Math.max(0, sync.rateLimitedUntil - Date.now())
      : null;

  return {
    uptimeMs: getMetricsUptimeMs(),
    spotifyApi: getSpotifyApiMetricsSnapshot(),
    search: getSearchMetricsSnapshot(),
    cache: getSearchCacheSnapshot(partyId),
    sync: {
      deviceActive: sync.deviceActive,
      spotifyReachable: sync.spotifyReachable,
      deviceRestricted: sync.deviceRestricted,
      deviceName: sync.deviceName,
      lastError: sync.lastError,
      retryAfterMs,
      lastSyncedAt: sync.lastSyncedAt,
    },
    partySearchBudget: partyId
      ? getPartySearchBudgetSnapshot(partyId, partySearchLimit)
      : null,
    sessionId: getCurrentMetricsSessionId(),
  };
}
