import type { Db } from "../db/schema";
import {
  getQueueItems,
  getUpcomingPlayOrder,
  markFinished,
  markPriorItemsPlayed,
  type QueueItemRow,
} from "./queue";
import type { PlayerSnapshot, SpotifyClient } from "./spotify";
import { isNoActiveDeviceError, isRestrictedDeviceError } from "./spotify-errors";

const SYNC_INTERVAL_MS = 2000;

const RESTRICTED_DEVICE_HINT =
  "This device doesn't support Spotify's queue API — use the Spotify app on your phone or computer.";

const ACTIVE_VIRTUAL_STATUSES = ["pending", "queued", "playing"];

export interface SyncState {
  deviceActive: boolean;
  spotifyReachable: boolean;
  deviceRestricted: boolean;
  deviceName: string | null;
  lastError: string | null;
}

let syncState: SyncState = {
  deviceActive: false,
  spotifyReachable: true,
  deviceRestricted: false,
  deviceName: null,
  lastError: null,
};

const lastSyncedGeneration = new Map<string, number>();
const partySyncInFlight = new Map<string, Promise<void>>();

export function isUriBufferedInSpotify(
  uri: string,
  queueData: {
    currentlyPlaying: { uri: string } | null;
    queue: { uri: string }[];
  },
): boolean {
  if (queueData.currentlyPlaying?.uri === uri) return true;
  return queueData.queue.some((track) => track.uri === uri);
}

/** Jukebox-managed URIs still waiting in Spotify's upcoming queue (not now playing). */
export function getManagedSpotifyQueueUris(
  items: QueueItemRow[],
  queueData: { queue: { uri: string }[] },
): string[] {
  const activeUris = new Set(
    items
      .filter((item) => ACTIVE_VIRTUAL_STATUSES.includes(item.status))
      .map((item) => item.spotify_uri),
  );
  return queueData.queue
    .map((track) => track.uri)
    .filter((uri) => activeUris.has(uri));
}

/** Only buffer the virtual next when Spotify has no other jukebox track waiting. */
export function shouldAddNextToSpotifyBuffer(
  next: QueueItemRow,
  items: QueueItemRow[],
  queueData: {
    currentlyPlaying: { uri: string } | null;
    queue: { uri: string }[];
  },
  rowStatus: string,
  forceRebuild: boolean,
): boolean {
  if (rowStatus === "playing") return false;
  if (isUriBufferedInSpotify(next.spotify_uri, queueData)) return false;
  if (rowStatus === "queued") return false;
  if (getManagedSpotifyQueueUris(items, queueData).length > 0) return false;
  if (rowStatus !== "pending" && !forceRebuild) return false;
  return true;
}

