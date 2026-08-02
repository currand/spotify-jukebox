export type PartyStatus = "on" | "off" | "archived";
export type QueueItemStatus =
  | "pending"
  | "queued"
  | "playing"
  | "played"
  | "skipped"
  | "downvoted"
  | "unblocked";

export interface RateLimitConfig {
  count: number;
  windowMs: number;
}

export interface PartyRateLimits {
  add: RateLimitConfig;
  upvote: RateLimitConfig;
  downvote: RateLimitConfig;
  /** Per-guest boost budget (replaces lifetime boost_used flag) */
  boost: RateLimitConfig;
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
  downvote: { count: 3, windowMs: 30 * 60 * 1000 },
  boost: { count: 2, windowMs: 10 * 60 * 1000 },
  search: { count: 5, windowMs: 60 * 1000 },
  partySearch: DEFAULT_PARTY_SEARCH_LIMIT,
};

export const DEFAULT_DOWNVOTE_THRESHOLD = 5;
export const DEFAULT_BOOST_CAP = 8;

export interface DefaultGuestLimits {
  rateLimits: PartyRateLimits;
  downvoteThreshold: number;
  boostCap: number | null;
}

export function factoryDefaultGuestLimits(): DefaultGuestLimits {
  return {
    rateLimits: DEFAULT_RATE_LIMITS,
    downvoteThreshold: DEFAULT_DOWNVOTE_THRESHOLD,
    boostCap: DEFAULT_BOOST_CAP,
  };
}

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
  durationMs?: number | null;
}

export interface QueueItemView {
  id: string;
  spotifyUri: string;
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  durationMs?: number | null;
  upvoteCount: number;
  downvoteCount: number;
  status: QueueItemStatus;
  isBoosted: boolean;
  boostPosition: number | null;
  boostedBy: string | null;
  addedBy: string;
  addedByGuestId: string | null;
  addedAt: string;
  /** Guest UI: upvote would affect the locked next slot */
  guestUpvoteBlocked?: boolean;
  /** Guest UI: boost would affect the locked next slot */
  guestBoostBlocked?: boolean;
  /** Guest UI: downvote blocked — already in Spotify buffer */
  guestDownvoteBlocked?: boolean;
  /** Guest UI: current guest already upvoted this track */
  guestHasUpvoted?: boolean;
  /** Guest UI: current guest already downvoted this track */
  guestHasDownvoted?: boolean;
  /** Track is canonical in Spotify's queue and cannot be reordered by guests */
  spotifyLocked?: boolean;
}

export interface PartyView {
  id: string;
  slug: string;
  name: string;
  status: PartyStatus;
  downvoteThreshold: number;
  boostCap: number | null;
  rateLimits: PartyRateLimits;
  /** Selected Spotify Connect device for playback (host setup). */
  spotifyDeviceId?: string | null;
}

/** Spotify Connect device for host target-player picker. */
export interface SpotifyConnectDevice {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
  compatible: boolean;
  incompatibleReason?: string;
}

export interface GuestMe {
  id: string;
  displayName: string | null;
  boostUsed: boolean;
  tutorialSeen: boolean;
  activeSongCount?: number;
  quota?: { add: number; upvote: number; downvote: number; boost: number };
}

export interface GuestMySongView {
  id: string;
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  status: QueueItemStatus;
  isBoosted: boolean;
  boostedBy: string | null;
  upvoteCount: number;
  downvoteCount: number;
  addedAt: string;
  finishedAt: string | null;
  queuePosition: string | null;
  canBoost: boolean;
  canUnboost: boolean;
  canRemove: boolean;
}

export interface GuestProfileStats {
  upvotesGiven: number;
  downvotesGiven: number;
  boostsGiven: number;
  songsAdded: number;
  songsInQueue: number;
  songsPlayed: number;
}

export interface GuestInfoResponse {
  displayName: string | null;
  quota: { add: number; upvote: number; downvote: number; boost: number };
  rateLimits: PartyRateLimits;
  stats: GuestProfileStats;
  active: GuestMySongView[];
  history: GuestMySongView[];
  boostUsed: boolean;
  boostsLeft?: number;
}

export interface GuestMySongsResponse {
  active: GuestMySongView[];
  history: GuestMySongView[];
  boostUsed: boolean;
  boostsLeft?: number;
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
  downvoteCount: number;
  boostCount: number;
  songsAdded: GuestSongAdded[];
}

