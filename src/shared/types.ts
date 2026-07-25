export type PartyStatus = "on" | "off" | "archived";
export type QueueItemStatus =
  | "pending"
  | "queued"
  | "playing"
  | "played"
  | "skipped"
  | "vetoed";

export interface RateLimitConfig {
  count: number;
  windowMs: number;
}

export interface PartyRateLimits {
  add: RateLimitConfig;
  upvote: RateLimitConfig;
  veto: RateLimitConfig;
  /** Per-guest Spotify search budget */
  search: RateLimitConfig;
  /** Party-wide Spotify search budget across all guests */
  partySearch: RateLimitConfig;
}

export const DEFAULT_PARTY_SEARCH_LIMIT: RateLimitConfig = {
  count: 24,
  windowMs: 30 * 1000,
};

export const DEFAULT_RATE_LIMITS: PartyRateLimits = {
  add: { count: 3, windowMs: 20 * 60 * 1000 },
  upvote: { count: 10, windowMs: 60 * 60 * 1000 },
  veto: { count: 3, windowMs: 30 * 60 * 1000 },
  search: { count: 6, windowMs: 60 * 1000 },
  partySearch: DEFAULT_PARTY_SEARCH_LIMIT,
};

export interface ApiError {
  error: string;
  code: string;
  retryAfterMs?: number;
}

export interface TrackInfo {
  uri: string;
  id: string;
  name: string;
  artistName: string;
  albumArtUrl: string | null;
}

export interface QueueItemView {
  id: string;
  spotifyUri: string;
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  upvoteCount: number;
  vetoCount: number;
  status: QueueItemStatus;
  isBoosted: boolean;
  boostPosition: number | null;
  addedBy: string;
  addedByGuestId: string | null;
  addedAt: string;
  /** Guest UI: upvote would affect the locked next slot */
  guestUpvoteBlocked?: boolean;
  /** Guest UI: boost would affect the locked next slot */
  guestBoostBlocked?: boolean;
  /** Guest UI: veto blocked — already in Spotify buffer */
  guestVetoBlocked?: boolean;
  /** Track is canonical in Spotify's queue and cannot be reordered by guests */
  spotifyLocked?: boolean;
}

export interface PartyView {
  id: string;
  slug: string;
  name: string;
  status: PartyStatus;
  vetoThreshold: number;
  rateLimits: PartyRateLimits;
}

export interface GuestMe {
  id: string;
  displayName: string | null;
  boostUsed: boolean;
  activeSongCount?: number;
}

export interface GuestMySongView {
  id: string;
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  status: QueueItemStatus;
  isBoosted: boolean;
  upvoteCount: number;
  vetoCount: number;
  addedAt: string;
  finishedAt: string | null;
  queuePosition: string | null;
  canBoost: boolean;
  canUnboost: boolean;
  canRemove: boolean;
}

export interface GuestMySongsResponse {
  active: GuestMySongView[];
  history: GuestMySongView[];
  boostUsed: boolean;
}

export interface GuestSongAdded {
  trackName: string;
  artistName: string;
  addedAt: string;
  status: string;
}

export interface GuestAdminView {
  id: string;
  displayName: string | null;
  disabled: boolean;
  boostUsed: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  lastIp: string | null;
  upvoteCount: number;
  vetoCount: number;
  boostCount: number;
  songsAdded: GuestSongAdded[];
}

export interface SearchResult {
  tracks: TrackInfo[];
  artists: { id: string; name: string; imageUrl: string | null }[];
}

export interface HostSpotifyStatus {
  connected: boolean;
  authenticated: boolean;
  expiresAt: string | null;
  deviceActive: boolean;
  spotifyReachable: boolean;
  deviceRestricted: boolean;
  deviceName: string | null;
  lastError: string | null;
  /** Milliseconds until Spotify rate-limit backoff ends; null when not rate limited. */
  retryAfterMs: number | null;
  lastSyncedAt: number | null;
}

export interface QueueSnapshot {
  nowPlaying: QueueItemView | null;
  /** Full upcoming play order (boost lane, then normal; queued track pinned first). */
  upcomingOrder: QueueItemView[];
  upcoming: QueueItemView[];
  boostLane: QueueItemView[];
  dedupTitles: string[];
}

export interface QueueResponse extends QueueSnapshot {
  nextItemId: string | null;
  party: PartyView;
  etag: string;
}

export type HostQueueAction =
  | "force_next"
  | "move_up"
  | "move_down"
  | "reset_votes";

export interface ExportTrack {
  uri: string;
  name: string;
  artistName: string;
  albumArtUrl: string | null;
}

export interface EndedPartyExport {
  partyId: string;
  partyName: string;
  tracks: ExportTrack[];
  trackCount: number;
}

export interface SpotifyTrack {
  uri: string;
  id: string;
  name: string;
  artists: { id?: string; name: string }[];
  album: { images: { url: string }[] };
}

export interface HostDiagnosticsSearchEvent {
  at: number;
  partyId: string;
  query: string;
  source: "guest" | "host" | "prefetch";
  cacheHit: boolean;
  kind: "catalog" | "artist-tracks";
}

export interface HostDiagnosticsCacheSnapshot {
  searchQueries: {
    count: number;
    samples: Array<{
      query: string;
      trackCount: number;
      artistCount: number;
      expiresInMs: number;
    }>;
  };
  artistTracks: {
    count: number;
    samples: Array<{
      artistId: string;
      trackCount: number;
      expiresInMs: number;
    }>;
  };
  trackMetadata: {
    count: number;
  };
}

export interface HostDiagnostics {
  uptimeMs: number;
  spotifyApi: {
    total: number;
    last1m: number;
    last5m: number;
    byEndpoint: Record<string, number>;
    byEndpointLast5m: Record<string, number>;
    rateLimitCount: number;
    last429At: number | null;
  };
  search: {
    total: number;
    cacheHits: number;
    cacheMisses: number;
    prefetchCount: number;
    hitRate: number;
    recent: HostDiagnosticsSearchEvent[];
  };
  cache: HostDiagnosticsCacheSnapshot;
  sync: {
    deviceActive: boolean;
    spotifyReachable: boolean;
    deviceRestricted: boolean;
    deviceName: string | null;
    lastError: string | null;
    retryAfterMs: number | null;
    lastSyncedAt: number | null;
  };
  partySearchBudget: {
    used: number;
    limit: number;
    resetsInMs: number;
  } | null;
  /** Active process metrics session (persisted across restarts). */
  sessionId: string;
}

export type MetricsSnapshotReason = "startup" | "interval" | "rate_limit";

export interface MetricsSessionSummary {
  id: string;
  startedAt: string;
  endedAt: string | null;
  snapshotCount: number;
  rateLimitSnapshotCount: number;
  isCurrent: boolean;
}

export interface MetricsSnapshotSummary {
  id: number;
  sessionId: string;
  recordedAt: string;
  reason: MetricsSnapshotReason;
  partyId: string | null;
  rateLimitCount: number;
  apiCallsTotal: number;
  apiCallsLast5m: number;
  syncRetryAfterMs: number | null;
}
