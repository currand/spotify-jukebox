import type { Config } from "../config";
import type { Db } from "../db/schema";
import { getActiveParty, hasActiveParty } from "./party";
import {
  adoptSpotifyTrack,
  bumpSyncGeneration,
  getQueueItems,
  getSpotifyBufferItem,
  getUpcomingPlayOrder,
  markFinished,
  type QueueItemRow,
} from "./queue";
import {
  setSpotifyRateLimitHandler,
  setSpotifyRateLimitedGate,
  trackFromSpotify,
  type PlayerSnapshot,
  type SpotifyClient,
} from "./spotify";
import type { SpotifyTrack } from "@/shared/types";
import { debugLog } from "../debug";
import {
  computeRateLimitBackoffMs,
  formatSpotifyErrorForUser,
  getSpotifyRetryAfterMs,
  isNoActiveDeviceError,
  isPlaybackRestrictionError,
  isRestrictedDeviceError,
  isSpotifyRateLimitError,
  isSpotifyReauthRequired,
} from "./spotify-errors";
import { withSpotifyCallerAsync } from "./spotify-caller";

const SYNC_INTERVAL_MS = 10_000;
const SYNC_INTERVAL_NO_PARTY_MS = 60_000;
const SYNC_MAX_SLEEP_MS = 5 * 60_000;
const SYNC_NEAR_END_MIN_MS = 1_000;

const RESTRICTED_DEVICE_HINT =
  "This device doesn't support remote playback control — use the Spotify app on your phone or computer.";

export interface PlaybackTiming {
  currentUri: string | null;
  progressMs: number | null;
  durationMs: number | null;
  isPlaying: boolean;
  capturedAt: number;
}

export interface SyncPollingConfig {
  syncFastPoll: boolean;
  syncEndWindowMs: number;
  syncFallbackIntervalMs: number;
  syncIdleIntervalMs: number;
}

export interface SyncState {
  deviceActive: boolean;
  spotifyReachable: boolean;
  deviceRestricted: boolean;
  deviceName: string | null;
  isPlaying: boolean;
  lastError: string | null;
  rateLimitedUntil: number | null;
  /** When the sync worker last refreshed player state from Spotify. */
  lastSyncedAt: number | null;
  playbackTiming: PlaybackTiming | null;
}

export interface SpotifyQueueSnapshot {
  currentlyPlaying: SpotifyTrack | null;
  queue: SpotifyTrack[];
  /** False when Spotify returned 204/404 — empty queue may mean no active device. */
  available?: boolean;
}

let syncState: SyncState = {
  deviceActive: false,
  spotifyReachable: true,
  deviceRestricted: false,
  deviceName: null,
  isPlaying: false,
  lastError: null,
  rateLimitedUntil: null,
  lastSyncedAt: null,
  playbackTiming: null,
};

const partySyncInFlight = new Map<string, Promise<void>>();
const partyLastSyncedGeneration = new Map<string, number>();
let consecutiveRateLimitHits = 0;
let syncWorkerTimer: ReturnType<typeof setTimeout> | null = null;
let syncWorkerTick: (() => void) | null = null;
let activeDeviceId: string | null = null;

let syncPollingConfig: SyncPollingConfig = {
  syncFastPoll: false,
  syncEndWindowMs: 7000,
  syncFallbackIntervalMs: 30_000,
  syncIdleIntervalMs: 60_000,
};

export function configureSyncPolling(config: SyncPollingConfig): void {
  syncPollingConfig = config;
}

function configureSyncPollingFromConfig(config: Config): void {
  configureSyncPolling({
    syncFastPoll: config.syncFastPoll,
    syncEndWindowMs: config.syncEndWindowMs,
    syncFallbackIntervalMs: config.syncFallbackIntervalMs,
    syncIdleIntervalMs: config.syncIdleIntervalMs,
  });
}

export function partyNeedsSpotifyQueueSync(
  db: Db,
  partyId: string,
  syncGeneration: number,
): boolean {
  return (partyLastSyncedGeneration.get(partyId) ?? -1) < syncGeneration;
}

export { hasActiveParty };

/** Adaptive delay between scheduled polls when not rate-limited or event-driven. */
export function computeAdaptiveSyncDelayMs(): number {
  const timing = syncState.playbackTiming;
  if (
    timing?.isPlaying &&
    timing.currentUri &&
    timing.durationMs != null &&
    timing.progressMs != null
  ) {
    const elapsed = Date.now() - timing.capturedAt;
    const remainingMs = timing.durationMs - timing.progressMs - elapsed;
    const delayMs = remainingMs - syncPollingConfig.syncEndWindowMs;
    if (delayMs <= 0) return SYNC_NEAR_END_MIN_MS;
    return Math.min(delayMs, SYNC_MAX_SLEEP_MS);
  }
  if (timing?.isPlaying) {
    return syncPollingConfig.syncFallbackIntervalMs;
  }
  return syncPollingConfig.syncIdleIntervalMs;
}

