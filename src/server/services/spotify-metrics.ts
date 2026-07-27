export type SearchActivitySource = "guest" | "host" | "prefetch";

export interface SearchActivityEvent {
  at: number;
  partyId: string;
  query: string;
  source: SearchActivitySource;
  cacheHit: boolean;
  kind: "catalog" | "artist-tracks";
}

interface TimedCall {
  at: number;
  endpoint: string;
  status: number;
}

const startedAt = Date.now();
const RECENT_SEARCH_LIMIT = 50;
const RECENT_API_LIMIT = 200;
const endpointTotals = new Map<string, number>();
const apiCallLog: TimedCall[] = [];
const recentSearches: SearchActivityEvent[] = [];

let totalApiCalls = 0;
let rateLimitCount = 0;
let last429At: number | null = null;
let searchTotal = 0;
let searchCacheHits = 0;
let searchCacheMisses = 0;
let prefetchCount = 0;

export function classifySpotifyEndpoint(path: string): string {
  const base = path.split("?")[0] ?? path;
  if (base.startsWith("/search")) return "search";
  if (base.includes("/top-tracks")) return "artists.top-tracks";
  if (base.startsWith("/artists/")) return "artists.get";
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
}): void {
  const endpoint = classifySpotifyEndpoint(input.path);
  totalApiCalls += 1;
  endpointTotals.set(endpoint, (endpointTotals.get(endpoint) ?? 0) + 1);

  const at = Date.now();
  apiCallLog.push({ at, endpoint, status: input.status });
  if (apiCallLog.length > RECENT_API_LIMIT) {
    apiCallLog.splice(0, apiCallLog.length - RECENT_API_LIMIT);
  }

  if (input.status === 429) {
    rateLimitCount += 1;
    last429At = at;
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

export function getSpotifyApiMetricsSnapshot() {
  return {
    total: totalApiCalls,
    last1m: countCallsSince(60_000),
    last5m: countCallsSince(5 * 60_000),
    last24h: countCallsSince(24 * 60 * 60_000),
    byEndpoint: Object.fromEntries(endpointTotals.entries()),
    byEndpointLast5m: countCallsByEndpointSince(5 * 60_000),
    rateLimitCount,
    last429At,
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
  recentSearches.length = 0;
  totalApiCalls = 0;
  rateLimitCount = 0;
  last429At = null;
  searchTotal = 0;
  searchCacheHits = 0;
  searchCacheMisses = 0;
  prefetchCount = 0;
}
