import type { Config } from "../config";
import { debugLog } from "../debug";
import { recordSpotifyApiCall } from "./spotify-metrics";
import { getSpotifyApiCaller } from "./spotify-caller";
import { acquireSpotifyApiBudgetSlot } from "./spotify-api-budget";
import { decrypt, encrypt } from "../crypto";
import type { Db } from "../db/schema";
import type { SpotifyTrack } from "@/shared/types";
import { resolveSpotifyRateLimitMs, SpotifyApiError } from "./spotify-errors";

type SpotifyRateLimitHandler = (error: unknown) => void;
type SpotifyRateLimitedGate = () => number | null;

let spotifyRateLimitHandler: SpotifyRateLimitHandler | null = null;
let spotifyRateLimitedGate: SpotifyRateLimitedGate | null = null;

/** Register global backoff when any Spotify API call returns 429. */
export function setSpotifyRateLimitHandler(
  handler: SpotifyRateLimitHandler | null,
): void {
  spotifyRateLimitHandler = handler;
}

/** Register gate that blocks outbound calls while global Spotify backoff is active. */
export function setSpotifyRateLimitedGate(
  gate: SpotifyRateLimitedGate | null,
): void {
  spotifyRateLimitedGate = gate;
}

export interface PlayerSnapshot {
  deviceActive: boolean;
  isPlaying: boolean;
  deviceRestricted: boolean;
  deviceName: string | null;
  currentUri: string | null;
  progressMs: number | null;
  durationMs: number | null;
}

export interface SpotifyClient {
  getAccessToken(): Promise<string | null>;
  getPlayerSnapshot(): Promise<PlayerSnapshot>;
  searchTracks(query: string, limit?: number): Promise<SpotifyTrack[]>;
  /** Single /search call returning both tracks and artists (type=track,artist). */
  searchCatalog(
    query: string,
    trackLimit?: number,
    artistLimit?: number,
  ): Promise<{
    tracks: SpotifyTrack[];
    artists: { id: string; name: string; imageUrl: string | null }[];
  }>;
  searchArtists(query: string, limit?: number): Promise<
    { id: string; name: string; imageUrl: string | null }[]
  >;
  /** Raw track search hits for `artist:{name}` (filter credited/all in spotify-search). */
  searchArtistTracks(
    artistId: string,
    artistName?: string,
    options?: { limit?: number; offset?: number },
  ): Promise<
    {
      uri: string;
      id: string;
      name: string;
      artists: { id: string; name: string }[];
      album: { images: { url: string }[] };
    }[]
  >;
  getPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]>;
  getCurrentlyPlaying(): Promise<{
    uri: string | null;
    isPlaying: boolean;
    deviceActive: boolean;
  }>;
  getQueue(): Promise<{ currentlyPlaying: SpotifyTrack | null; queue: SpotifyTrack[] }>;
  addToQueue(uri: string): Promise<void>;
  skipNext(): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** @deprecated use getPlayerSnapshot */
  getPlaybackState(): Promise<{
    deviceActive: boolean;
    isPlaying: boolean;
    deviceRestricted: boolean;
    deviceName: string | null;
  }>;
}

function mapTrack(raw: {
  uri: string;
  id?: string;
  name: string;
  artists: { id?: string; name: string }[];
  album?: { images: { url: string }[] };
  duration_ms?: number;
}): SpotifyTrack {
  return {
    uri: raw.uri,
    id: raw.id ?? raw.uri.split(":").pop() ?? raw.uri,
    name: raw.name,
    artists: raw.artists,
    album: raw.album ?? { images: [] },
    durationMs:
      typeof raw.duration_ms === "number" ? raw.duration_ms : null,
  };
}

/** Prefer search hits credited to the requested artist. */
export function pickArtistSearchTracks<
  T extends { artists: { id: string }[] },
>(items: T[], artistId: string, limit = 10): T[] {
  const matching = items.filter((track) =>
    track.artists.some((artist) => artist.id === artistId),
  );
  return (matching.length > 0 ? matching : items).slice(0, limit);
}

