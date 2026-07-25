import { isDuplicateTitle } from "./dedup";
import type { QueueItemView } from "./types";

export interface QueueMatchSource {
  nowPlaying: QueueItemView | null;
  upcomingOrder?: QueueItemView[];
  boostLane: QueueItemView[];
  upcoming: QueueItemView[];
  dedupTitles: string[];
}

/** Whether a search result matches an active or recently played queue entry. */
export function isTrackInPartyQueue(
  track: { uri: string; name: string },
  queue: QueueMatchSource,
): boolean {
  const ordered =
    queue.upcomingOrder ??
    [...queue.boostLane, ...queue.upcoming];
  const activeUris = [
    queue.nowPlaying?.spotifyUri,
    ...ordered.map((item) => item.spotifyUri),
  ].filter((uri): uri is string => Boolean(uri));

  if (activeUris.includes(track.uri)) return true;
  return isDuplicateTitle(track.name, queue.dedupTitles);
}
