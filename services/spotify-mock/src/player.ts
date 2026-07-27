export interface MockArtist {
  id: string;
  name: string;
  imageUrl: string;
}

export interface MockTrack {
  uri: string;
  id: string;
  name: string;
  artists: { id: string; name: string }[];
  album: { images: { url: string }[] };
}

export interface PlayerState {
  device: {
    id: string;
    name: string;
    type: string;
    is_restricted: boolean;
  };
  isPlaying: boolean;
  currentlyPlaying: MockTrack | null;
  queue: MockTrack[];
  rateLimitUntil: number | null;
}

export function createPlayerState(tracks: MockTrack[]) {
  const state: PlayerState = {
    device: {
      id: "mock-device-1",
      name: "Mock Jukebox Speaker",
      type: "computer",
      is_restricted: false,
    },
    isPlaying: tracks.length > 0,
    currentlyPlaying: tracks[0] ?? null,
    queue: tracks.slice(1, 8),
    rateLimitUntil: null,
  };

  return {
    getState: () => state,
    advance() {
      if (!state.currentlyPlaying && state.queue.length === 0) {
        state.isPlaying = false;
        return;
      }
      const next = state.queue.shift() ?? null;
      if (next) {
        state.currentlyPlaying = next;
        state.isPlaying = true;
      } else {
        state.currentlyPlaying = null;
        state.isPlaying = false;
      }
    },
    addToQueue(uri: string, tracksByUri: Map<string, MockTrack>) {
      const track = tracksByUri.get(uri);
      if (track) state.queue.push(track);
    },
    reset(tracks: MockTrack[]) {
      state.isPlaying = tracks.length > 0;
      state.currentlyPlaying = tracks[0] ?? null;
      state.queue = tracks.slice(1, 8);
      state.rateLimitUntil = null;
    },
    setRateLimit(seconds: number) {
      state.rateLimitUntil = Date.now() + seconds * 1000;
    },
    clearRateLimit() {
      state.rateLimitUntil = null;
    },
    isRateLimited() {
      return state.rateLimitUntil != null && Date.now() < state.rateLimitUntil;
    },
    rateLimitRemainingMs() {
      if (state.rateLimitUntil == null) return 0;
      return Math.max(0, state.rateLimitUntil - Date.now());
    },
  };
}

export type MockPlayer = ReturnType<typeof createPlayerState>;

export function toSpotifyTrack(track: MockTrack) {
  return {
    uri: track.uri,
    id: track.id,
    name: track.name,
    artists: track.artists,
    album: track.album,
  };
}

export function toPlayerResponse(player: MockPlayer) {
  const state = player.getState();
  if (!state.currentlyPlaying) return null;
  return {
    is_playing: state.isPlaying,
    item: toSpotifyTrack(state.currentlyPlaying),
    device: state.device,
  };
}

export function toQueueResponse(player: MockPlayer) {
  const state = player.getState();
  return {
    currently_playing: state.currentlyPlaying
      ? toSpotifyTrack(state.currentlyPlaying)
      : null,
    queue: state.queue.map(toSpotifyTrack),
  };
}
