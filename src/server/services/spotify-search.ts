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
import {
  getSpotifyRetryAfterMs,
  isSpotifyRateLimitError,
  MIN_SPOTIFY_BACKOFF_MS,
} from "./spotify-errors";
import { getSpotifyRateLimitRemainingMs, isSpotifyRateLimited } from "./sync";
import { withSpotifyCallerAsync } from "./spotify-caller";

export const MIN_SEARCH_QUERY_LENGTH = 3;
/** Search query results — guests repeat queries within a party but not for hours. */
export const SEARCH_CACHE_TTL_MS = 30 * 60 * 1000;
/** Cached artist drill-down (`artist:{name}` search — both UI filters share one fetch). */
export const ARTIST_TRACKS_CACHE_TTL_MS = 60 * 60 * 1000;
/** Track metadata (name, artist, album art) — stable and safe to reuse widely. */
export const TRACK_METADATA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Max catalog queries retained per party — hot queries stay, long tail evicted. */
export const SEARCH_CACHE_MAX_PER_PARTY = 60;
/** Max artist drill-down catalogs per party — popular artists stay warm. */
export const ARTIST_TRACKS_CACHE_MAX_PER_PARTY = 48;
/** Max track metadata entries — album art/titles for recently touched tracks. */
export const TRACK_METADATA_CACHE_MAX_ENTRIES = 3000;
/** Background artist catalog fetches after a fresh catalog search. */
export const ARTIST_PREFETCH_COUNT = 2;
/** Extra search pages for the dominant artist on a catalog hit (10 tracks/page). */
export const ARTIST_PREFETCH_DEEP_PAGES = 3;

export interface PrefetchArtistTarget {
  id: string;
  name: string;
  trackHits: number;
}

export function artistsToPrefetch(
  artists: { id: string; name: string }[],
  tracks: { artists: { id?: string }[] }[],
  limit = ARTIST_PREFETCH_COUNT,
): PrefetchArtistTarget[] {
  const artistNames = new Map(artists.map((artist) => [artist.id, artist.name]));
  const trackCounts = new Map<string, { name: string; count: number }>();
  for (const track of tracks) {
    for (const artist of track.artists) {
      if (!artist.id) continue;
      const current = trackCounts.get(artist.id);
      if (current) {
        current.count += 1;
      } else {
        trackCounts.set(artist.id, {
          name: artistNames.get(artist.id) ?? "Unknown",
          count: 1,
        });
      }
    }
  }

  const artistTabIds = new Set(artists.map((artist) => artist.id));
  return [...trackCounts.entries()]
    .filter(([id]) => artistTabIds.has(id))
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([id, { name, count }]) => ({ id, name, trackHits: count }));
}
const CACHE_SAMPLE_LIMIT = 12;

export type SearchCaller = "guest" | "host";
export type ArtistTrackFilter = "all" | "credited";

interface ArtistTracksCacheEntry {
  expiresAt: number;
  lastAccessedAt: number;
  /** False when populated only from catalog search seeds — still served to guests. */
  complete: boolean;
  all: TrackInfo[];
  credited: TrackInfo[];
}

interface SearchCacheEntry {
  expiresAt: number;
  lastAccessedAt: number;
  data: SearchResult;
}

interface TrackMetadataCacheEntry {
  expiresAt: number;
  lastAccessedAt: number;
  track: TrackInfo;
}

const searchCache = new Map<string, SearchCacheEntry>();
const searchInFlight = new Map<string, Promise<SearchResult>>();
const artistTracksCache = new Map<string, ArtistTracksCacheEntry>();
const artistTracksInFlight = new Map<string, Promise<ArtistTracksCacheEntry>>();
const trackMetadataCache = new Map<string, TrackMetadataCacheEntry>();
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
    boost: raw.boost ?? DEFAULT_RATE_LIMITS.boost,
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

function touchEntry(entry: { lastAccessedAt: number }): void {
  entry.lastAccessedAt = Date.now();
}