export function getSyncIntervalMs(
  db: Db,
  party: { id: string; sync_generation: number } | null,
): number {
  if (!party) return SYNC_INTERVAL_NO_PARTY_MS;
  if (syncPollingConfig.syncFastPoll) return SYNC_INTERVAL_MS;
  if (partyNeedsSpotifyQueueSync(db, party.id, party.sync_generation)) {
    return 0;
  }
  return computeAdaptiveSyncDelayMs();
}

/** Delay until the next sync tick — waits out Spotify backoff when active. */
export function getNextSyncDelayMs(
  db: Db,
  party: { id: string; sync_generation: number } | null,
): number {
  if (isRateLimited()) {
    const remainingMs = Math.max(0, (syncState.rateLimitedUntil ?? 0) - Date.now());
    return Math.max(remainingMs, 1000);
  }
  return getSyncIntervalMs(db, party);
}

export function isUriBufferedInSpotify(
  uri: string,
  queueData: SpotifyQueueSnapshot,
  items: QueueItemRow[] = [],
): boolean {
  if (queueData.currentlyPlaying?.uri === uri) {
    if (items.length > 0 && isTerminalQueueUri(items, uri)) return false;
    return true;
  }
  if (items.length > 0 && isTerminalQueueUri(items, uri)) return false;
  return queueData.queue.some((track) => track.uri === uri);
}

/**
 * Spotify pads short queues by repeating a prefix (often to ~20 entries).
 * Infer the real queue length from the shortest repeating prefix.
 */
export function inferPaddedSpotifyQueueLength(queue: SpotifyTrack[]): number {
  if (queue.length <= 1) return queue.length;
  for (
    let patternLen = 1;
    patternLen <= Math.min(4, Math.floor(queue.length / 2));
    patternLen++
  ) {
    const pattern = queue.slice(0, patternLen).map((t) => t.uri);
    let isRepeating = true;
    for (let i = patternLen; i < queue.length; i++) {
      if (queue[i]!.uri !== pattern[i % patternLen]) {
        isRepeating = false;
        break;
      }
    }
    if (isRepeating) return patternLen;
  }
  return queue.length;
}

export function dedupeSpotifyQueueTracks(
  queue: SpotifyTrack[],
  playingUri: string | null,
): SpotifyTrack[] {
  const seen = new Set<string>();
  const deduped: SpotifyTrack[] = [];
  for (const track of queue) {
    if (playingUri && track.uri === playingUri) continue;
    if (seen.has(track.uri)) continue;
    seen.add(track.uri);
    deduped.push(track);
  }
  return deduped;
}

const TERMINAL_STATUSES: QueueItemRow["status"][] = [
  "played",
  "skipped",
  "downvoted",
  "unblocked",
];

/** True when this URI already finished in the virtual queue (Spotify padding may still report it). */
export function isTerminalQueueUri(items: QueueItemRow[], uri: string): boolean {
  return items.some(
    (i) => i.spotify_uri === uri && TERMINAL_STATUSES.includes(i.status),
  );
}

/** True when this URI already played — skip stale pending duplicates, not re-queues after skip. */
export function isPlayedQueueUri(items: QueueItemRow[], uri: string): boolean {
  return items.some((i) => i.spotify_uri === uri && i.status === "played");
}

/** Prefer active managed row when duplicate URIs exist (e.g. skipped + queued). */
export function findActiveQueueItemByUri(
  items: QueueItemRow[],
  uri: string,
): QueueItemRow | undefined {
  const matching = items.filter((i) => i.spotify_uri === uri);
  if (matching.length === 0) return undefined;
  for (const status of ["playing", "queued", "pending"] as const) {
    const row = matching.find((i) => i.status === status);
    if (row) return row;
  }
  return undefined;
}

function queueItemToCurrentlyPlaying(item: QueueItemRow) {
  return {
    uri: item.spotify_uri,
    id: item.spotify_uri.split(":").pop() ?? item.spotify_uri,
    name: item.track_name,
    artists: [{ name: item.artist_name }],
    album: {
      images: item.album_art_url ? [{ url: item.album_art_url }] : [],
    },
  };
}

/** Collapse Spotify queue API padding and drop phantom buffer tracks. */
export function normalizeSpotifyQueueSnapshot(
  queueData: SpotifyQueueSnapshot,
  items: QueueItemRow[] = [],
): SpotifyQueueSnapshot {
  const raw = queueData.queue;
  if (raw.length === 0) return queueData;

  const playingUri = queueData.currentlyPlaying?.uri ?? null;
  const realLength = inferPaddedSpotifyQueueLength(raw);
  let queue = dedupeSpotifyQueueTracks(raw.slice(0, realLength), playingUri);

  const isHomogeneousPadding =
    raw.length >= 3 && new Set(raw.map((t) => t.uri)).size === 1;

  if (isHomogeneousPadding && queue.length === 1) {
    const uri = queue[0]!.uri;
    const managed = items.some(
      (i) =>
        i.spotify_uri === uri &&
        ["pending", "queued", "playing"].includes(i.status),
    );
    if (!managed) {
      queue = [];
    }
  }

  if (items.length > 0) {
    queue = queue.filter((track) => !isTerminalQueueUri(items, track.uri));
  }

  let currentlyPlaying = queueData.currentlyPlaying;
  if (currentlyPlaying?.uri && items.length > 0 && isTerminalQueueUri(items, currentlyPlaying.uri)) {
    currentlyPlaying = null;
  }

  return { ...queueData, currentlyPlaying, queue };
}

