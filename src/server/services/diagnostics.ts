import type { HostDiagnostics } from "@/shared/types";
import { DEFAULT_PARTY_SEARCH_LIMIT } from "@/shared/types";
import type { Db } from "../db/schema";
import {
  getMetricsUptimeMs,
  getSearchMetricsSnapshot,
  getSpotifyApiMetricsSnapshot,
} from "./spotify-metrics";
import { getSpotifyApiBudgetSnapshot } from "./spotify-api-budget";
import { getSearchCacheSnapshot, getPartySearchBudgetSnapshot, normalizeRateLimits } from "./spotify-search";
import { getDeviceTransferRetryAfterMs, getSyncState } from "./sync";
import { getLimitHitMetricsSnapshot } from "./limit-metrics";
import { getCurrentMetricsSessionId } from "./metrics-recorder";

export interface BuildHostDiagnosticsOptions {
  dailyWarnCalls?: number | null;
}

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
  options: BuildHostDiagnosticsOptions = {},
): HostDiagnostics {
  const sync = getSyncState();
  const retryAfterMs =
    sync.rateLimitedUntil != null
      ? Math.max(0, sync.rateLimitedUntil - Date.now())
      : null;
  const apiMetrics = getSpotifyApiMetricsSnapshot();
  const dailyWarnCalls = options.dailyWarnCalls ?? null;
  const dailyWarnExceeded =
    dailyWarnCalls != null && apiMetrics.last24h >= dailyWarnCalls;

  return {
    uptimeMs: getMetricsUptimeMs(),
    spotifyApi: {
      ...apiMetrics,
      dailyWarnCalls,
      dailyWarnExceeded,
    },
    globalApiBudget: getSpotifyApiBudgetSnapshot(),
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
      deviceMismatch: sync.deviceMismatch,
      deviceTransferPending: sync.deviceTransferPending,
      targetDeviceName: sync.targetDeviceName,
      deviceTransferRetryAfterMs: getDeviceTransferRetryAfterMs(),
    },
    partySearchBudget: partyId
      ? getPartySearchBudgetSnapshot(partyId, partySearchLimit)
      : null,
    guestLimits: getLimitHitMetricsSnapshot(),
    sessionId: getCurrentMetricsSessionId(),
  };
}