function isRestrictedDeviceType(type: string | undefined): boolean {
  if (!type) return false;
  const normalized = type.toLowerCase();
  return (
    normalized === "airplay" ||
    normalized === "castaudio" ||
    normalized === "tv" ||
    normalized === "game_console"
  );
}

export function isPlaybackActive(
  device: { id?: string } | null | undefined,
  item: { uri?: string } | null | undefined,
): boolean {
  return Boolean(device?.id) || Boolean(item?.uri);
}

function summarizePlayerBody(data: {
  is_playing?: boolean;
  item?: { uri?: string; name?: string } | null;
  device?: {
    id?: string;
    name?: string;
    type?: string;
    is_restricted?: boolean;
  } | null;
} | null): Record<string, unknown> {
  if (!data) return { body: null };
  return {
    isPlaying: data.is_playing ?? null,
    trackUri: data.item?.uri ?? null,
    trackName: data.item?.name ?? null,
    deviceId: data.device?.id ?? null,
    deviceName: data.device?.name ?? null,
    deviceType: data.device?.type ?? null,
    deviceRestricted: data.device?.is_restricted ?? null,
    deviceActive: isPlaybackActive(data.device, data.item),
  };
}

function summarizeQueueBody(data: {
  currently_playing?: { uri?: string; name?: string } | null;
  queue?: { uri?: string; name?: string }[];
} | null): Record<string, unknown> {
  if (!data) return { body: null };
  return {
    currentlyPlayingUri: data.currently_playing?.uri ?? null,
    currentlyPlayingName: data.currently_playing?.name ?? null,
    queueLength: data.queue?.length ?? 0,
    queueUris: (data.queue ?? []).slice(0, 5).map((t) => t.uri),
  };
}

function logSpotifySnapshot(label: string, snapshot: PlayerSnapshot): void {
  debugLog("spotify", label, {
    deviceActive: snapshot.deviceActive,
    isPlaying: snapshot.isPlaying,
    deviceRestricted: snapshot.deviceRestricted,
    deviceName: snapshot.deviceName,
    currentUri: snapshot.currentUri,
    progressMs: snapshot.progressMs,
    durationMs: snapshot.durationMs,
  });
}

function emptyPlayerSnapshot(): PlayerSnapshot {
  return {
    deviceActive: false,
    isPlaying: false,
    deviceRestricted: false,
    deviceName: null,
    currentUri: null,
    progressMs: null,
    durationMs: null,
  };
}

function playbackTimingFromBody(data: {
  progress_ms?: number;
  item?: { uri: string; duration_ms?: number } | null;
}): Pick<PlayerSnapshot, "progressMs" | "durationMs"> {
  return {
    progressMs: typeof data.progress_ms === "number" ? data.progress_ms : null,
    durationMs:
      typeof data.item?.duration_ms === "number" ? data.item.duration_ms : null,
  };
}

async function readJsonBody<T>(res: Response): Promise<T | null> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }
  return null;
}