/** Whether Spotify already has a track waiting in its upcoming queue. */
export function getSpotifyBufferTrack(
  queueData: SpotifyQueueSnapshot,
  items: QueueItemRow[] = [],
): SpotifyTrack | null {
  const playingUri = queueData.currentlyPlaying?.uri;
  for (const track of queueData.queue) {
    if (playingUri && track.uri === playingUri) continue;
    if (items.length > 0 && isTerminalQueueUri(items, track.uri)) continue;
    return track;
  }
  return null;
}

export function getSpotifyQueueTailTracks(
  queueData: SpotifyQueueSnapshot,
  items: QueueItemRow[] = [],
): SpotifyTrack[] {
  const playingUri = queueData.currentlyPlaying?.uri;
  const buffer = getSpotifyBufferTrack(queueData, items);
  const skipUris = new Set<string>();
  if (playingUri) skipUris.add(playingUri);
  if (buffer?.uri) skipUris.add(buffer.uri);

  const tail: SpotifyTrack[] = [];
  const seen = new Set<string>();
  for (const track of queueData.queue) {
    if (skipUris.has(track.uri) || seen.has(track.uri)) continue;
    if (items.length > 0 && isTerminalQueueUri(items, track.uri)) continue;
    seen.add(track.uri);
    tail.push(track);
  }
  return tail;
}

export function isSpotifyBufferOccupied(
  queueData: SpotifyQueueSnapshot,
  items: QueueItemRow[] = [],
): boolean {
  if (getSpotifyBufferTrack(queueData, items) != null) return true;

  const dbQueued = items.some((item) => item.status === "queued");
  if (!dbQueued) return false;

  const apiHasQueueData =
    queueData.queue.length > 0 || queueData.currentlyPlaying != null;
  if (!apiHasQueueData) return true;

  const expectedBuffer = getSpotifyBufferItem(items);
  return expectedBuffer?.status === "queued";
}

/** @deprecated Prefer isSpotifyBufferOccupied — kept for tests inspecting jukebox URIs in Spotify. */
export function getManagedSpotifyQueueUris(
  items: QueueItemRow[],
  queueData: { queue: { uri: string }[] },
): string[] {
  const activeUris = new Set(
    items
      .filter((item) => ["pending", "queued", "playing"].includes(item.status))
      .map((item) => item.spotify_uri),
  );
  return queueData.queue
    .map((track) => track.uri)
    .filter((uri) => activeUris.has(uri));
}

/** First virtual track to send to Spotify when its buffer slot is empty. */
export function getVirtualNextToBuffer(
  items: QueueItemRow[],
  queueData: SpotifyQueueSnapshot,
): QueueItemRow | null {
  if (isSpotifyBufferOccupied(queueData, items)) {
    return null;
  }

  for (const item of getUpcomingPlayOrder(items)) {
    if (item.status === "playing" || item.status === "queued") continue;
    if (!["pending"].includes(item.status)) continue;
    if (isPlayedQueueUri(items, item.spotify_uri)) continue;
    if (isUriBufferedInSpotify(item.spotify_uri, queueData, items)) continue;
    return item;
  }
  return null;
}

/** Align `queued` with whatever Spotify reports as up next (jukebox or external). */
export function reconcileSpotifyBufferStatuses(
  db: Db,
  partyId: string,
  items: QueueItemRow[],
  queueData: SpotifyQueueSnapshot,
  options?: { aggressive?: boolean },
): void {
  const bufferTrack = getSpotifyBufferTrack(queueData, items);

  if (!bufferTrack) {
    const apiHasQueueData =
      queueData.queue.length > 0 || queueData.currentlyPlaying != null;
    if (!apiHasQueueData) {
      return;
    }
    if (!options?.aggressive) {
      const expectedBuffer = getSpotifyBufferItem(items);
      if (expectedBuffer?.status === "queued") {
        return;
      }
    }
    for (const item of items) {
      if (item.status !== "queued") continue;
      if (isUriBufferedInSpotify(item.spotify_uri, queueData, items)) continue;
      db.run(`UPDATE queue_items SET status = 'pending' WHERE id = ?`, [item.id]);
    }
    return;
  }

  const bufferId = adoptSpotifyTrack(
    db,
    partyId,
    trackFromSpotify(bufferTrack),
    "queued",
  );

  for (const item of items) {
    if (item.id === bufferId || item.status === "playing") continue;
    if (item.status === "queued") {
      db.run(`UPDATE queue_items SET status = 'pending' WHERE id = ?`, [item.id]);
    }
  }
}

