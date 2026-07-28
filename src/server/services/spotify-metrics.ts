import type { SpotifyApiCaller } from "./spotify-caller";
import { getSpotifyApiCaller } from "./spotify-caller";
import { debugLog } from "../debug";

export type SearchActivitySource = "guest" | "host" | "prefetch";

export interface FirstRateLimitEvent {
  at: number;
  outboundCallIndex: number;
  caller: SpotifyApiCaller;
  path: string;
  endpoint: string;
  retryAfterMs: number;
}

export interface SearchActivityEvent {
  at: number;
  partyId: string;
  query: string;
  source: SearchActivitySource;
  cacheHit: boolean;
  kind: "catalog" | "artist-tracks";
}

export interface SpotifyApiCallRecord {
  at: number;
  path: string;
  endpoint: string;
  status: number;
  elapsedMs: number;
  caller: SpotifyApiCaller;
  retryAfterMs: number | null;
}

export interface RateLimitTimelineEntry {
  at: number;
  retryAfterMs: number;
  caller: SpotifyApiCaller;
}

const startedAt = Date.now();
const RECENT_SEARCH_LIMIT = 50;
const RECENT_API_LIMIT = 500;
const RATE_LIMIT_TIMELINE_LIMIT = 50;
const endpointTotals = new Map<string, number>();
const apiCallLog: SpotifyApiCallRecord[] = [];
const rateLimitTimeline: RateLimitTimelineEntry[] = [];
const recentSearches: SearchActivityEvent[] = [];

let totalApiCalls = 0;
let rateLimitCount = 0;
let last429At: number | null = null;
let prefetchApiCalls = 0;
let searchTotal = 0;
let searchCacheHits = 0;
let searchCacheMisses = 0;
let prefetchCount = 0;
let firstRateLimit: FirstRateLimitEvent | null = null;

export function classifySpotifyEndpoint(path: string): string {
  const base = path.split("?")[0] ?? path;
  if (base.startsWith("/search")) return "search";
  if (base.includes("/top-tracks")) return "artists.top-tracks";
  if (base.startsWith("/artists/")) return "artists.get";
  if (base === "/me/playlists") return "playlists.list";
  if (base.startsWith("/playlists/")) return "playlists.items";
  if (base === "/me/player/queue") return "player.queue";
  if (base === "/me/player/currently-playing") return "player.currently-playing";
  if (base === "/me/player/next") return "player.skip";
  if (base.startsWith("/me/player")) return "player.state";
  return "other";
}

export function recordSpotifyApiCall(input: {
  path: string;
  status: number;
  elapsedMs: number;
  caller?: SpotifyApiCaller;
  retryAfterMs?: number | null;
}): void {
  const endpoint = classifySpotifyEndpoint(input.path);
  const caller = input.caller ?? getSpotifyApiCaller();
  totalApiCalls += 1;
  endpointTotals.set(endpoint, (endpointTotals.get(endpoint) ?? 0) + 1);
  if (caller === "prefetch") {
    prefetchApiCalls += 1;
  }

  const at = Date.now();
  const entry: SpotifyApiCallRecord = {
    at,
    path: input.path,
    endpoint,
    status: input.status,
    elapsedMs: input.elapsedMs,
    caller,
    retryAfterMs: input.retryAfterMs ?? null,
  };
  apiCallLog.push(entry);
  if (apiCallLog.length > RECENT_API_LIMIT) {
    apiCallLog.splice(0, apiCallLog.length - RECENT_API_LIMIT);
  }

  if (input.status === 429) {
    rateLimitCount += 1;
    last429At = at;
    const retryAfterMs = input.retryAfterMs ?? 5000;
    rateLimitTimeline.push({ at, retryAfterMs, caller });
    if (rateLimitTimeline.length > RATE_LIMIT_TIMELINE_LIMIT) {
      rateLimitTimeline.splice(0, rateLimitTimeline.length - RATE_LIMIT_TIMELINE_LIMIT);
    }
    if (firstRateLimit == null) {
      firstRateLimit = {
        at,
        outboundCallIndex: totalApiCalls,
        caller,
        path: input.path,
        endpoint,
        retryAfterMs,
      };
      debugLog("spotify", "first rate limit", firstRateLimit);
    }
    rateLimitListener?.();
  }
}

let rateLimitListener: (() => void) | null = null;

/** Called by metrics recorder to snapshot immediately on Spotify 429. */
export function setSpotifyRateLimitListener(listener: (() => void) | null): void {
  rateLimitListener = listener;
}

export function recordSearchActivity(event: Omit<SearchActivityEvent, "at">): void {
  searchTotal += 1;
  if (event.cacheHit) {
    searchCacheHits += 1;
  } else {
    searchCacheMisses += 1;
  }
  if (event.source === "prefetch") {
    prefetchCount += 1;
  }

  recentSearches.unshift({ ...event, at: Date.now() });
  if (recentSearches.length > RECENT_SEARCH_LIMIT) {
    recentSearches.length = RECENT_SEARCH_LIMIT;
  }
}

function countCallsSince(sinceMs: number): number {
  const cutoff = Date.now() - sinceMs;
  return apiCallLog.filter((call) => call.at >= cutoff).length;
}

function countCallsByEndpointSince(sinceMs: number): Record<string, number> {
  const cutoff = Date.now() - sinceMs;
  const counts: Record<string, number> = {};
  for (const call of apiCallLog) {
    if (call.at < cutoff) continue;
    counts[call.endpoint] = (counts[call.endpoint] ?? 0) + 1;
  }
  return counts;
}

function countCallsByCallerSince(sinceMs: number): Record<string, number> {
  const cutoff = Date.now() - sinceMs;
  const counts: Record<string, number> = {};
  for (const call of apiCallLog) {
    if (call.at < cutoff) continue;
    counts[call.caller] = (counts[call.caller] ?? 0) + 1;
  }
  return counts;
}

export function getSpotifyApiMetricsSnapshot() {
  return {
    total: totalApiCalls,
    last1m: countCallsSince(60_000),
    last5m: countCallsSince(5 * 60_000),
    last24h: countCallsSince(24 * 60 * 60_000),
    byEndpoint: Object.fromEntries(endpointTotals.entries()),
    byEndpointLast5m: countCallsByEndpointSince(5 * 60_000),
    byCallerLast5m: countCallsByCallerSince(5 * 60_000),
    rateLimitCount,
    last429At,
    prefetchApiCalls,
    recentApiCalls: apiCallLog.slice(-50).map((call) => ({ ...call })),
    rateLimitTimeline: rateLimitTimeline.map((entry) => ({ ...entry })),
    firstRateLimit: firstRateLimit ? { ...firstRateLimit } : null,
  };
}

export function getSearchMetricsSnapshot() {
  const denom = searchCacheHits + searchCacheMisses;
  return {
    total: searchTotal,
    cacheHits: searchCacheHits,
    cacheMisses: searchCacheMisses,
    prefetchCount,
    hitRate: denom > 0 ? searchCacheHits / denom : 0,
    recent: recentSearches.map((event) => ({ ...event })),
  };
}

export function getMetricsUptimeMs(): number {
  return Date.now() - startedAt;
}

/** @internal test helper */
export function clearSpotifyMetricsForTests(): void {
  endpointTotals.clear();
  apiCallLog.length = 0;
  rateLimitTimeline.length = 0;
  recentSearches.length = 0;
  totalApiCalls = 0;
  rateLimitCount = 0;
  last429At = null;
  prefetchApiCalls = 0;
  searchTotal = 0;
  searchCacheHits = 0;
  searchCacheMisses = 0;
  prefetchCount = 0;
  firstRateLimit = null;
}