export function createSpotifyClient(db: Db, config: Config): SpotifyClient {
  async function refreshTokenIfNeeded(): Promise<string | null> {
    const row = db
      .query(`SELECT * FROM host_credentials WHERE id = 1`)
      .get() as
      | {
          access_token: string;
          refresh_token: string;
          expires_at: string;
        }
      | null;
    if (!row) return null;

    let accessToken = decrypt(row.access_token, config.encryptionKey);
    const expiresAt = new Date(row.expires_at).getTime();
    if (Date.now() < expiresAt - 60_000) {
      return accessToken;
    }

    const refreshToken = decrypt(row.refresh_token, config.encryptionKey);
    const res = await fetch(`${config.spotifyAccountsBaseUrl}/api/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        Authorization:
          "Basic " +
          Buffer.from(
            `${config.spotifyClientId}:${config.spotifyClientSecret}`,
          ).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 400 && body.includes("invalid_grant")) {
        db.run(`DELETE FROM host_credentials WHERE id = 1`);
        debugLog("spotify", "refresh token revoked — re-auth required");
        throw new Error("SPOTIFY_REAUTH_REQUIRED");
      }
      debugLog("spotify", "token refresh failed", res.status, body);
      return null;
    }
    const data = await readJsonBody<{
      access_token: string;
      expires_in: number;
    }>(res);
    if (!data?.access_token) return null;
    accessToken = data.access_token;
    const newExpires = new Date(Date.now() + data.expires_in * 1000).toISOString();
    db.run(
      `UPDATE host_credentials SET access_token = ?, expires_at = ?, updated_at = ? WHERE id = 1`,
      [
        encrypt(accessToken, config.encryptionKey),
        newExpires,
        new Date().toISOString(),
      ],
    );
    debugLog("spotify", "token refreshed", { expiresAt: newExpires });
    return accessToken;
  }

  async function spotifyFetch(path: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const started = Date.now();
    debugLog("spotify", "→", method, path);

    const backoffRemainingMs = spotifyRateLimitedGate?.() ?? null;
    if (backoffRemainingMs != null && backoffRemainingMs > 0) {
      debugLog("spotify", "backoff gate", { remainingMs: backoffRemainingMs, path });
      throw new SpotifyApiError(
        "SPOTIFY_429:global backoff",
        429,
        backoffRemainingMs,
      );
    }

    await acquireSpotifyApiBudgetSlot({
      onWait: (waitMs) => {
        debugLog("spotify", "throttled", { waitMs, path });
      },
    });

    const token = await refreshTokenIfNeeded();
    if (!token) throw new Error("NOT_CONNECTED");
    const res = await fetch(`${config.spotifyApiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });

    const elapsedMs = Date.now() - started;
    const retryAfterHeader = res.headers.get("Retry-After");
    debugLog(
      "spotify",
      "←",
      method,
      path,
      res.status,
      `${elapsedMs}ms`,
      retryAfterHeader ? { retryAfter: retryAfterHeader } : undefined,
    );
    let retryAfterMs: number | null = null;
    if (res.status === 429) {
      const body = await res.clone().text();
      retryAfterMs = resolveSpotifyRateLimitMs(retryAfterHeader, body, res.status);
    }
    recordSpotifyApiCall({
      path,
      status: res.status,
      elapsedMs,
      caller: getSpotifyApiCaller(),
      retryAfterMs,
    });
    return res;
  }

  async function throwSpotifyError(res: Response): Promise<never> {
    const body = await res.text();
    debugLog("spotify", "error body", {
      status: res.status,
      retryAfter: res.headers.get("Retry-After"),
      body: body.slice(0, 500),
    });
    const error = new SpotifyApiError(
      `SPOTIFY_${res.status}:${body}`,
      res.status,
      res.status === 429
        ? resolveSpotifyRateLimitMs(res.headers.get("Retry-After"), body, res.status)
        : null,
    );
    if (res.status === 429) {
      spotifyRateLimitHandler?.(error);
    }
    throw error;
  }

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await spotifyFetch(path, init);
    if (res.status === 204) return undefined as T;
    if (!res.ok) await throwSpotifyError(res);
    const data = await readJsonBody<T>(res);
    if (data == null) {
      throw new SpotifyApiError(
        `SPOTIFY_${res.status}:invalid response`,
        res.status,
        null,
      );
    }
    return data;
  }

  /** POST endpoints that succeed with an empty 200/204 body (queue add, skip, etc.). */
  async function apiVoid(path: string, init?: RequestInit): Promise<void> {
    const res = await spotifyFetch(path, init);
    if (res.status === 204 || res.status === 200) return;
    if (!res.ok) await throwSpotifyError(res);
  }

  async function getPlayerSnapshotFromCurrentlyPlaying(): Promise<PlayerSnapshot | null> {
    debugLog("spotify", "fallback currently-playing");
    const res = await spotifyFetch("/me/player/currently-playing");
    if (res.status === 204 || res.status === 404) {
      debugLog("spotify", "currently-playing empty", res.status);
      return null;
    }
    if (!res.ok) {
      await throwSpotifyError(res);
    }

    const data = await readJsonBody<{
      is_playing?: boolean;
      progress_ms?: number;
      item?: { uri: string; name?: string; duration_ms?: number } | null;
    }>(res);
    debugLog("spotify", "currently-playing body", summarizePlayerBody(data));
    if (!data?.item?.uri) {
      return null;
    }

    const snapshot = {
      deviceActive: true,
      isPlaying: Boolean(data.is_playing),
      deviceRestricted: false,
      deviceName: null,
      currentUri: data.item.uri,
      ...playbackTimingFromBody(data),
    };
    logSpotifySnapshot("fallback snapshot", snapshot);
    return snapshot;
  }

  async function getPlayerSnapshot(): Promise<PlayerSnapshot> {
    const res = await spotifyFetch("/me/player");
    if (res.status === 204 || res.status === 404) {
      debugLog("spotify", "/me/player empty", res.status, "trying fallback");
      const fallback = await getPlayerSnapshotFromCurrentlyPlaying();
      if (fallback) {
        return fallback;
      }
      const empty = emptyPlayerSnapshot();
      logSpotifySnapshot("no playback", empty);
      return empty;
    }
    if (!res.ok) {
      await throwSpotifyError(res);
    }

    const data = await readJsonBody<{
      is_playing?: boolean;
      progress_ms?: number;
      item?: { uri: string; name?: string; duration_ms?: number } | null;
      device?: {
        id: string;
        name?: string;
        type?: string;
        is_restricted?: boolean;
      } | null;
    }>(res);
    debugLog("spotify", "/me/player body", summarizePlayerBody(data));

    if (!data) {
      const restricted: PlayerSnapshot = {
        deviceActive: true,
        isPlaying: false,
        deviceRestricted: true,
        deviceName: null,
        currentUri: null,
        progressMs: null,
        durationMs: null,
      };
      logSpotifySnapshot("opaque player response", restricted);
      return restricted;
    }

    const device = data.device;
    const deviceRestricted =
      Boolean(device?.is_restricted) ||
      isRestrictedDeviceType(device?.type) ||
      (device?.name?.toLowerCase().includes("airplay") ?? false);

    const snapshot: PlayerSnapshot = {
      deviceActive: isPlaybackActive(device, data.item),
      isPlaying: Boolean(data.is_playing),
      deviceRestricted,
      deviceName: device?.name ?? null,
      currentUri: data.item?.uri ?? null,
      ...playbackTimingFromBody(data),
    };
    logSpotifySnapshot("player snapshot", snapshot);
    return snapshot;
  }

  return {
    getAccessToken: refreshTokenIfNeeded,
    getPlayerSnapshot,

    async searchTracks(query, limit = 10) {
      const data = await api<{
        tracks: { items: SpotifyTrack[] };
      }>(`/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`);
      return data.tracks.items.map(mapTrack);
    },

    async searchCatalog(query, trackLimit = 10, artistLimit = 5) {
      const limit = Math.min(10, Math.max(trackLimit, artistLimit));
      const data = await api<{
        tracks: { items: SpotifyTrack[] };
        artists: {
          items: {
            id: string;
            name: string;
            images: { url: string }[];
          }[];
        };
      }>(
        `/search?q=${encodeURIComponent(query)}&type=track,artist&limit=${limit}`,
      );
      return {
        tracks: (data.tracks?.items ?? []).slice(0, trackLimit).map(mapTrack),
        artists: (data.artists?.items ?? []).slice(0, artistLimit).map((a) => ({
          id: a.id,
          name: a.name,
          imageUrl: a.images[0]?.url ?? null,
        })),
      };
    },

    async searchArtists(query, limit = 5) {
      const data = await api<{
        artists: {
          items: {
            id: string;
            name: string;
            images: { url: string }[];
          }[];
        };
      }>(`/search?q=${encodeURIComponent(query)}&type=artist&limit=${limit}`);
      return data.artists.items.map((a) => ({
        id: a.id,
        name: a.name,
        imageUrl: a.images[0]?.url ?? null,
      }));
    },

    async searchArtistTracks(artistId, artistName, options) {
      const limit = Math.min(10, Math.max(1, options?.limit ?? 10));
      const offset = Math.max(0, options?.offset ?? 0);
      let name = artistName?.trim();
      if (!name) {
        const artist = await api<{ name: string }>(
          `/artists/${encodeURIComponent(artistId)}`,
        );
        name = artist.name;
      }

      const data = await api<{
        tracks: {
          items: {
            uri: string;
            id: string;
            name: string;
            artists: { id: string; name: string }[];
            album: { images: { url: string }[] };
            duration_ms?: number;
          }[];
        };
      }>(
        `/search?q=${encodeURIComponent(`artist:${name}`)}&type=track&limit=${limit}&offset=${offset}`,
      );
      return (data.tracks?.items ?? []).map(mapTrack);
    },

    async getPlaylistTracks(playlistId) {
      const tracks: SpotifyTrack[] = [];
      let path: string | null = `/playlists/${playlistId}/items?limit=100`;
      while (path) {
        const data: {
          items: { item: SpotifyTrack | null }[];
          next: string | null;
        } = await api(path);
        for (const entry of data.items) {
          if (entry.item?.uri) tracks.push(mapTrack(entry.item));
        }
        path = data.next
          ? data.next.replace(config.spotifyApiBaseUrl, "")
          : null;
      }
      return tracks;
    },

    async getCurrentlyPlaying() {
      const snapshot = await getPlayerSnapshot();
      return {
        uri: snapshot.currentUri,
        isPlaying: snapshot.isPlaying,
        deviceActive: snapshot.deviceActive,
      };
    },

    async getQueue() {
      const res = await spotifyFetch("/me/player/queue");
      if (res.status === 204 || res.status === 404) {
        debugLog("spotify", "queue empty", res.status);
        return { currentlyPlaying: null, queue: [], available: false };
      }
      if (!res.ok) await throwSpotifyError(res);
      const data = await readJsonBody<{
        currently_playing: SpotifyTrack | null;
        queue: SpotifyTrack[];
      }>(res);
      debugLog("spotify", "queue body", summarizeQueueBody(data));
      if (!data) {
        debugLog("spotify", "queue opaque response");
        return { currentlyPlaying: null, queue: [], available: false };
      }
      return {
        currentlyPlaying: data.currently_playing
          ? mapTrack(data.currently_playing)
          : null,
        queue: (data.queue ?? []).map(mapTrack),
        available: true,
      };
    },

    async addToQueue(uri) {
      await apiVoid(`/me/player/queue?uri=${encodeURIComponent(uri)}`, {
        method: "POST",
      });
    },

    async skipNext() {
      await apiVoid("/me/player/next", { method: "POST" });
    },

    async play() {
      await apiVoid("/me/player/play", { method: "PUT" });
    },

    async pause() {
      await apiVoid("/me/player/pause", { method: "PUT" });
    },

    async getPlaybackState() {
      const snapshot = await getPlayerSnapshot();
      return {
        deviceActive: snapshot.deviceActive,
        isPlaying: snapshot.isPlaying,
        deviceRestricted: snapshot.deviceRestricted,
        deviceName: snapshot.deviceName,
      };
    },
  };
}