/** Adopt tracks waiting deeper in Spotify's queue as locked pending rows. */
export function reconcileSpotifyQueueTail(
  db: Db,
  partyId: string,
  queueData: SpotifyQueueSnapshot,
  items: QueueItemRow[] = [],
): void {
  for (const track of getSpotifyQueueTailTracks(queueData, items)) {
    adoptSpotifyTrack(
      db,
      partyId,
      trackFromSpotify(track),
      "pending",
    );
  }
}

/** Only skip tracks the party explicitly removed (downvoted / skipped). */
export function shouldSkipTerminalPlayback(match: QueueItemRow): boolean {
  return match.status === "downvoted" || match.status === "skipped";
}

/** Resolve now playing from the player snapshot — authoritative over the queue API. */
export function currentlyPlayingFromSnapshot(
  snapshot: PlayerSnapshot,
  items: QueueItemRow[],
  queueData: SpotifyQueueSnapshot,
): SpotifyTrack | null {
  if (!snapshot.currentUri) return null;

  const active = findActiveQueueItemByUri(items, snapshot.currentUri);
  if (active) return queueItemToCurrentlyPlaying(active);

  if (isTerminalQueueUri(items, snapshot.currentUri)) {
    return null;
  }

  if (queueData.currentlyPlaying?.uri === snapshot.currentUri) {
    return queueData.currentlyPlaying;
  }

  const meta = items.find((item) => item.spotify_uri === snapshot.currentUri);
  if (meta) return queueItemToCurrentlyPlaying(meta);

  return {
    uri: snapshot.currentUri,
    id: snapshot.currentUri.split(":").pop() ?? snapshot.currentUri,
    name: "Unknown track",
    artists: [{ name: "Unknown" }],
    album: { images: [] },
  };
}

/** Merge player snapshot into queue data when the queue API omits or stale-reports now playing. */
export function buildEffectiveQueueSnapshot(
  queueData: SpotifyQueueSnapshot,
  snapshot: PlayerSnapshot,
  items: QueueItemRow[],
): SpotifyQueueSnapshot {
  if (snapshot.currentUri) {
    const fromSnapshot = currentlyPlayingFromSnapshot(snapshot, items, queueData);
    if (fromSnapshot) {
      return {
        ...queueData,
        currentlyPlaying: fromSnapshot,
      };
    }
  }

  if (queueData.currentlyPlaying?.uri) {
    return queueData;
  }

  return queueData;
}

export function getSyncState(): SyncState {
  return syncState;
}

function restrictedMessage(deviceName: string | null): string {
  if (deviceName) {
    return `${deviceName} doesn't support remote playback control — use the Spotify app on your phone or computer.`;
  }
  return RESTRICTED_DEVICE_HINT;
}

function markDeviceRestricted(deviceName: string | null): void {
  syncState = {
    ...syncState,
    spotifyReachable: true,
    deviceRestricted: true,
    deviceName: deviceName ?? syncState.deviceName,
    lastError: restrictedMessage(deviceName ?? syncState.deviceName),
  };
}

function rateLimitMessage(retryAfterMs: number): string {
  return `Spotify rate limited — retrying in ${Math.ceil(retryAfterMs / 1000)}s`;
}

function markRateLimited(error: unknown): void {
  const now = Date.now();
  const backoffActive =
    syncState.rateLimitedUntil != null && now < syncState.rateLimitedUntil;
  if (!backoffActive) {
    consecutiveRateLimitHits++;
  }
  const retryAfterMs = computeRateLimitBackoffMs(
    getSpotifyRetryAfterMs(error),
    consecutiveRateLimitHits,
  );
  const until = Date.now() + retryAfterMs;
  const rateLimitedUntil = Math.max(syncState.rateLimitedUntil ?? 0, until);
  const remainingMs = rateLimitedUntil - Date.now();
  syncState = {
    ...syncState,
    spotifyReachable: true,
    rateLimitedUntil,
    lastError: rateLimitMessage(remainingMs),
  };
  debugLog("sync", "markRateLimited", {
    consecutiveRateLimitHits,
    retryAfterMs,
    rateLimitedUntil,
    remainingMs,
  });
}

/** Apply Spotify 429 backoff from any API caller (sync worker, status poll, etc.). */
export function applySpotifyRateLimit(error: unknown): void {
  if (!isSpotifyRateLimitError(error)) return;
  markRateLimited(error);
}

function clearRateLimitIfExpired(): void {
  if (syncState.rateLimitedUntil && Date.now() >= syncState.rateLimitedUntil) {
    debugLog("sync", "rateLimitCleared", {
      wasUntil: syncState.rateLimitedUntil,
    });
    consecutiveRateLimitHits = 0;
    syncState = {
      ...syncState,
      rateLimitedUntil: null,
      lastError: syncState.deviceRestricted
        ? restrictedMessage(syncState.deviceName)
        : null,
    };
  }
}

function isRateLimited(): boolean {
  return syncState.rateLimitedUntil != null && Date.now() < syncState.rateLimitedUntil;
}