export interface SearchResult {
  tracks: TrackInfo[];
  artists: { id: string; name: string; imageUrl: string | null }[];
}

/** Spotify playlist eligible as a party seed (non-empty; from GET /me/playlists). */
export interface HostSeedPlaylist {
  id: string;
  name: string;
  trackCount: number;
  imageUrl: string | null;
  description: string | null;
  ownerName: string | null;
  isPublic: boolean | null;
  collaborative: boolean;
  spotifyUrl: string | null;
}

export interface HostSpotifyStatus {
  connected: boolean;
  authenticated: boolean;
  /** When false, Connect Spotify works without entering HOST_SETUP_TOKEN. */
  hostSetupTokenRequired: boolean;
  expiresAt: string | null;
  deviceActive: boolean;
  isPlaying: boolean;
  spotifyReachable: boolean;
  deviceRestricted: boolean;
  deviceName: string | null;
  lastError: string | null;
  /** Milliseconds until Spotify rate-limit backoff ends; null when not rate limited. */
  retryAfterMs: number | null;
  /** True when playback device differs from the party target device. */
  deviceMismatch: boolean;
  /** True while sync is transferring playback to the target device. */
  deviceTransferPending: boolean;
  /** Party target Connect device name (for transfer status). */
  targetDeviceName: string | null;
  /** Milliseconds until the next device-transfer retry; null when not backing off. */
  deviceTransferRetryAfterMs: number | null;
  lastSyncedAt: number | null;
}

export interface DedupTrack {
  trackName: string;
  artistName: string;
  durationMs?: number | null;
  spotifyUri?: string;
}

export interface QueueSnapshot {
  nowPlaying: QueueItemView | null;
  /** Full upcoming play order (boost lane, then normal; queued track pinned first). */
  upcomingOrder: QueueItemView[];
  upcoming: QueueItemView[];
  boostLane: QueueItemView[];
  dedupTracks: DedupTrack[];
  nextItemId?: string | null;
}

export interface QueueResponse extends QueueSnapshot {
  nextItemId: string | null;
  party: PartyView;
  etag: string;
  boostsUsed: number;
  boostCap: number | null;
  boostsRemaining: number | null;
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

export interface ArchivedPartyQueueSummary {
  playing: number;
  pending: number;
  queued: number;
  played: number;
  skipped: number;
  downvoted: number;
}

export interface ArchivedPartySummary {
  partyId: string;
  partyName: string;
  slug: string;
  archivedAt: string;
  guestCount: number;
  exportTrackCount: number;
  canResume: boolean;
  queueSummary: ArchivedPartyQueueSummary;
}

export interface ResumedPartyView {
  id: string;
  slug: string;
  name: string;
  status: "off";
  guestCount: number;
}

export interface SpotifyTrack {
  uri: string;
  id: string;
  name: string;
  artists: { id?: string; name: string }[];
  album: { images: { url: string }[] };
  durationMs?: number | null;
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
    last24h: number;
    byEndpoint: Record<string, number>;
    byEndpointLast5m: Record<string, number>;
    byCallerLast5m: Record<string, number>;
    rateLimitCount: number;
    last429At: number | null;
    prefetchApiCalls: number;
    recentApiCalls: Array<{
      at: number;
      path: string;
      endpoint: string;
      status: number;
      elapsedMs: number;
      caller: string;
      retryAfterMs: number | null;
    }>;
    rateLimitTimeline: Array<{
      at: number;
      retryAfterMs: number;
      caller: string;
    }>;
    firstRateLimit: {
      at: number;
      outboundCallIndex: number;
      caller: string;
      path: string;
      endpoint: string;
      retryAfterMs: number;
    } | null;
    dailyWarnCalls: number | null;
    dailyWarnExceeded: boolean;
  };
  globalApiBudget: {
    used: number;
    limit: number;
    windowMs: number;
    resetsInMs: number;
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
    deviceMismatch: boolean;
    deviceTransferPending: boolean;
    targetDeviceName: string | null;
    deviceTransferRetryAfterMs: number | null;
  };
  partySearchBudget: {
    used: number;
    limit: number;
    resetsInMs: number;
  } | null;
  guestLimits: {
    total: number;
    last5m: number;
    byKindLast5m: Record<string, number>;
    byKindTotal: Record<string, number>;
  };
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
  /** Raw 10s snapshots rolled into this minute bucket (interval summaries only). */
  sampleCount?: number;
}
