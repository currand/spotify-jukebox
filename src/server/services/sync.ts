import type { Db } from "../db/schema";
import {
  adoptSpotifyTrack,
  bumpSyncGeneration,
  getQueueItems,
  getUpcomingPlayOrder,
  markFinished,
  type QueueItemRow,
} from "./queue";
import { trackFromSpotify, type PlayerSnapshot, type SpotifyClient } from "./spotify";
import type { SpotifyTrack } from "@/shared/types";
import { debugLog } from "../debug";
import {
  computeRateLimitBackoffMs,
  formatSpotifyErrorForUser,
  getSpotifyRetryAfterMs,
  isNoActiveDeviceError,
  isRestrictedDeviceError,
  isSpotifyRateLimitError,
  isSpotifyReauthRequired,
} from "./spotify-errors";

const SYNC_INTERVAL_ACTIVE_MS = 5000;
const SYNC_INTERVAL_IDLE_MS = 20000;

const RESTRICTED_DEVICE_HINT =
  "This device doesn't support Spotify's queue API — use the Spotify app on your phone or computer.";

export interface SyncState {
  deviceActive: boolean;
  spotifyReachable: boolean;
  deviceRestricted: boolean;
  deviceName: string | null;
  lastError: string | null;
  rateLimitedUntil: number | null;
  /** When the sync worker last refreshed player state from Spotify. */
  lastSyncedAt: number | null;
}

export interface SpotifyQueueSnapshot {
  currentlyPlaying: SpotifyTrack | null;
  queue: SpotifyTrack[];
}

let syncState: SyncState = {
  deviceActive: false,
  spotifyReachable: true,
  deviceRestricted: false,
  deviceName: null,
  lastError: null,
  rateLimitedUntil: null,
  lastSyncedAt: null,
};

const partySyncInFlight = new Map<string, Promise<void>>();
const partyLastSyncedGeneration = new Map<string, number>();
let consecutiveRateLimitHits = 0;
let syncWorkerTimer: ReturnType<typeof setTimeout> | null = null;

export function partyNeedsSpotifyQueueSync(
  db: Db,
  partyId: string,
  syncGeneration: number,
): boolean {
  return (partyLastSyncedGeneration.get(partyId) ?? -1) < syncGeneration;
}

export function partyHasPendingBufferWork(db: Db, partyId: string): boolean {
  return getQueueItems(db, partyId).some((item) => item.status === "pending");
}

export function getSyncIntervalMs(
  db: Db,
  party: { id: string; sync_generation: number } | null,
): number {
  if (!party) return SYNC_INTERVAL_IDLE_MS;
  if (partyNeedsSpotifyQueueSync(db, party.id, party.sync_generation)) {
    return SYNC_INTERVAL_ACTIVE_MS;
  }
  if (partyHasPendingBufferWork(db, party.id)) {
    return SYNC_INTERVAL_ACTIVE_MS;
  }
  return SYNC_INTERVAL_IDLE_MS;
}

export function isUriBufferedInSpotify(
  uri: string,
  queueData: SpotifyQueueSnapshot,
): boolean {
  if (queueData.currentlyPlaying?.uri === uri) return true;
  return queueData.queue.some((track) => track.uri === uri);
}