/** Whether outbound Spotify calls should be deferred (search prefetch, etc.). */
export function isSpotifyRateLimited(): boolean {
  return isRateLimited();
}

/** Remaining global Spotify backoff in ms, or null when not rate-limited. */
export function getSpotifyRateLimitRemainingMs(): number | null {
  if (!isRateLimited()) return null;
  return Math.max(0, (syncState.rateLimitedUntil ?? 0) - Date.now());
}

function applyPlayerSnapshot(snapshot: PlayerSnapshot): void {
  if (!isRateLimited()) {
    consecutiveRateLimitHits = 0;
  }
  activeDeviceId = snapshot.deviceId;
  const capturedAt = Date.now();
  syncState = {
    ...syncState,
    deviceActive: snapshot.deviceActive,
    isPlaying: snapshot.isPlaying,
    spotifyReachable: true,
    deviceRestricted: snapshot.deviceRestricted,
    deviceName: snapshot.deviceName,
    lastSyncedAt: capturedAt,
    playbackTiming: snapshot.currentUri
      ? {
          currentUri: snapshot.currentUri,
          progressMs: snapshot.progressMs,
          durationMs: snapshot.durationMs,
          isPlaying: snapshot.isPlaying,
          capturedAt,
        }
      : null,
    lastError: snapshot.deviceRestricted
      ? restrictedMessage(snapshot.deviceName)
      : isRateLimited()
        ? syncState.lastError
        : null,
  };
}

function isOpaqueSpotifyResponse(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("invalid response");
}

function isQueueControlError(error: unknown): boolean {
  return (
    isRestrictedDeviceError(error) ||
    isOpaqueSpotifyResponse(error) ||
    isNoActiveDeviceError(error)
  );
}

function handlePlayerError(e: unknown): void {
  if (isSpotifyRateLimitError(e)) {
    markRateLimited(e);
    return;
  }
  if (isSpotifyReauthRequired(e)) {
    syncState = {
      ...syncState,
      deviceActive: false,
      spotifyReachable: false,
      deviceRestricted: false,
      deviceName: null,
      isPlaying: false,
      playbackTiming: null,
      lastError:
        formatSpotifyErrorForUser(e) ??
        "Spotify authorization expired — connect Spotify again in admin.",
      rateLimitedUntil: null,
    };
    return;
  }
  syncState = {
    ...syncState,
    deviceActive: false,
    spotifyReachable: false,
    deviceRestricted: false,
    isPlaying: false,
    playbackTiming: null,
    lastError: formatSpotifyErrorForUser(e) ?? (e instanceof Error ? e.message : String(e)),
    rateLimitedUntil: null,
  };
}

/** Queue/write failures must not clear a known-good active device. */
function handleQueueSyncError(e: unknown): void {
  if (isSpotifyRateLimitError(e)) {
    markRateLimited(e);
    return;
  }
  if (isQueueControlError(e)) {
    markDeviceRestricted(syncState.deviceName);
    return;
  }
  syncState = {
    ...syncState,
    spotifyReachable: false,
    lastError:
      formatSpotifyErrorForUser(e) ?? (e instanceof Error ? e.message : String(e)),
  };
}

function wakeSyncWorker(): void {
  if (!syncWorkerTick) return;
  if (syncWorkerTimer) {
    clearTimeout(syncWorkerTimer);
    syncWorkerTimer = null;
  }
  syncWorkerTimer = setTimeout(syncWorkerTick, 0);
}

export function startSyncWorker(db: Db, spotify: SpotifyClient, config: Config): void {
  configureSyncPollingFromConfig(config);
  setSpotifyRateLimitHandler(applySpotifyRateLimit);
  setSpotifyRateLimitedGate(getSpotifyRateLimitRemainingMs);
  const tick = async () => {
    await runSyncTick(db, spotify);
    const party = getActiveParty(db);
    syncWorkerTimer = setTimeout(() => void tick(), getNextSyncDelayMs(db, party));
  };
  syncWorkerTick = () => void tick();
  void tick();
}

/** Queue a Spotify sync on the background worker — avoids duplicate API calls per mutation. */
export function requestPartySync(db: Db, partyId: string): void {
  bumpSyncGeneration(db, partyId);
  wakeSyncWorker();
}

export class PartySyncError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PartySyncError";
  }
}

export type PlaybackControlResult =
  | { ok: true }
  | { ok: false; code: string; message: string; status: 403 | 502 };

async function refreshPlayerSnapshot(
  spotify: SpotifyClient,
): Promise<PlayerSnapshot | null> {
  try {
    const snapshot = await spotify.getPlayerSnapshot();
    applyPlayerSnapshot(snapshot);
    return snapshot;
  } catch {
    return null;
  }
}