function evictLruByPrefix(
  map: Map<string, { lastAccessedAt: number }>,
  prefix: string,
  maxEntries: number,
): void {
  const live: { key: string; lastAccessedAt: number }[] = [];
  for (const [key, entry] of map.entries()) {
    if (key.startsWith(prefix)) {
      live.push({ key, lastAccessedAt: entry.lastAccessedAt });
    }
  }
  if (live.length <= maxEntries) return;
  live.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  for (let i = 0; i < live.length - maxEntries; i += 1) {
    map.delete(live[i]!.key);
  }
}

function evictTrackMetadataCache(): void {
  if (trackMetadataCache.size <= TRACK_METADATA_CACHE_MAX_ENTRIES) return;

  const canonical = new Map<string, TrackMetadataCacheEntry>();
  for (const [key, entry] of trackMetadataCache.entries()) {
    if (key.startsWith("id:")) continue;
    canonical.set(key, entry);
  }

  const sorted = [...canonical.entries()].sort(
    (a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt,
  );
  const removeCount = canonical.size - TRACK_METADATA_CACHE_MAX_ENTRIES;
  for (let i = 0; i < removeCount; i += 1) {
    const [uri, entry] = sorted[i]!;
    trackMetadataCache.delete(uri);
    if (entry.track.id) {
      trackMetadataCache.delete(`id:${entry.track.id}`);
    }
  }
}

function mergeTrackLists(primary: TrackInfo[], secondary: TrackInfo[]): TrackInfo[] {
  const seen = new Set(primary.map((track) => track.id).filter(Boolean));
  const merged = [...primary];
  for (const track of secondary) {
    if (track.id && !seen.has(track.id)) {
      seen.add(track.id);
      merged.push(track);
    }
  }
  return merged;
}

function buildArtistTracksEntry(
  artistId: string,
  rawTracks: SpotifyTrack[],
  existing?: ArtistTracksCacheEntry,
): Pick<ArtistTracksCacheEntry, "all" | "credited"> {
  const fetchedAll = rawTracks.map((track) => mapSpotifyTrackToInfo(track));
  const all = mergeTrackLists(fetchedAll, existing?.all ?? []);
  const credited = pickArtistSearchTracks(
    rawTracks.map((track) => ({
      id: track.id,
      artists: track.artists.map((artist) => ({
        id: artist.id ?? "",
      })),
    })),
    artistId,
    all.length,
  ).map((track) => {
    const match = all.find((entry) => entry.id === track.id);
    if (match) return match;
    const raw = rawTracks.find((entry) => entry.id === track.id);
    return raw ? mapSpotifyTrackToInfo(raw) : null;
  }).filter((track): track is TrackInfo => Boolean(track));

  const mergedCredited = mergeTrackLists(credited, existing?.credited ?? []);
  return { all, credited: mergedCredited };
}

function mergeArtistTracksCache(
  partyId: string,
  artistId: string,
  seededTracks: TrackInfo[],
  complete: boolean,
): ArtistTracksCacheEntry {
  const key = artistTracksCacheKey(partyId, artistId);
  const now = Date.now();
  const existing = artistTracksCache.get(key);
  const seededAll = mergeTrackLists(seededTracks, existing?.all ?? []);
  const seededCredited = seededAll.filter((track) =>
    seededTracks.some((seed) => seed.id === track.id),
  );
  const entry: ArtistTracksCacheEntry = {
    expiresAt: now + ARTIST_TRACKS_CACHE_TTL_MS,
    lastAccessedAt: now,
    complete: complete || Boolean(existing?.complete),
    all: seededAll,
    credited: mergeTrackLists(seededCredited, existing?.credited ?? []),
  };
  artistTracksCache.set(key, entry);
  evictLruByPrefix(
    artistTracksCache,
    `${partyId}:artist-tracks:`,
    ARTIST_TRACKS_CACHE_MAX_PER_PARTY,
  );
  return entry;
}

/** Seed artist catalogs from catalog track hits — no extra Spotify calls. */
export function seedArtistTracksFromCatalog(
  partyId: string,
  tracks: SpotifyTrack[],
): void {
  const byArtist = new Map<string, TrackInfo[]>();
  for (const track of tracks) {
    const info = mapSpotifyTrackToInfo(track);
    for (const artist of track.artists) {
      if (!artist.id) continue;
      const bucket = byArtist.get(artist.id) ?? [];
      if (!bucket.some((entry) => entry.id === info.id)) {
        bucket.push(info);
      }
      byArtist.set(artist.id, bucket);
    }
  }

  for (const [artistId, seededTracks] of byArtist.entries()) {
    mergeArtistTracksCache(partyId, artistId, seededTracks, false);
  }
}

function mapSpotifyTrackToInfo(track: SpotifyTrack): TrackInfo {
  const info = trackFromSpotify(track);
  const mapped: TrackInfo = {
    uri: info.uri,
    id: track.id,
    name: info.name,
    artistName: info.artistName,
    albumArtUrl: info.albumArtUrl,
    durationMs: info.durationMs,
  };
  cacheTrackMetadata(mapped);
  return mapped;
}

function cacheTrackMetadata(track: TrackInfo): void {
  const now = Date.now();
  const expiresAt = now + TRACK_METADATA_CACHE_TTL_MS;
  const existing = trackMetadataCache.get(track.uri);
  const entry: TrackMetadataCacheEntry = {
    expiresAt,
    lastAccessedAt: now,
    track,
  };
  trackMetadataCache.set(track.uri, entry);
  if (track.id) {
    trackMetadataCache.set(`id:${track.id}`, entry);
  } else if (existing?.track.id) {
    trackMetadataCache.delete(`id:${existing.track.id}`);
  }
  evictTrackMetadataCache();
}

export function getCachedTrackMetadata(uriOrId: string): TrackInfo | null {
  const direct = trackMetadataCache.get(uriOrId);
  if (direct && direct.expiresAt > Date.now()) {
    touchEntry(direct);
    return direct.track;
  }
  const byId = trackMetadataCache.get(`id:${uriOrId.replace(/^spotify:track:/, "")}`);
  if (byId && byId.expiresAt > Date.now()) {
    touchEntry(byId);
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
      count: [...trackMetadataCache.keys()].filter((key) => !key.startsWith("id:")).length,
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

function isArtistTracksComplete(partyId: string, artistId: string): boolean {
  const cached = artistTracksCache.get(artistTracksCacheKey(partyId, artistId));
  return Boolean(cached && cached.expiresAt > Date.now() && cached.complete);
}

async function fetchArtistTrackPages(
  spotify: SpotifyClient,
  artistId: string,
  artistName: string,
  pages: number,
  caller: "search" | "prefetch" = "search",
): Promise<SpotifyTrack[]> {
  const raw: SpotifyTrack[] = [];
  for (let page = 0; page < pages; page += 1) {
    const batch = await withSpotifyCallerAsync(caller, () =>
      spotify.searchArtistTracks(artistId, artistName, {
        limit: 10,
        offset: page * 10,
      }),
    );
    if (batch.length === 0) break;
    for (const track of batch) {
      raw.push({
        uri: track.uri,
        id: track.id,
        name: track.name,
        artists: track.artists,
        album: track.album,
        durationMs: track.durationMs ?? null,
      });
    }
    if (batch.length < 10) break;
  }
  return raw;
}

async function loadArtistTracks(
  spotify: SpotifyClient,
  partyId: string,
  artistId: string,
  artistName: string,
  options?: { pages?: number; caller?: "search" | "prefetch" },
): Promise<ArtistTracksCacheEntry> {
  const key = artistTracksCacheKey(partyId, artistId);
  const existing = artistTracksCache.get(key);
  if (existing && existing.expiresAt > Date.now() && existing.complete) {
    touchEntry(existing);
    return existing;
  }

  const inFlight = artistTracksInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const pages = options?.pages ?? 1;
  const caller = options?.caller ?? "search";
  const run = (async () => {
    const raw = await fetchArtistTrackPages(
      spotify,
      artistId,
      artistName,
      pages,
      caller,
    );
    const built = buildArtistTracksEntry(artistId, raw, existing);
    const now = Date.now();
    const entry: ArtistTracksCacheEntry = {
      expiresAt: now + ARTIST_TRACKS_CACHE_TTL_MS,
      lastAccessedAt: now,
      complete: true,
      all: built.all,
      credited: built.credited,
    };
    artistTracksCache.set(key, entry);
    evictLruByPrefix(
      artistTracksCache,
      `${partyId}:artist-tracks:`,
      ARTIST_TRACKS_CACHE_MAX_PER_PARTY,
    );
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
  tracks: SpotifyTrack[],
): void {
  const targets = artistsToPrefetch(artists, tracks);
  if (targets.length === 0) return;

  void (async () => {
    if (isSpotifyRateLimited()) return;

    for (const [index, artist] of targets.entries()) {
      try {
        if (isSpotifyRateLimited()) return;
        if (isArtistTracksComplete(partyId, artist.id)) continue;
        recordSearchActivity({
          partyId,
          query: artistTracksQueryLabel(artist.name, "all"),
          source: "prefetch",
          cacheHit: false,
          kind: "artist-tracks",
        });
        const pages =
          index === 0 && artist.trackHits >= 3 ? ARTIST_PREFETCH_DEEP_PAGES : 1;
        await loadArtistTracks(spotify, partyId, artist.id, artist.name, {
          pages,
          caller: "prefetch",
        });
      } catch {
        /* prefetch is best-effort */
      }
    }
  })();
}

function artistTracksQueryLabel(artistName: string, filter: ArtistTrackFilter): string {
  return `artist:${artistName} (${filter})`;
}

function scheduleArtistCatalogRefresh(
  spotify: SpotifyClient,
  partyId: string,
  artistId: string,
  artistName: string,
): void {
  if (isSpotifyRateLimited()) return;

  void loadArtistTracks(spotify, partyId, artistId, artistName, {
    pages: ARTIST_PREFETCH_DEEP_PAGES,
    caller: "prefetch",
  }).catch(() => {
    /* background refresh is best-effort */
  });
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

function spotifyRateLimitRetryAfterMs(): number {
  return getSpotifyRateLimitRemainingMs() ?? MIN_SPOTIFY_BACKOFF_MS;
}

function staleSearchCacheOrThrow(
  partyId: string,
  query: string,
  caller: SearchCaller,
  key: string,
): SearchResult {
  const stale = searchCache.get(key);
  if (stale) {
    touchEntry(stale);
    logCatalogSearch(partyId, query, caller, true);
    return stale.data;
  }
  throw new SpotifySearchRateLimitedError(spotifyRateLimitRetryAfterMs());
}

function staleArtistTracksOrThrow(
  partyId: string,
  artistId: string,
  label: string,
  caller: SearchCaller,
  filter: ArtistTrackFilter,
  key: string,
): TrackInfo[] {
  const stale = artistTracksCache.get(key);
  if (stale) {
    touchEntry(stale);
    recordSearchActivity({
      partyId,
      query: label,
      source: caller,
      cacheHit: true,
      kind: "artist-tracks",
    });
    return filter === "credited" ? stale.credited : stale.all;
  }
  throw new SpotifySearchRateLimitedError(spotifyRateLimitRetryAfterMs());
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
    touchEntry(cached);
    logCatalogSearch(partyId, trimmed, caller, true);
    return cached.data;
  }

  const inFlight = searchInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const run = (async () => {
    assertSearchAllowed(db, partyId, guestId, limits);
    if (isSpotifyRateLimited()) {
      return staleSearchCacheOrThrow(partyId, trimmed, caller, key);
    }
    let tracks: SpotifyTrack[];
    let artists: { id: string; name: string; imageUrl: string | null }[];
    try {
      const apiCaller = caller === "host" ? "admin" : "search";
      ({ tracks, artists } = await withSpotifyCallerAsync(apiCaller, () =>
        spotify.searchCatalog(trimmed, 10, 5),
      ));
    } catch (e) {
      if (isSpotifyRateLimitError(e)) {
        const stale = searchCache.get(key);
        if (stale) {
          touchEntry(stale);
          logCatalogSearch(partyId, trimmed, caller, true);
          return stale.data;
        }
        throw new SpotifySearchRateLimitedError(getSpotifyRetryAfterMs(e));
      }
      throw e;
    }
    recordSearch(db, guestId);
    logCatalogSearch(partyId, trimmed, caller, false);
    const data: SearchResult = {
      tracks: tracks.map(mapSpotifyTrackToInfo),
      artists,
    };
    const now = Date.now();
    searchCache.set(key, {
      expiresAt: now + SEARCH_CACHE_TTL_MS,
      lastAccessedAt: now,
      data,
    });
    evictLruByPrefix(searchCache, `${partyId}:`, SEARCH_CACHE_MAX_PER_PARTY);
    seedArtistTracksFromCatalog(partyId, tracks);
    prefetchArtistCatalogs(spotify, partyId, artists, tracks);
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
    touchEntry(cached);
    recordSearchActivity({
      partyId,
      query: label,
      source: caller,
      cacheHit: true,
      kind: "artist-tracks",
    });
    if (!cached.complete) {
      scheduleArtistCatalogRefresh(
        spotify,
        partyId,
        artistId,
        artistName ?? "",
      );
    }
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
  if (isSpotifyRateLimited()) {
    return staleArtistTracksOrThrow(
      partyId,
      artistId,
      label,
      caller,
      filter,
      key,
    );
  }
  let entry: ArtistTracksCacheEntry;
  try {
    entry = await loadArtistTracks(
      spotify,
      partyId,
      artistId,
      artistName ?? "",
    );
  } catch (e) {
    if (isSpotifyRateLimitError(e)) {
      const stale = artistTracksCache.get(key);
      if (stale) {
        touchEntry(stale);
        recordSearchActivity({
          partyId,
          query: label,
          source: caller,
          cacheHit: true,
          kind: "artist-tracks",
        });
        return filter === "credited" ? stale.credited : stale.all;
      }
      throw new SpotifySearchRateLimitedError(getSpotifyRetryAfterMs(e));
    }
    throw e;
  }
  return filter === "credited" ? entry.credited : entry.all;
}

/** @internal test helper */
export function seedSearchCacheForTests(
  partyId: string,
  query: string,
  data: SearchResult,
  options?: { expired?: boolean },
): void {
  const now = Date.now();
  searchCache.set(searchCacheKey(partyId, query), {
    expiresAt:
      (options?.expired ?? true)
        ? now - 1000
        : now + SEARCH_CACHE_TTL_MS,
    lastAccessedAt: now,
    data,
  });
}

/** @internal test helper */
export function seedArtistTracksCacheForTests(
  partyId: string,
  artistId: string,
  tracks: TrackInfo[],
  options?: { expired?: boolean },
): void {
  const now = Date.now();
  const entry: ArtistTracksCacheEntry = {
    expiresAt:
      (options?.expired ?? true)
        ? now - 1000
        : now + ARTIST_TRACKS_CACHE_TTL_MS,
    lastAccessedAt: now,
    complete: true,
    all: tracks,
    credited: tracks,
  };
  artistTracksCache.set(artistTracksCacheKey(partyId, artistId), entry);
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
export function getArtistTracksCacheEntryForTests(
  partyId: string,
  artistId: string,
): ArtistTracksCacheEntry | undefined {
  return artistTracksCache.get(artistTracksCacheKey(partyId, artistId));
}

/** @internal test helper */
export async function prefetchArtistCatalogsForTests(
  spotify: SpotifyClient,
  partyId: string,
  artists: { id: string; name: string }[],
  tracks: { artists: { id?: string }[] }[] = [],
): Promise<void> {
  const targets = artistsToPrefetch(artists, tracks);
  await Promise.all(
    targets.map((artist, index) => {
      const pages =
        index === 0 && artist.trackHits >= 3 ? ARTIST_PREFETCH_DEEP_PAGES : 1;
      return loadArtistTracks(spotify, partyId, artist.id, artist.name, { pages });
    }),
  );
}
