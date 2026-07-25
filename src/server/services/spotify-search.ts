import type { HostDiagnosticsCacheSnapshot, PartyRateLimits, SearchResult, SpotifyTrack, TrackInfo } from "@/shared/types";
import { DEFAULT_PARTY_SEARCH_LIMIT, DEFAULT_RATE_LIMITS } from "@/shared/types";
import type { Db } from "../db/schema";
import {
  checkRateLimit,
  recordAction,
  type RateLimitAction,
} from "./rate-limit";
import { recordSearchActivity } from "./spotify-metrics";
import {
  pickArtistSearchTracks,
  trackFromSpotify,
  type SpotifyClient,
} from "./spotify";

export const MIN_SEARCH_QUERY_LENGTH = 3;
/** Search query results — guests repeat queries within a party but not for hours. */
export const SEARCH_CACHE_TTL_MS = 30 * 60 * 1000;
/** Cached artist drill-down (`artist:{name}` search — both UI filters share one fetch). */
export const ARTIST_TRACKS_CACHE_TTL_MS = 60 * 60 * 1000;
/** Track metadata (name, artist, album art) — stable and safe to reuse widely. */
export const TRACK_METADATA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Prefetch artist track search for the first N artists on each fresh catalog search. */
export const ARTIST_PREFETCH_COUNT = 3;
const CACHE_SAMPLE_LIMIT = 12;

export type SearchCaller = "guest" | "host";
export type ArtistTrackFilter = "all" | "credited";

interface ArtistTracksCacheEntry {
  expiresAt: number;
  all: TrackInfo[];
  credited: TrackInfo[];
}

const searchCache = new Map<string, { expiresAt: number; data: SearchResult }>();
const searchInFlight = new Map<string, Promise<SearchResult>>();
const artistTracksCache = new Map<string, ArtistTracksCacheEntry>();
const artistTracksInFlight = new Map<string, Promise<ArtistTracksCacheEntry>>();
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

function artistTracksCacheKey(partyId: string, artistId: string): string {
  return `${partyId}:artist-tracks:${artistId}`;
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

/** Store track metadata from any Spotify response (playlist import, search, etc.). */
export function cacheSpotifyTracksMetadata(tracks: SpotifyTrack[]): void {
  for (const track of tracks) {
    mapSpotifyTrackToInfo(track);
  }
}

function parseSearchCacheKey(key: string): { partyId: string; query: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  return { partyId: key.slice(0, idx), query: key.slice(idx + 1) };
}

function countLiveEntries<T extends { expiresAt: number }>(map: Map<string, T>): number {
  const now = Date.now();
  let count = 0;
  for (const entry of map.values()) {
    if (entry.expiresAt > now) count += 1;
  }
  return count;
}

export function getPartySearchBudgetSnapshot(
  partyId: string,
  limit: number,
): { used: number; limit: number; resetsInMs: number } {
  const bucket = partySearchBuckets.get(partyId);
  if (!bucket) {
    return { used: 0, limit, resetsInMs: 0 };
  }
  const now = Date.now();
  if (now >= bucket.resetAt) {
    return { used: 0, limit, resetsInMs: 0 };
  }
  return {
    used: bucket.count,
    limit,
    resetsInMs: Math.max(0, bucket.resetAt - now),
  };
}

export function getSearchCacheSnapshot(
  partyId: string | null,
): HostDiagnosticsCacheSnapshot {
  const now = Date.now();
  const searchSamples: HostDiagnosticsCacheSnapshot["searchQueries"]["samples"] = [];
  for (const [key, entry] of searchCache.entries()) {
    if (entry.expiresAt <= now) continue;
    const parsed = parseSearchCacheKey(key);
    if (!parsed) continue;
    if (partyId && parsed.partyId !== partyId) continue;
    searchSamples.push({
      query: parsed.query,
      trackCount: entry.data.tracks.length,
      artistCount: entry.data.artists.length,
      expiresInMs: entry.expiresAt - now,
    });
    if (searchSamples.length >= CACHE_SAMPLE_LIMIT) break;
  }

  const artistSamples: HostDiagnosticsCacheSnapshot["artistTracks"]["samples"] = [];
  for (const [key, entry] of artistTracksCache.entries()) {
    if (entry.expiresAt <= now) continue;
    if (partyId && !key.startsWith(`${partyId}:artist-tracks:`)) continue;
    artistSamples.push({
      artistId: partyId ? key.slice(`${partyId}:artist-tracks:`.length) : key.split(":artist-tracks:")[1] ?? key,
      trackCount: entry.all.length,
      expiresInMs: entry.expiresAt - now,
    });
    if (artistSamples.length >= CACHE_SAMPLE_LIMIT) break;
  }

  return {
    searchQueries: {
      count: countLiveEntries(searchCache),
      samples: searchSamples,
    },
    artistTracks: {
      count: countLiveEntries(artistTracksCache),
      samples: artistSamples,
    },
    trackMetadata: {
      count: countLiveEntries(trackMetadataCache),
    },
  };
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

function isArtistTracksCached(partyId: string, artistId: string): boolean {
  const cached = artistTracksCache.get(artistTracksCacheKey(partyId, artistId));
  return Boolean(cached && cached.expiresAt > Date.now());
}

function artistTracksQueryLabel(artistName: string, filter: ArtistTrackFilter): string {
  return `artist:${artistName} (${filter})`;
}

async function loadArtistTracks(
  spotify: SpotifyClient,
  partyId: string,
  artistId: string,
  artistName: string,
): Promise<ArtistTracksCacheEntry> {
  const key = artistTracksCacheKey(partyId, artistId);
  const cached = artistTracksCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  const inFlight = artistTracksInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const run = (async () => {
    const raw = await spotify.searchArtistTracks(artistId, artistName);
    const all = raw.map((track) =>
      mapSpotifyTrackToInfo({
        uri: track.uri,
        id: track.id,
        name: track.name,
        artists: track.artists,
        album: track.album,
      }),
    );
    const credited = pickArtistSearchTracks(raw, artistId).map((track) =>
      mapSpotifyTrackToInfo({
        uri: track.uri,
        id: track.id,
        name: track.name,
        artists: track.artists,
        album: track.album,
      }),
    );
    const entry: ArtistTracksCacheEntry = {
      expiresAt: Date.now() + ARTIST_TRACKS_CACHE_TTL_MS,
      all,
      credited,
    };
    artistTracksCache.set(key, entry);
    return entry;
  })();

  artistTracksInFlight.set(key, run);
  try {
    return await run;
  } finally {
    if (artistTracksInFlight.get(key) === run) {
      artistTracksInFlight.delete(key);
    }
  }
}

/** Warm artist track search after a fresh catalog search — does not consume guest rate limits. */
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
        if (!isArtistTracksCached(partyId, artist.id)) {
          recordSearchActivity({
            partyId,
            query: artistTracksQueryLabel(artist.name, "all"),
            source: "prefetch",
            cacheHit: false,
            kind: "artist-tracks",
          });
          await loadArtistTracks(spotify, partyId, artist.id, artist.name);
        }
      } catch {
        /* prefetch is best-effort */
      }
    }
  })();
}