async function handlePlaybackRestriction(
  spotify: SpotifyClient,
  error: unknown,
  desiredPlaying: boolean,
  fallbackMessage: string,
): Promise<PlaybackControlResult> {
  const snapshot = await refreshPlayerSnapshot(spotify);
  if (snapshot && snapshot.isPlaying === desiredPlaying) {
    return { ok: true };
  }
  if (snapshot?.deviceRestricted) {
    return {
      ok: false,
      code: "DEVICE_RESTRICTED",
      message: restrictedMessage(snapshot.deviceName),
      status: 403,
    };
  }
  return {
    ok: false,
    code: "SPOTIFY_ERROR",
    message: formatSpotifyErrorForUser(error) ?? fallbackMessage,
    status: 502,
  };
}

/** Resume Spotify playback on the active device, recovering from stale state. */
export async function resumePartyPlayback(
  spotify: SpotifyClient,
): Promise<PlaybackControlResult> {
  try {
    await spotify.play(activeDeviceId);
    return { ok: true };
  } catch (e) {
    if (!isPlaybackRestrictionError(e)) {
      return {
        ok: false,
        code: "SPOTIFY_ERROR",
        message: formatSpotifyErrorForUser(e) ?? "Play failed",
        status: 502,
      };
    }
    return handlePlaybackRestriction(spotify, e, true, "Play failed");
  }
}

/** Pause Spotify playback on the active device, recovering from stale state. */
export async function pausePartyPlayback(
  spotify: SpotifyClient,
): Promise<PlaybackControlResult> {
  try {
    await spotify.pause(activeDeviceId);
    return { ok: true };
  } catch (e) {
    if (!isPlaybackRestrictionError(e)) {
      return {
        ok: false,
        code: "SPOTIFY_ERROR",
        message: formatSpotifyErrorForUser(e) ?? "Pause failed",
        status: 502,
      };
    }
    return handlePlaybackRestriction(spotify, e, false, "Pause failed");
  }
}

/** Force an immediate Spotify refresh for the active party (admin manual sync). */
export async function forcePartySync(
  db: Db,
  spotify: SpotifyClient,
  partyId: string,
): Promise<void> {
  return withSpotifyCallerAsync("admin", async () => {
  const party = db
    .query(`SELECT * FROM parties WHERE id = ?`)
    .get(partyId) as { id: string; sync_generation: number; status: string } | null;

  if (!party) {
    throw new PartySyncError("Party not found", "NOT_FOUND", 404);
  }
  if (party.status !== "on") {
    throw new PartySyncError("Party is off", "PARTY_OFF", 403);
  }
  if (isRateLimited()) {
    const remainingMs = (syncState.rateLimitedUntil ?? 0) - Date.now();
    throw new PartySyncError(
      rateLimitMessage(remainingMs),
      "RATE_LIMITED",
      429,
    );
  }

  const token = await spotify.getAccessToken();
  if (!token) {
    throw new PartySyncError("Spotify not connected", "SPOTIFY_DISCONNECTED", 503);
  }

  let snapshot: PlayerSnapshot;
  try {
    snapshot = await spotify.getPlayerSnapshot();
    applyPlayerSnapshot(snapshot);
  } catch (e) {
    handlePlayerError(e);
    throw new PartySyncError(
      syncState.lastError ?? "Spotify unreachable",
      "SPOTIFY_ERROR",
      503,
    );
  }

  if (isRateLimited()) {
    const remainingMs = (syncState.rateLimitedUntil ?? 0) - Date.now();
    throw new PartySyncError(
      rateLimitMessage(remainingMs),
      "RATE_LIMITED",
      429,
    );
  }

  bumpSyncGeneration(db, partyId);
  const refreshedParty = db
    .query(`SELECT id, sync_generation FROM parties WHERE id = ?`)
    .get(partyId) as { id: string; sync_generation: number };

  await withPartySyncLock(partyId, async () => {
    const items = getQueueItems(db, partyId);
    let queueData: SpotifyQueueSnapshot = {
      currentlyPlaying: null,
      queue: [],
      available: false,
    };
    try {
      queueData = await spotify.getQueue();
      queueData = normalizeSpotifyQueueSnapshot(queueData, items);
    } catch (e) {
      if (isSpotifyRateLimitError(e)) {
        markRateLimited(e);
        throw new PartySyncError(
          syncState.lastError ?? "Spotify rate limited",
          "RATE_LIMITED",
          429,
        );
      }
      if (isQueueControlError(e)) {
        markDeviceRestricted(snapshot.deviceName);
        throw new PartySyncError(
          syncState.lastError ?? "Device restricted",
          "DEVICE_RESTRICTED",
          503,
        );
      }
      throw e;
    }

    const queueConfirmed =
      queueData.available !== false ||
      queueData.queue.length > 0 ||
      queueData.currentlyPlaying != null;

    const effective = buildEffectiveQueueSnapshot(queueData, snapshot, items);

    await reconcilePlayingState(
      db,
      partyId,
      items,
      effective,
      snapshot.isPlaying,
      spotify,
      snapshot.deviceName,
    );

    if (queueConfirmed) {
      const afterPlaying = getQueueItems(db, partyId);
      reconcileSpotifyBufferStatuses(db, partyId, afterPlaying, effective, {
        aggressive: true,
      });
      reconcileSpotifyQueueTail(db, partyId, effective, afterPlaying);
    }

    if (snapshot.deviceActive || snapshot.currentUri) {
      const refreshed = getQueueItems(db, partyId);
      await fillSpotifyBufferIfEmpty(
        db,
        partyId,
        refreshed,
        spotify,
        effective,
        snapshot,
      );
    }
    partyLastSyncedGeneration.set(partyId, refreshedParty.sync_generation);
  });
  });
}

