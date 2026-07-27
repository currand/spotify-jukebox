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
  duration_ms?: number;
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
  /** Wall-clock ms when the current track started (null when idle). */
  startedAt: number | null;
  rateLimitUntil: number | null;
}

export interface CreatePlayerOptions {
  /** Catalog tracks available for lookup; not auto-seeded into the player. */
  tracks?: MockTrack[];
  /** Default song length when a track omits duration_ms. */
  durationMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_DURATION_MS = 180_000;

function trackDuration(track: MockTrack | null, fallbackMs: number): number {
  if (!track) return fallbackMs;
  const ms = track.duration_ms ?? fallbackMs;
  return Math.max(1_000, ms);
}

export function createPlayerState(options: CreatePlayerOptions = {}) {
  const durationMs = Math.max(1_000, options.durationMs ?? DEFAULT_DURATION_MS);
  const now = options.now ?? Date.now;

  const state: PlayerState = {
    device: {
      id: "mock-device-1",
      name: "Mock Jukebox Speaker",
      type: "computer",
      is_restricted: false,
    },
    isPlaying: false,
    currentlyPlaying: null,
    queue: [],
    startedAt: null,
    rateLimitUntil: null,
  };

  function progressMs(): number {
    if (!state.currentlyPlaying || state.startedAt == null) return 0;
    return Math.max(0, now() - state.startedAt);
  }

  function startTrack(track: MockTrack) {
    state.currentlyPlaying = track;
    state.isPlaying = true;
    state.startedAt = now();
  }

  function stop() {
    state.currentlyPlaying = null;
    state.isPlaying = false;
    state.startedAt = null;
  }

  function promoteNext() {
    const next = state.queue.shift() ?? null;
    if (next) {
      startTrack(next);
    } else {
      stop();
    }
  }

  /** Apply elapsed playback; advance when the current track finishes. */
  function tick() {
    while (state.currentlyPlaying && state.isPlaying) {
      const duration = trackDuration(state.currentlyPlaying, durationMs);
      if (progressMs() < duration) break;
      // Carry over surplus time into the next track so multi-song jumps stay accurate.
      const surplus = progressMs() - duration;
      promoteNext();
      if (state.startedAt != null && surplus > 0) {
        state.startedAt = now() - surplus;
      }
    }
  }

  return {
    getState: () => {
      tick();
      return state;
    },
    tick,
    progressMs: () => {
      tick();
      return progressMs();
    },
    durationMs: () => {
      tick();
      return trackDuration(state.currentlyPlaying, durationMs);
    },
    advance() {
      tick();
      if (!state.currentlyPlaying && state.queue.length === 0) {
        stop();
        return;
      }
      promoteNext();
    },
    addToQueue(uri: string, tracksByUri: Map<string, MockTrack>) {
      tick();
      const track =
        tracksByUri.get(uri) ??
        ({
          uri,
          id: uri.split(":").pop() ?? uri,
          name: uri,
          artists: [{ id: "unknown", name: "Unknown" }],
          album: { images: [] },
          duration_ms: durationMs,
        } satisfies MockTrack);

      if (!state.currentlyPlaying) {
        startTrack(track);
        return;
      }
      state.queue.push(track);
    },
    reset() {
      stop();
      state.queue = [];
      state.rateLimitUntil = null;
    },
    setRateLimit(seconds: number) {
      state.rateLimitUntil = now() + seconds * 1000;
    },
    clearRateLimit() {
      state.rateLimitUntil = null;
    },
    play() {
      tick();
      if (!state.currentlyPlaying) return;
      if (state.startedAt == null) {
        state.startedAt = now();
      }
      state.isPlaying = true;
    },
    pause() {
      tick();
      state.isPlaying = false;
    },
    isRateLimited() {
      return state.rateLimitUntil != null && now() < state.rateLimitUntil;
    },
    rateLimitRemainingMs() {
      if (state.rateLimitUntil == null) return 0;
      return Math.max(0, state.rateLimitUntil - now());
    },
  };
}

export type MockPlayer = ReturnType<typeof createPlayerState>;

export function toSpotifyTrack(track: MockTrack, fallbackDurationMs = DEFAULT_DURATION_MS) {
  return {
    uri: track.uri,
    id: track.id,
    name: track.name,
    artists: track.artists,
    album: track.album,
    duration_ms: trackDuration(track, fallbackDurationMs),
  };
}

export function toPlayerResponse(player: MockPlayer) {
  const state = player.getState();
  return {
    is_playing: state.isPlaying,
    progress_ms: state.currentlyPlaying ? player.progressMs() : 0,
    item: state.currentlyPlaying
      ? toSpotifyTrack(state.currentlyPlaying)
      : null,
    device: state.device,
  };
}

export function toQueueResponse(player: MockPlayer) {
  const state = player.getState();
  return {
    currently_playing: state.currentlyPlaying
      ? toSpotifyTrack(state.currentlyPlaying)
      : null,
    queue: state.queue.map((track) => toSpotifyTrack(track)),
  };
}