function logCatalogSearch(
  partyId: string,
  query: string,
  caller: SearchCaller,
  cacheHit: boolean,
): void {
  recordSearchActivity({
    partyId,
    query,
    source: caller,
    cacheHit,
    kind: "catalog",
  });
}

export async function searchPartyCatalog(
  spotify: SpotifyClient,
  db: Db,
  partyId: string,
  query: string,
  guestId: string | null,
  limits: PartyRateLimits,
  caller: SearchCaller = guestId ? "guest" : "host",
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
    logCatalogSearch(partyId, trimmed, caller, true);
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
    logCatalogSearch(partyId, trimmed, caller, false);
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

export async function getPartyArtistTracks(
  spotify: SpotifyClient,
  db: Db,
  partyId: string,
  artistId: string,
  artistName: string | undefined,
  filter: ArtistTrackFilter,
  guestId: string | null,
  limits: PartyRateLimits,
  caller: SearchCaller = guestId ? "guest" : "host",
): Promise<TrackInfo[]> {
  const label = artistTracksQueryLabel(artistName ?? artistId, filter);
  const key = artistTracksCacheKey(partyId, artistId);
  const cached = artistTracksCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    recordSearchActivity({
      partyId,
      query: label,
      source: caller,
      cacheHit: true,
      kind: "artist-tracks",
    });
    return filter === "credited" ? cached.credited : cached.all;
  }

  const inFlight = artistTracksInFlight.get(key);
  if (inFlight) {
    const entry = await inFlight;
    return filter === "credited" ? entry.credited : entry.all;
  }

  assertSearchAllowed(db, partyId, guestId, limits);
  recordSearch(db, guestId);
  recordSearchActivity({
    partyId,
    query: label,
    source: caller,
    cacheHit: false,
    kind: "artist-tracks",
  });
  const entry = await loadArtistTracks(
    spotify,
    partyId,
    artistId,
    artistName ?? "",
  );
  return filter === "credited" ? entry.credited : entry.all;
}

/** @internal test helper */
export function clearSpotifySearchCacheForTests(): void {
  searchCache.clear();
  artistTracksCache.clear();
  trackMetadataCache.clear();
  searchInFlight.clear();
  artistTracksInFlight.clear();
  partySearchBuckets.clear();
}

/** @internal test helper */
export async function prefetchArtistCatalogsForTests(
  spotify: SpotifyClient,
  partyId: string,
  artists: { id: string; name: string }[],
): Promise<void> {
  for (const artist of artists.slice(0, ARTIST_PREFETCH_COUNT)) {
    await loadArtistTracks(spotify, partyId, artist.id, artist.name);
  }
}