async function withPartySyncLock(
  partyId: string,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = partySyncInFlight.get(partyId) ?? Promise.resolve();
  const run = previous.then(fn);
  partySyncInFlight.set(partyId, run);
  try {
    await run;
  } finally {
    if (partySyncInFlight.get(partyId) === run) {
      partySyncInFlight.delete(partyId);
    }
  }
}

async function runSyncTick(db: Db, spotify: SpotifyClient): Promise<void> {
  return withSpotifyCallerAsync("sync", async () => {
  clearRateLimitIfExpired();

  const rateLimited = isRateLimited();
  debugLog("sync", "tick", {
    rateLimited,
    retryAfterMs: rateLimited
      ? Math.max(0, (syncState.rateLimitedUntil ?? 0) - Date.now())
      : null,
  });

  if (rateLimited) {
    const remainingMs = (syncState.rateLimitedUntil ?? 0) - Date.now();
    syncState = {
      ...syncState,
      spotifyReachable: true,
      lastError: rateLimitMessage(remainingMs),
    };
    return;
  }

  const party = getActiveParty(db);
  if (!party) {
    return;
  }

  try {
    const token = await spotify.getAccessToken();
    if (!token) {
      syncState = {
        ...syncState,
        deviceActive: false,
        spotifyReachable: false,
        deviceRestricted: false,
        deviceName: null,
        isPlaying: false,
        lastError: "Spotify not connected",
        rateLimitedUntil: null,
        playbackTiming: null,
      };
      return;
    }

    let snapshot: PlayerSnapshot;
    try {
      snapshot = await spotify.getPlayerSnapshot();
      applyPlayerSnapshot(snapshot);
      debugLog("sync", "player snapshot applied", {
        deviceActive: snapshot.deviceActive,
        isPlaying: snapshot.isPlaying,
        deviceRestricted: snapshot.deviceRestricted,
        deviceName: snapshot.deviceName,
        currentUri: snapshot.currentUri,
        rateLimited: isRateLimited(),
      });
    } catch (e) {
      handlePlayerError(e);
      return;
    }

    if (isRateLimited()) {
      return;
    }

    if (!snapshot.deviceActive && !snapshot.currentUri) return;

    try {
      await withPartySyncLock(party.id, () =>
        runPartySync(db, spotify, party, snapshot),
      );
    } catch (e) {
      handleQueueSyncError(e);
    }
  } catch (e) {
    handlePlayerError(e);
  }
  });
}

async function runPartySync(
  db: Db,
  spotify: SpotifyClient,
  party: { id: string; sync_generation: number },
  snapshot: PlayerSnapshot,
): Promise<void> {
  const items = getQueueItems(db, party.id);

  let queueData: SpotifyQueueSnapshot = {
    currentlyPlaying: null,
    queue: [],
    available: false,
  };
  let queueApiAvailable = false;

  try {
    queueData = await spotify.getQueue();
    queueData = normalizeSpotifyQueueSnapshot(queueData, items);
    queueApiAvailable = true;
    debugLog("sync", "queue fetched", {
      currentlyPlaying: queueData.currentlyPlaying?.uri ?? null,
      queueLength: queueData.queue.length,
    });
  } catch (e) {
    if (isSpotifyRateLimitError(e)) {
      markRateLimited(e);
      queueApiAvailable = false;
      debugLog("sync", "queue rate limited");
    } else if (isQueueControlError(e)) {
      markDeviceRestricted(snapshot.deviceName);
      queueApiAvailable = false;
      debugLog("sync", "queue control error", e);
    } else {
      debugLog("sync", "queue error", e);
      throw e;
    }
  }

  const effective = buildEffectiveQueueSnapshot(queueData, snapshot, items);
  const playing = items.find((item) => item.status === "playing");
  const aggressiveBuffer =
    partyNeedsSpotifyQueueSync(db, party.id, party.sync_generation) ||
    Boolean(snapshot.currentUri && playing?.spotify_uri !== snapshot.currentUri);

  await reconcilePlayingState(
    db,
    party.id,
    items,
    effective,
    snapshot.isPlaying,
    spotify,
    snapshot.deviceName,
  );

  if (!queueApiAvailable || syncState.deviceRestricted) {
    partyLastSyncedGeneration.set(party.id, party.sync_generation);
    return;
  }

  const afterPlaying = getQueueItems(db, party.id);
  reconcileSpotifyBufferStatuses(db, party.id, afterPlaying, effective, {
    aggressive: aggressiveBuffer,
  });
  reconcileSpotifyQueueTail(db, party.id, effective, afterPlaying);

  const refreshed = getQueueItems(db, party.id);
  await fillSpotifyBufferIfEmpty(
    db,
    party.id,
    refreshed,
    spotify,
    effective,
    snapshot,
  );

  partyLastSyncedGeneration.set(party.id, party.sync_generation);
}

