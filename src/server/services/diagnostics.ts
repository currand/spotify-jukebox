import type { HostDiagnostics } from "@/shared/types";
import { DEFAULT_PARTY_SEARCH_LIMIT } from "@/shared/types";
import {
  getMetricsUptimeMs,
  getSearchMetricsSnapshot,
  getSpotifyApiMetricsSnapshot,
} from "./spotify-metrics";
import { getSearchCacheSnapshot, getPartySearchBudgetSnapshot } from "./spotify-search";
import { getSyncState } from "./sync";

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
  };
}
