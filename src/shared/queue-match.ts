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

/** Find an actively queued item by Spotify URI (not dedup history). */
export function findActiveQueueItem(
  track: { uri: string },
  queue: QueueMatchSource,
): QueueItemView | null {
  return activeQueueItems(queue).find((item) => item.spotifyUri === track.uri) ?? null;
}

/** Whether a search result matches an active or recently played queue entry. */
export function isTrackInPartyQueue(
  track: { uri: string; name: string; artistName: string },
  queue: QueueMatchSource,
): boolean {
  if (findActiveQueueItem(track, queue)) return true;
  return isDuplicateTrack(
    { trackName: track.name, artistName: track.artistName },
    queue.dedupTracks,
  );
}

export function getSearchTrackQueueState(
  track: { uri: string; name: string; artistName: string },
  queue: QueueMatchSource,
): { blockedReason: SearchQueueBlockReason; queueItemId: string | null } {
  const active = findActiveQueueItem(track, queue);
  if (active) {
    return { blockedReason: "active", queueItemId: active.id };
  }
  if (isTrackInPartyQueue(track, queue)) {
    return { blockedReason: "history", queueItemId: null };
  }
  return { blockedReason: null, queueItemId: null };
}

export function queueItemAnchorId(itemId: string): string {
  return `queue-item-${itemId}`;
}