/** Skip playback when Spotify plays a demoted, vetoed, or out-of-order jukebox track. */
export function shouldSkipUnexpectedPlayback(
  match: QueueItemRow,
  items: QueueItemRow[],
): boolean {
  if (match.status === "vetoed" || match.status === "skipped") return true;
  const expectedNext = getUpcomingPlayOrder(items)[0];
  return !expectedNext || expectedNext.id !== match.id;
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

function applyPlayerSnapshot(snapshot: PlayerSnapshot): void {
  syncState = {
    ...syncState,
    deviceActive: snapshot.deviceActive,
    spotifyReachable: true,
    deviceRestricted: snapshot.deviceRestricted,
    deviceName: snapshot.deviceName,
    lastError: snapshot.deviceRestricted
      ? restrictedMessage(snapshot.deviceName)
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

function handleSyncError(e: unknown): void {
  if (isQueueControlError(e)) {
    markDeviceRestricted(syncState.deviceName);
    return;
  }
  syncState = {
    deviceActive: false,
    spotifyReachable: false,
    deviceRestricted: false,
    deviceName: syncState.deviceName,
    lastError: e instanceof Error ? e.message : String(e),
  };
}

export function startSyncWorker(db: Db, spotify: SpotifyClient): void {
  setInterval(() => {
    void runSyncTick(db, spotify);
  }, SYNC_INTERVAL_MS);
  void runSyncTick(db, spotify);
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

/** Run sync immediately after a virtual queue change (host/guest mutation). */
export async function syncPartyQueue(
  db: Db,
  spotify: SpotifyClient,
  partyId: string,
): Promise<void> {
  const party = db
    .query(`SELECT * FROM parties WHERE id = ? AND status = 'on'`)
    .get(partyId) as { id: string; sync_generation: number } | null;
  if (!party) return;

  await withPartySyncLock(partyId, async () => {
    try {
      const token = await spotify.getAccessToken();
      if (!token) return;

      const snapshot = await spotify.getPlayerSnapshot();
      if (!snapshot.deviceActive) return;
      applyPlayerSnapshot(snapshot);

      await runPartySync(db, spotify, party, snapshot);
    } catch (e) {
      handleSyncError(e);
    }
  });
}

async function runSyncTick(db: Db, spotify: SpotifyClient): Promise<void> {
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
      };
      return;
    }

    const snapshot = await spotify.getPlayerSnapshot();
    applyPlayerSnapshot(snapshot);

    if (!party || !snapshot.deviceActive) return;

    await withPartySyncLock(party.id, () =>
      runPartySync(db, spotify, party, snapshot),
    );
  } catch (e) {
    handleSyncError(e);
  }
}

async function runPartySync(
  db: Db,
  spotify: SpotifyClient,
  party: { id: string; sync_generation: number },
  snapshot: PlayerSnapshot,
): Promise<void> {
  const generation = Number(party.sync_generation);
  const forceRebuild =
    (lastSyncedGeneration.get(party.id) ?? -1) !== generation;
  lastSyncedGeneration.set(party.id, generation);

  const items = getQueueItems(db, party.id);
  await reconcilePlayingState(
    db,
    party.id,
    items,
    snapshot.currentUri,
    snapshot.isPlaying,
    spotify,
    snapshot.deviceName,
  );

  const refreshed = getQueueItems(db, party.id);
  const playing = refreshed.find((i) => i.status === "playing");
  if (playing) {
    markPriorItemsPlayed(db, refreshed, playing.id);
  }

  await syncNextToSpotify(
    db,
    party.id,
    getQueueItems(db, party.id),
    spotify,
    forceRebuild,
    snapshot.deviceName,
  );
}

function isTerminalStatus(status: string): boolean {
  return status === "played" || status === "skipped" || status === "vetoed";
}

async function skipCurrentTrack(
  spotify: SpotifyClient,
  deviceName: string | null,
): Promise<void> {
  try {
    await spotify.skipNext();
  } catch (e) {
    if (isQueueControlError(e)) {
      markDeviceRestricted(deviceName);
      return;
    }
    throw e;
  }
}

/** Observe Spotify playback; skip demoted/vetoed tracks when they reach the front. */
async function reconcilePlayingState(
  db: Db,
  partyId: string,
  items: QueueItemRow[],
  spotifyUri: string | null,
  isPlaying: boolean,
  spotify: SpotifyClient,
  deviceName: string | null,
): Promise<void> {
  const playing = items.find((i) => i.status === "playing");
  const vetoedOrSkipped = (item: QueueItemRow) =>
    item.status === "vetoed" || item.status === "skipped";

  if (!spotifyUri) {
    if (!isPlaying && playing) {
      markFinished(
        db,
        playing.id,
        vetoedOrSkipped(playing) ? playing.status : "played",
      );
    }
    return;
  }

  if (playing?.spotify_uri === spotifyUri) {
    return;
  }

  if (playing && playing.spotify_uri !== spotifyUri) {
    markFinished(
      db,
      playing.id,
      vetoedOrSkipped(playing) ? playing.status : "played",
    );
  }

  const freshItems = getQueueItems(db, partyId);
  const match = freshItems.find((i) => i.spotify_uri === spotifyUri);
  if (!match) {
    return;
  }

  if (isTerminalStatus(match.status)) {
    await skipCurrentTrack(spotify, deviceName);
    return;
  }

  if (shouldSkipUnexpectedPlayback(match, freshItems)) {
    markFinished(db, match.id, "skipped");
    await skipCurrentTrack(spotify, deviceName);
    return;
  }

  markPriorItemsPlayed(db, freshItems, match.id);
  db.run(`UPDATE queue_items SET status = 'playing' WHERE id = ?`, [match.id]);
}

/** Add exactly one upcoming track to Spotify's queue when the buffer slot is free. */
async function syncNextToSpotify(
  db: Db,
  partyId: string,
  items: QueueItemRow[],
  spotify: SpotifyClient,
  forceRebuild: boolean,
  deviceName: string | null,
): Promise<void> {
  if (syncState.deviceRestricted) return;

  const next = getUpcomingPlayOrder(items)[0];
  if (!next) {
    for (const item of items.filter((i) => i.status === "queued")) {
      db.run(`UPDATE queue_items SET status = 'pending' WHERE id = ?`, [item.id]);
    }
    return;
  }

  for (const item of items.filter((i) => i.status === "queued" && i.id !== next.id)) {
    db.run(`UPDATE queue_items SET status = 'pending' WHERE id = ?`, [item.id]);
  }

  const row = db
    .query(`SELECT status FROM queue_items WHERE id = ?`)
    .get(next.id) as { status: string } | null;
  if (!row || row.status === "playing") return;

  let queueData;
  try {
    queueData = await spotify.getQueue();
  } catch (e) {
    if (isQueueControlError(e)) {
      markDeviceRestricted(deviceName);
      return;
    }
    throw e;
  }

  if (isUriBufferedInSpotify(next.spotify_uri, queueData)) {
    if (row.status !== "queued") {
      db.run(`UPDATE queue_items SET status = 'queued' WHERE id = ?`, [next.id]);
    }
    return;
  }

  if (!shouldAddNextToSpotifyBuffer(next, items, queueData, row.status, forceRebuild)) {
    return;
  }

  try {
    await spotify.addToQueue(next.spotify_uri);
    db.run(`UPDATE queue_items SET status = 'queued' WHERE id = ?`, [next.id]);
  } catch (e) {
    if (isQueueControlError(e)) {
      markDeviceRestricted(deviceName);
      return;
    }
    throw e;
  }
}