export function ensureMockHostCredentials(db: Db, config: Config): void {
  if (config.spotifyMode !== "mock") return;
  const row = db
    .query(`SELECT id FROM host_credentials WHERE id = 1`)
    .get() as { id: number } | null;
  if (row) return;
  storeHostTokens(
    db,
    config,
    "mock-access-token",
    "mock-refresh-token",
    86400 * 365,
  );
  debugLog("spotify", "seeded mock host credentials");
}

export function storeHostTokens(
  db: Db,
  config: Config,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): void {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  db.run(
    `INSERT INTO host_credentials (id, access_token, refresh_token, expires_at, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
    [
      encrypt(accessToken, config.encryptionKey),
      encrypt(refreshToken, config.encryptionKey),
      expiresAt,
      new Date().toISOString(),
    ],
  );
}

export function trackFromSpotify(track: SpotifyTrack) {
  return {
    uri: track.uri,
    name: track.name,
    artistName: track.artists.map((a) => a.name).join(", "),
    albumArtUrl: track.album?.images?.[0]?.url ?? null,
    durationMs: track.durationMs ?? null,
  };
}

export type TrackInfo = ReturnType<typeof trackFromSpotify>;

export function extractPlaylistId(input: string): string {
  const match = input.match(
    /playlist\/([a-zA-Z0-9]+)|spotify:playlist:([a-zA-Z0-9]+)|^([a-zA-Z0-9]{22})$/,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? input;
}
