import { isDuplicateTitle } from "./dedup";
import type { QueueItemView } from "./types";

export interface QueueMatchSource {
  nowPlaying: QueueItemView | null;
  boostLane: QueueItemView[];
  upcoming: QueueItemView[];
  dedupTitles: string[];
}

/** Whether a search result matches an active or recently played queue entry. */
export function isTrackInPartyQueue(
  track: { uri: string; name: string },
  queue: QueueMatchSource,
): boolean {
  const activeUris = [
    queue.nowPlaying?.spotifyUri,
    ...queue.boostLane.map((item) => item.spotifyUri),
    ...queue.upcoming.map((item) => item.spotifyUri),
  ].filter((uri): uri is string => Boolean(uri));

  if (activeUris.includes(track.uri)) return true;
  return isDuplicateTitle(track.name, queue.dedupTitles);
}