/** Whether Spotify already has a track waiting in its upcoming queue. */
export function isSpotifyBufferOccupied(queueData: SpotifyQueueSnapshot): boolean {
  return queueData.queue.length > 0;
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
  if (isSpotifyBufferOccupied(queueData)) {
    return null;
  }

  for (const item of getUpcomingPlayOrder(items)) {
    if (item.status === "playing" || item.status === "queued") continue;
    if (!["pending"].includes(item.status)) continue;
    if (isUriBufferedInSpotify(item.spotify_uri, queueData)) continue;
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
): void {
  const bufferTrack = queueData.queue[0] ?? null;

  if (!bufferTrack) {
    for (const item of items) {
      if (item.status === "queued") {
        db.run(`UPDATE queue_items SET status = 'pending' WHERE id = ?`, [item.id]);
      }
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

/** Only skip tracks the party explicitly removed (vetoed / skipped). */
export function shouldSkipTerminalPlayback(match: QueueItemRow): boolean {
  return match.status === "vetoed" || match.status === "skipped";
}

/** Merge player snapshot into queue data when the queue API omits now playing. */
export function buildEffectiveQueueSnapshot(
  queueData: SpotifyQueueSnapshot,
  snapshot: PlayerSnapshot,
  items: QueueItemRow[],
): SpotifyQueueSnapshot {
  if (queueData.currentlyPlaying?.uri) {
    return queueData;
  }

  const uri = snapshot.currentUri;
  if (!uri) {
    return queueData;
  }

  const match = items.find((item) => item.spotify_uri === uri);
  if (!match) {
    return queueData;
  }

  return {
    ...queueData,
    currentlyPlaying: {
      uri: match.spotify_uri,
      id: match.spotify_uri.split(":").pop() ?? match.spotify_uri,
      name: match.track_name,
      artists: [{ name: match.artist_name }],
      album: {
        images: match.album_art_url ? [{ url: match.album_art_url }] : [],
      },
    },
  };
}

export function getSyncState(): SyncState {
  return syncState;
}

function restrictedMessage(deviceName: string | null): string {
  if (deviceName) {
    return `${deviceName} doesn't support Spotify's queue API — use the Spotify app on your phone or computer.`;
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
  consecutiveRateLimitHits++;
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
}

/** Apply Spotify 429 backoff from any API caller (sync worker, status poll, etc.). */
export function applySpotifyRateLimit(error: unknown): void {
  if (!isSpotifyRateLimitError(error)) return;
  markRateLimited(error);
}

function clearRateLimitIfExpired(): void {
  if (syncState.rateLimitedUntil && Date.now() >= syncState.rateLimitedUntil) {
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

function applyPlayerSnapshot(snapshot: PlayerSnapshot): void {
  if (!isRateLimited()) {
    consecutiveRateLimitHits = 0;
  }
  syncState = {
    ...syncState,
    deviceActive: snapshot.deviceActive,
    spotifyReachable: true,
    deviceRestricted: snapshot.deviceRestricted,
    deviceName: snapshot.deviceName,
    lastSyncedAt: Date.now(),
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
      deviceActive: false,
      spotifyReachable: false,
      deviceRestricted: false,
      deviceName: null,
      lastError:
        formatSpotifyErrorForUser(e) ??
        "Spotify authorization expired — connect Spotify again in admin.",
      rateLimitedUntil: null,
      lastSyncedAt: syncState.lastSyncedAt,
    };
    return;
  }
  syncState = {
    deviceActive: false,
    spotifyReachable: false,
    deviceRestricted: false,
    deviceName: syncState.deviceName,
    lastError: formatSpotifyErrorForUser(e) ?? (e instanceof Error ? e.message : String(e)),
    rateLimitedUntil: null,
    lastSyncedAt: syncState.lastSyncedAt,
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

export function startSyncWorker(db: Db, spotify: SpotifyClient): void {
  const tick = async () => {
    await runSyncTick(db, spotify);
    const party = db
      .query(`SELECT id, sync_generation FROM parties WHERE status = 'on' LIMIT 1`)
      .get() as { id: string; sync_generation: number } | null;
    syncWorkerTimer = setTimeout(() => void tick(), getSyncIntervalMs(db, party));
  };
  void tick();
}

/** Queue a Spotify sync on the background worker — avoids duplicate API calls per mutation. */
export function requestPartySync(db: Db, partyId: string): void {
  bumpSyncGeneration(db, partyId);
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
  clearRateLimitIfExpired();

  const party = db
    .query(`SELECT * FROM parties WHERE status = 'on' LIMIT 1`)
    .get() as { id: string; sync_generation: number } | null;

  try {
    const token = await spotify.getAccessToken();
    if (!token) {
      syncState = {
        deviceActive: false,
        spotifyReachable: false,
        deviceRestricted: false,
        deviceName: null,
        lastError: "Spotify not connected",
        rateLimitedUntil: null,
        lastSyncedAt: syncState.lastSyncedAt,
      };
      return;
    }

    if (isRateLimited()) {
      const remainingMs = (syncState.rateLimitedUntil ?? 0) - Date.now();
      syncState = {
        ...syncState,
        spotifyReachable: true,
        lastError: rateLimitMessage(remainingMs),
      };
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

    if (!party || !snapshot.deviceActive) return;

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
}

async function runPartySync(
  db: Db,
  spotify: SpotifyClient,
  party: { id: string; sync_generation: number },
  snapshot: PlayerSnapshot,
): Promise<void> {
  const items = getQueueItems(db, party.id);
  const needsQueue =
    partyHasPendingBufferWork(db, party.id) ||
    partyNeedsSpotifyQueueSync(db, party.id, party.sync_generation);

  let queueData: SpotifyQueueSnapshot = { currentlyPlaying: null, queue: [] };
  let queueApiAvailable = !needsQueue;

  if (needsQueue) {
    try {
      queueData = await spotify.getQueue();
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
  } else {
    debugLog("sync", "skipping queue fetch — idle");
  }

  const effective = buildEffectiveQueueSnapshot(queueData, snapshot, items);

  await reconcilePlayingState(
    db,
    party.id,
    items,
    effective,
    snapshot.isPlaying,
    spotify,
    snapshot.deviceName,
  );

  if (!needsQueue || !queueApiAvailable || syncState.deviceRestricted) {
    partyLastSyncedGeneration.set(party.id, party.sync_generation);
    return;
  }

  const afterPlaying = getQueueItems(db, party.id);
  reconcileSpotifyBufferStatuses(db, party.id, afterPlaying, queueData);

  const refreshed = getQueueItems(db, party.id);
  await fillSpotifyBufferIfEmpty(
    db,
    party.id,
    refreshed,
    spotify,
    queueData,
    snapshot.deviceName,
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
  const vetoedOrSkipped = (item: QueueItemRow) =>
    item.status === "vetoed" || item.status === "skipped";

  if (!current?.uri) {
    if (!isPlaying && playing) {
      markFinished(
        db,
        playing.id,
        vetoedOrSkipped(playing) ? playing.status : "played",
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
      vetoedOrSkipped(playing) ? playing.status : "played",
    );
  }

  const freshItems = getQueueItems(db, partyId);
  let match = freshItems.find((i) => i.spotify_uri === current.uri);

  if (!match) {
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
    db.run(
      `UPDATE queue_items SET status = 'pending'
       WHERE party_id = ? AND status = 'playing' AND id != ?`,
      [partyId, match.id],
    );
    db.run(`UPDATE queue_items SET status = 'playing' WHERE id = ?`, [match.id]);
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
  deviceName: string | null,
): Promise<void> {
  if (isSpotifyBufferOccupied(queueData)) {
    return;
  }

  const next = getVirtualNextToBuffer(items, queueData);
  if (!next) return;

  try {
    await spotify.addToQueue(next.spotify_uri);
    db.run(`UPDATE queue_items SET status = 'queued' WHERE id = ?`, [next.id]);
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