async function skipCurrentTrack(
  spotify: SpotifyClient,
  deviceName: string | null,
): Promise<void> {
  try {
    await spotify.skipNext();
  } catch (e) {
    if (isSpotifyRateLimitError(e)) {
      markRateLimited(e);
      return;
    }
    if (isQueueControlError(e)) {
      markDeviceRestricted(deviceName);
      return;
    }
    throw e;
  }
}

/** Adopt Spotify's now playing — import external tracks when needed. */
async function reconcilePlayingState(
  db: Db,
  partyId: string,
  items: QueueItemRow[],
  queueData: SpotifyQueueSnapshot,
  isPlaying: boolean,
  spotify: SpotifyClient,
  deviceName: string | null,
): Promise<void> {
  const current = queueData.currentlyPlaying;
  const playing = items.find((i) => i.status === "playing");
  const downvotedOrSkipped = (item: QueueItemRow) =>
    item.status === "downvoted" || item.status === "skipped";

  if (!current?.uri) {
    if (!isPlaying && playing) {
      markFinished(
        db,
        playing.id,
        downvotedOrSkipped(playing) ? playing.status : "played",
      );
    }
    return;
  }

  if (playing?.spotify_uri === current.uri) {
    return;
  }

  if (playing && playing.spotify_uri !== current.uri) {
    markFinished(
      db,
      playing.id,
      downvotedOrSkipped(playing) ? playing.status : "played",
    );
  }

  const freshItems = getQueueItems(db, partyId);
  let match = findActiveQueueItemByUri(freshItems, current.uri);

  if (!match) {
    if (isTerminalQueueUri(freshItems, current.uri)) {
      return;
    }
    const id = adoptSpotifyTrack(db, partyId, trackFromSpotify(current), "playing");
    db.run(
      `UPDATE queue_items SET status = 'pending'
       WHERE party_id = ? AND status = 'playing' AND id != ?`,
      [partyId, id],
    );
    return;
  }

  if (shouldSkipTerminalPlayback(match)) {
    await skipCurrentTrack(spotify, deviceName);
    return;
  }

  if (match.status === "played") {
    await skipCurrentTrack(spotify, deviceName);
    return;
  }

  db.run(
    `UPDATE queue_items SET status = 'pending'
     WHERE party_id = ? AND status = 'playing' AND id != ?`,
    [partyId, match.id],
  );
  db.run(`UPDATE queue_items SET status = 'playing' WHERE id = ?`, [match.id]);
}

/** Fill Spotify's buffer slot from the virtual queue when empty — never replace what's waiting. */
async function fillSpotifyBufferIfEmpty(
  db: Db,
  partyId: string,
  items: QueueItemRow[],
  spotify: SpotifyClient,
  queueData: SpotifyQueueSnapshot,
  snapshot: PlayerSnapshot,
): Promise<void> {
  const bufferOccupied = isSpotifyBufferOccupied(queueData, items);
  const next = getVirtualNextToBuffer(items, queueData);

  if (bufferOccupied) {
    return;
  }

  if (!next) return;

  if (snapshot.currentUri && snapshot.currentUri === next.spotify_uri) {
    return;
  }

  if (items.some((i) => i.spotify_uri === next.spotify_uri && i.status === "queued")) {
    return;
  }

  try {
    await spotify.addToQueue(next.spotify_uri);
    db.run(`UPDATE queue_items SET status = 'queued' WHERE id = ?`, [next.id]);
  } catch (e) {
    if (isSpotifyRateLimitError(e)) {
      markRateLimited(e);
      return;
    }
    if (isQueueControlError(e)) {
      markDeviceRestricted(snapshot.deviceName);
      return;
    }
    throw e;
  }
}

/** @internal test helper */
export function resetSyncStateForTests(): void {
  if (syncWorkerTimer) {
    clearTimeout(syncWorkerTimer);
    syncWorkerTimer = null;
  }
  activeDeviceId = null;
  setSpotifyRateLimitHandler(null);
  setSpotifyRateLimitedGate(null);
  syncState = {
    deviceActive: false,
    spotifyReachable: true,
    deviceRestricted: false,
    deviceName: null,
    isPlaying: false,
    lastError: null,
    rateLimitedUntil: null,
    lastSyncedAt: null,
    playbackTiming: null,
  };
  consecutiveRateLimitHits = 0;
  partySyncInFlight.clear();
  partyLastSyncedGeneration.clear();
  syncWorkerTick = null;
  configureSyncPolling({
    syncFastPoll: false,
    syncEndWindowMs: 7000,
    syncFallbackIntervalMs: 30_000,
    syncIdleIntervalMs: 60_000,
  });
}
