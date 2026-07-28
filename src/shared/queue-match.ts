import { isDuplicateTrack } from "./dedup";
import type { DedupTrack, QueueItemView } from "./types";

export interface QueueMatchSource {
  nowPlaying: QueueItemView | null;
  upcomingOrder?: QueueItemView[];
  boostLane: QueueItemView[];
  upcoming: QueueItemView[];
  dedupTracks: DedupTrack[];
}

export type SearchQueueBlockReason = "active" | "history" | null;

function activeQueueItems(queue: QueueMatchSource): QueueItemView[] {
  const ordered =
    queue.upcomingOrder ??
    [...queue.boostLane, ...queue.upcoming];
  return [...(queue.nowPlaying ? [queue.nowPlaying] : []), ...ordered];
}

function queueItemAsDedupTrack(item: QueueItemView): DedupTrack {
  return {
    trackName: item.trackName,
    artistName: item.artistName,
    durationMs: item.durationMs,
    spotifyUri: item.spotifyUri,
  };
}

function trackAsDedupTrack(track: {
  uri?: string;
  name: string;
  artistName: string;
  durationMs?: number | null;
}): DedupTrack {
  return {
    trackName: track.name,
    artistName: track.artistName,
    durationMs: track.durationMs,
    spotifyUri: track.uri,
  };
}

/** Find an actively queued item by Spotify URI (not dedup history). */
export function findActiveQueueItem(
  track: { uri: string },
  queue: QueueMatchSource,
): QueueItemView | null {
  return activeQueueItems(queue).find((item) => item.spotifyUri === track.uri) ?? null;
}

/** Find an actively queued item by folded title/artist (different URI, same song). */
export function findActiveQueueItemByFold(
  track: { name: string; artistName: string; durationMs?: number | null },
  queue: QueueMatchSource,
): QueueItemView | null {
  const candidate = trackAsDedupTrack(track);
  for (const item of activeQueueItems(queue)) {
    if (isDuplicateTrack(candidate, [queueItemAsDedupTrack(item)])) {
      return item;
    }
  }
  return null;
}

/** Whether a search result matches an active or recently played queue entry. */
export function isTrackInPartyQueue(
  track: {
    uri: string;
    name: string;
    artistName: string;
    durationMs?: number | null;
  },
  queue: QueueMatchSource,
): boolean {
  if (findActiveQueueItem(track, queue)) return true;
  return isDuplicateTrack(trackAsDedupTrack(track), queue.dedupTracks);
}

export function getSearchTrackQueueState(
  track: {
    uri: string;
    name: string;
    artistName: string;
    durationMs?: number | null;
  },
  queue: QueueMatchSource,
): { blockedReason: SearchQueueBlockReason; queueItemId: string | null } {
  const activeByUri = findActiveQueueItem(track, queue);
  if (activeByUri) {
    return { blockedReason: "active", queueItemId: activeByUri.id };
  }
  const activeByFold = findActiveQueueItemByFold(track, queue);
  if (activeByFold) {
    return { blockedReason: "active", queueItemId: activeByFold.id };
  }
  if (isDuplicateTrack(trackAsDedupTrack(track), queue.dedupTracks)) {
    return { blockedReason: "history", queueItemId: null };
  }
  return { blockedReason: null, queueItemId: null };
}

export function queueItemAnchorId(itemId: string): string {
  return `queue-item-${itemId}`;
}
