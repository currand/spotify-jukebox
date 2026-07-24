import type { Config } from "../config";
import { decrypt, encrypt } from "../crypto";
import type { Db } from "../db/schema";
import type { SpotifyTrack } from "@/shared/types";

export interface PlayerSnapshot {
  deviceActive: boolean;
  isPlaying: boolean;
  deviceRestricted: boolean;
  deviceName: string | null;
  currentUri: string | null;
}

export interface SpotifyClient {
  getAccessToken(): Promise<string | null>;
  getPlayerSnapshot(): Promise<PlayerSnapshot>;
  searchTracks(query: string, limit?: number): Promise<SpotifyTrack[]>;
  searchArtists(query: string, limit?: number): Promise<
    { id: string; name: string; imageUrl: string | null }[]
  >;
  getArtistTopTracks(artistId: string, artistName?: string): Promise<SpotifyTrack[]>;
  getPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]>;
  getCurrentlyPlaying(): Promise<{
    uri: string | null;
    isPlaying: boolean;
    deviceActive: boolean;
  }>;
  getQueue(): Promise<{ currentlyPlaying: SpotifyTrack | null; queue: SpotifyTrack[] }>;
  addToQueue(uri: string): Promise<void>;
  skipNext(): Promise<void>;
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
  id: string;
  name: string;
  artists: { name: string }[];
  album: { images: { url: string }[] };
}): SpotifyTrack {
  return {
    uri: raw.uri,
    id: raw.id,
    name: raw.name,
    artists: raw.artists,
    album: raw.album,
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
    const res = await fetch("https://accounts.spotify.com/api/token", {
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
    if (!res.ok) return null;
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
    return accessToken;
  }

  async function spotifyFetch(path: string, init?: RequestInit): Promise<Response> {
    const token = await refreshTokenIfNeeded();
    if (!token) throw new Error("NOT_CONNECTED");
    return fetch(`https://api.spotify.com/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  }

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await spotifyFetch(path, init);
    if (res.status === 204) return undefined as T;
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`SPOTIFY_${res.status}:${body}`);
    }
    const data = await readJsonBody<T>(res);
    if (data == null) {
      throw new Error(`SPOTIFY_${res.status}:invalid response`);
    }
    return data;
  }

  async function getPlayerSnapshot(): Promise<PlayerSnapshot> {
    const res = await spotifyFetch("/me/player");
    if (res.status === 204 || res.status === 404) {
      return {
        deviceActive: false,
        isPlaying: false,
        deviceRestricted: false,
        deviceName: null,
        currentUri: null,
      };
    }
    if (!res.ok) {
      throw new Error(`SPOTIFY_${res.status}`);
    }

    const data = await readJsonBody<{
      is_playing?: boolean;
      item?: { uri: string } | null;
      device?: {
        id: string;
        name?: string;
        type?: string;
        is_restricted?: boolean;
      } | null;
    }>(res);

    if (!data) {
      return {
        deviceActive: true,
        isPlaying: false,
        deviceRestricted: true,
        deviceName: null,
        currentUri: null,
      };
    }

    const device = data.device;
    const deviceRestricted =
      Boolean(device?.is_restricted) ||
      isRestrictedDeviceType(device?.type) ||
      (device?.name?.toLowerCase().includes("airplay") ?? false);

    return {
      deviceActive: Boolean(device?.id),
      isPlaying: Boolean(data.is_playing),
      deviceRestricted,
      deviceName: device?.name ?? null,
      currentUri: data.item?.uri ?? null,
    };
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

    async getArtistTopTracks(artistId, artistName) {
      try {
        const data = await api<{ tracks: SpotifyTrack[] }>(
          `/artists/${encodeURIComponent(artistId)}/top-tracks?market=${encodeURIComponent(config.spotifyMarket)}`,
        );
        if (Array.isArray(data.tracks) && data.tracks.length > 0) {
          return data.tracks.slice(0, 10).map(mapTrack);
        }
      } catch {
        // Spotify removed this endpoint for dev-mode apps (Feb 2026).
      }

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
          }[];
        };
      }>(
        `/search?q=${encodeURIComponent(name)}&type=track&limit=10`,
      );
      return pickArtistSearchTracks(data.tracks?.items ?? [], artistId).map(
        mapTrack,
      );
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
          ? data.next.replace("https://api.spotify.com/v1", "")
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
      const data = await api<{
        currently_playing: SpotifyTrack | null;
        queue: SpotifyTrack[];
      }>("/me/player/queue");
      return {
        currentlyPlaying: data.currently_playing
          ? mapTrack(data.currently_playing)
          : null,
        queue: data.queue.map(mapTrack),
      };
    },

    async addToQueue(uri) {
      await api(`/me/player/queue?uri=${encodeURIComponent(uri)}`, {
        method: "POST",
      });
    },

    async skipNext() {
      await api("/me/player/next", { method: "POST" });
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
    albumArtUrl: track.album.images[0]?.url ?? null,
  };
}

export type TrackInfo = ReturnType<typeof trackFromSpotify>;

export function extractPlaylistId(input: string): string {
  const match = input.match(
    /playlist\/([a-zA-Z0-9]+)|spotify:playlist:([a-zA-Z0-9]+)|^([a-zA-Z0-9]{22})$/,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? input;
}
