import type { PartyRateLimits, SearchResult, TrackInfo } from "@/shared/types";
import { DEFAULT_PARTY_SEARCH_LIMIT, DEFAULT_RATE_LIMITS } from "@/shared/types";
import type { Db } from "../db/schema";
import {
  checkRateLimit,
  recordAction,
  type RateLimitAction,
} from "./rate-limit";
import type { SpotifyClient } from "./spotify";
import { trackFromSpotify } from "./spotify";

export const MIN_SEARCH_QUERY_LENGTH = 3;
/** Same query at a party rarely changes — reuse results to spare Spotify search quota. */
export const SEARCH_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

const searchCache = new Map<string, { expiresAt: number; data: SearchResult }>();
const searchInFlight = new Map<string, Promise<SearchResult>>();
const artistCache = new Map<
  string,
  { expiresAt: number; tracks: TrackInfo[] }
>();
const artistInFlight = new Map<string, Promise<TrackInfo[]>>();
const partySearchBuckets = new Map<string, { count: number; resetAt: number }>();

export class SpotifySearchRateLimitedError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("Search rate limited");
    this.name = "SpotifySearchRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function normalizeRateLimits(raw: PartyRateLimits): PartyRateLimits {
  return {
    add: raw.add ?? DEFAULT_RATE_LIMITS.add,
    upvote: raw.upvote ?? DEFAULT_RATE_LIMITS.upvote,
    veto: raw.veto ?? DEFAULT_RATE_LIMITS.veto,
    search: raw.search ?? DEFAULT_RATE_LIMITS.search,
    partySearch: raw.partySearch ?? DEFAULT_PARTY_SEARCH_LIMIT,
  };
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function searchCacheKey(partyId: string, query: string): string {
  return `${partyId}:${normalizeQuery(query)}`;
}

function checkPartySearchLimit(
  partyId: string,
  limit: { count: number; windowMs: number },
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const key = partyId;
  const bucket = partySearchBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    partySearchBuckets.set(key, { count: 1, resetAt: now + limit.windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (bucket.count >= limit.count) {
    return { allowed: false, retryAfterMs: Math.max(0, bucket.resetAt - now) };
  }
  bucket.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}

function assertSearchAllowed(
  db: Db,
  partyId: string,
  guestId: string | null,
  limits: PartyRateLimits,
): void {
  const normalized = normalizeRateLimits(limits);
  const partyRl = checkPartySearchLimit(partyId, normalized.partySearch);
  if (!partyRl.allowed) {
    throw new SpotifySearchRateLimitedError(partyRl.retryAfterMs);
  }
  if (guestId) {
    const guestRl = checkRateLimit(
      db,
      guestId,
      "search" as RateLimitAction,
      normalized,
    );
    if (!guestRl.allowed) {
      throw new SpotifySearchRateLimitedError(guestRl.retryAfterMs ?? 0);
    }
  }
}

function recordSearch(db: Db, guestId: string | null): void {
  if (guestId) {
    recordAction(db, guestId, "search" as RateLimitAction);
  }
}

export async function searchPartyCatalog(
  spotify: SpotifyClient,
  db: Db,
  partyId: string,
  query: string,
  guestId: string | null,
  limits: PartyRateLimits,
): Promise<SearchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { tracks: [], artists: [] };
  }
  if (trimmed.length < MIN_SEARCH_QUERY_LENGTH) {
    return { tracks: [], artists: [] };
  }

  const key = searchCacheKey(partyId, trimmed);
  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const inFlight = searchInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const run = (async () => {
    assertSearchAllowed(db, partyId, guestId, limits);
    const [tracks, artists] = await Promise.all([
      spotify.searchTracks(trimmed, 10),
      spotify.searchArtists(trimmed, 5),
    ]);
    recordSearch(db, guestId);
    const data: SearchResult = {
      tracks: tracks.map((t) => {
        const info = trackFromSpotify(t);
        return {
          uri: info.uri,
          id: t.id,
          name: info.name,
          artistName: info.artistName,
          albumArtUrl: info.albumArtUrl,
        };
      }),
      artists,
    };
    searchCache.set(key, { expiresAt: Date.now() + SEARCH_CACHE_TTL_MS, data });
    return data;
  })();

  searchInFlight.set(key, run);
  try {
    return await run;
  } finally {
    if (searchInFlight.get(key) === run) {
      searchInFlight.delete(key);
    }
  }
}

export async function getPartyArtistTopTracks(
  spotify: SpotifyClient,
  db: Db,
  partyId: string,
  artistId: string,
  artistName: string | undefined,
  guestId: string | null,
  limits: PartyRateLimits,
): Promise<TrackInfo[]> {
  const key = `${partyId}:artist:${artistId}:${normalizeQuery(artistName ?? "")}`;
  const cached = artistCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tracks;
  }

  const inFlight = artistInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const run = (async () => {
    assertSearchAllowed(db, partyId, guestId, limits);
    const tracks = await spotify.getArtistTopTracks(artistId, artistName);
    recordSearch(db, guestId);
    const mapped = tracks.map((t) => {
      const info = trackFromSpotify(t);
      return {
        uri: info.uri,
        id: t.id,
        name: info.name,
        artistName: info.artistName,
        albumArtUrl: info.albumArtUrl,
      };
    });
    artistCache.set(key, {
      expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
      tracks: mapped,
    });
    return mapped;
  })();

  artistInFlight.set(key, run);
  try {
    return await run;
  } finally {
    if (artistInFlight.get(key) === run) {
      artistInFlight.delete(key);
    }
  }
}

/** @internal test helper */
export function clearSpotifySearchCacheForTests(): void {
  searchCache.clear();
  artistCache.clear();
  searchInFlight.clear();
  artistInFlight.clear();
  partySearchBuckets.clear();
}
