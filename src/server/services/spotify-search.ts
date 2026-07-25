import type { PartyRateLimits, SearchResult, SpotifyTrack, TrackInfo } from "@/shared/types";
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
/** Search query results — guests repeat queries within a party but not for hours. */
export const SEARCH_CACHE_TTL_MS = 30 * 60 * 1000;
/** Artist top-tracks and artist:songs drill-down views. */
export const ARTIST_CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;
/** Track metadata (name, artist, album art) — stable and safe to reuse widely. */
export const TRACK_METADATA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Prefetch top tracks (+ song search) for the first N artists on each fresh search. */
export const ARTIST_PREFETCH_COUNT = 3;

const searchCache = new Map<string, { expiresAt: number; data: SearchResult }>();
const searchInFlight = new Map<string, Promise<SearchResult>>();
const artistTopTracksCache = new Map<
  string,
  { expiresAt: number; tracks: TrackInfo[] }
>();
const artistTopTracksInFlight = new Map<string, Promise<TrackInfo[]>>();
const trackMetadataCache = new Map<string, { expiresAt: number; track: TrackInfo }>();
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

function artistTopTracksCacheKey(partyId: string, artistId: string): string {
  return `${partyId}:artist-top:${artistId}`;
}

function mapSpotifyTrackToInfo(track: SpotifyTrack): TrackInfo {
  const info = trackFromSpotify(track);
  const mapped: TrackInfo = {
    uri: info.uri,
    id: track.id,
    name: info.name,
    artistName: info.artistName,
    albumArtUrl: info.albumArtUrl,
  };
  cacheTrackMetadata(mapped);
  return mapped;
}

function cacheTrackMetadata(track: TrackInfo): void {
  const expiresAt = Date.now() + TRACK_METADATA_CACHE_TTL_MS;
  trackMetadataCache.set(track.uri, { expiresAt, track });
  if (track.id) {
    trackMetadataCache.set(`id:${track.id}`, { expiresAt, track });
  }
}

export function getCachedTrackMetadata(uriOrId: string): TrackInfo | null {
  const direct = trackMetadataCache.get(uriOrId);
  if (direct && direct.expiresAt > Date.now()) {
    return direct.track;
  }
  const byId = trackMetadataCache.get(`id:${uriOrId.replace(/^spotify:track:/, "")}`);
  if (byId && byId.expiresAt > Date.now()) {
    return byId.track;
  }
  return null;
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

function isArtistTopTracksCached(partyId: string, artistId: string): boolean {
  const cached = artistTopTracksCache.get(artistTopTracksCacheKey(partyId, artistId));
  return Boolean(cached && cached.expiresAt > Date.now());
}

function isArtistSongSearchCached(partyId: string, artistName: string): boolean {
  const cached = searchCache.get(searchCacheKey(partyId, `artist:${artistName}`));
  return Boolean(cached && cached.expiresAt > Date.now());
}

async function loadArtistTopTracks(
  spotify: SpotifyClient,
  partyId: string,
  artistId: string,
  artistName: string,
): Promise<TrackInfo[]> {
  const key = artistTopTracksCacheKey(partyId, artistId);
  const cached = artistTopTracksCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tracks;
  }

  const inFlight = artistTopTracksInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const run = (async () => {
    const tracks = await spotify.getArtistTopTracks(artistId, artistName);
    const mapped = tracks.map(mapSpotifyTrackToInfo);
    artistTopTracksCache.set(key, {
      expiresAt: Date.now() + ARTIST_CATALOG_CACHE_TTL_MS,
      tracks: mapped,
    });
    return mapped;
  })();

  artistTopTracksInFlight.set(key, run);
  try {
    return await run;
  } finally {
    if (artistTopTracksInFlight.get(key) === run) {
      artistTopTracksInFlight.delete(key);
    }
  }
}

async function loadArtistSongSearch(
  spotify: SpotifyClient,
  partyId: string,
  artistName: string,
): Promise<TrackInfo[]> {
  const query = `artist:${artistName}`;
  const key = searchCacheKey(partyId, query);
  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data.tracks;
  }

  const inFlight = searchInFlight.get(key);
  if (inFlight) {
    return (await inFlight).tracks;
  }

  const run = (async () => {
    const tracks = await spotify.searchTracks(query, 10);
    const mapped = tracks.map(mapSpotifyTrackToInfo);
    const data: SearchResult = { tracks: mapped, artists: [] };
    searchCache.set(key, {
      expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
      data,
    });
    return data;
  })();

  searchInFlight.set(key, run);
  try {
    return (await run).tracks;
  } finally {
    if (searchInFlight.get(key) === run) {
      searchInFlight.delete(key);
    }
  }
}

/** Warm artist drill-down caches after a fresh search — does not consume guest rate limits. */
function prefetchArtistCatalogs(
  spotify: SpotifyClient,
  partyId: string,
  artists: { id: string; name: string }[],
): void {
  const targets = artists.slice(0, ARTIST_PREFETCH_COUNT);
  if (targets.length === 0) return;

  void (async () => {
    for (const artist of targets) {
      try {
        if (!isArtistTopTracksCached(partyId, artist.id)) {
          await loadArtistTopTracks(spotify, partyId, artist.id, artist.name);
        }
        if (!isArtistSongSearchCached(partyId, artist.name)) {
          await loadArtistSongSearch(spotify, partyId, artist.name);
        }
      } catch {
        /* prefetch is best-effort */
      }
    }
  })();
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
      tracks: tracks.map(mapSpotifyTrackToInfo),
      artists,
    };
    searchCache.set(key, { expiresAt: Date.now() + SEARCH_CACHE_TTL_MS, data });
    prefetchArtistCatalogs(spotify, partyId, artists);
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
  const key = artistTopTracksCacheKey(partyId, artistId);
  const cached = artistTopTracksCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tracks;
  }

  const inFlight = artistTopTracksInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  assertSearchAllowed(db, partyId, guestId, limits);
  recordSearch(db, guestId);
  return loadArtistTopTracks(spotify, partyId, artistId, artistName ?? "");
}

/** @internal test helper */
export function clearSpotifySearchCacheForTests(): void {
  searchCache.clear();
  artistTopTracksCache.clear();
  trackMetadataCache.clear();
  searchInFlight.clear();
  artistTopTracksInFlight.clear();
  partySearchBuckets.clear();
}

/** @internal test helper */
export async function prefetchArtistCatalogsForTests(
  spotify: SpotifyClient,
  partyId: string,
  artists: { id: string; name: string }[],
): Promise<void> {
  for (const artist of artists.slice(0, ARTIST_PREFETCH_COUNT)) {
    await loadArtistTopTracks(spotify, partyId, artist.id, artist.name);
    await loadArtistSongSearch(spotify, partyId, artist.name);
  }
}
