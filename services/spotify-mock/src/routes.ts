import { Hono } from "hono";
import type { MockPlayer, MockTrack } from "./player";
import {
  toPlayerResponse,
  toQueueResponse,
  toSpotifyTrack,
} from "./player";

interface AppDeps {
  player: MockPlayer;
  tracks: MockTrack[];
  durationMs: number;
}

function uniqueArtists(tracks: MockTrack[]) {
  const seen = new Map<string, { id: string; name: string; imageUrl: string }>();
  for (const track of tracks) {
    for (const artist of track.artists) {
      if (!seen.has(artist.id)) {
        seen.set(artist.id, {
          id: artist.id,
          name: artist.name,
          imageUrl: `https://mock.spotify/artist/${artist.id}.jpg`,
        });
      }
    }
  }
  return [...seen.values()];
}

function matchesQuery(track: MockTrack, query: string): boolean {
  const q = query.toLowerCase();
  if (q.startsWith("track:")) {
    const id = q.slice("track:".length).trim();
    return track.id === id || track.uri.includes(id);
  }
  if (q.startsWith("artist:")) {
    const name = q.slice("artist:".length).trim().toLowerCase();
    return track.artists.some((artist) =>
      artist.name.toLowerCase().includes(name),
    );
  }
  const haystack = `${track.name} ${track.artists.map((a) => a.name).join(" ")}`.toLowerCase();
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

function rateLimitResponse(player: MockPlayer) {
  const retryAfterSec = Math.ceil(player.rateLimitRemainingMs() / 1000);
  return new Response(
    JSON.stringify({
      error: {
        status: 429,
        message: "API rate limit exceeded",
      },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.max(1, retryAfterSec)),
      },
    },
  );
}

function requireBearer(c: { req: { header: (name: string) => string | undefined } }) {
  const auth = c.req.header("Authorization");
  return auth?.startsWith("Bearer ") ?? false;
}

export function createApp({ player, tracks, durationMs }: AppDeps) {
  const tracksByUri = new Map(tracks.map((track) => [track.uri, track]));
  const artists = uniqueArtists(tracks);
  const userPlaylists = new Map<
    string,
    { id: string; name: string; uri: string; trackUris: string[] }
  >();
  let nextPlaylistNum = 1;
  const mockDevices = [
    {
      id: "mock-device-1",
      name: "Mock Jukebox Speaker",
      type: "Speaker",
      is_active: true,
      is_restricted: false,
      volume_percent: 50,
    },
    {
      id: "mock-device-2",
      name: "Living Room TV",
      type: "TV",
      is_active: false,
      is_restricted: true,
      volume_percent: 0,
    },
  ];
  const app = new Hono();

  app.post("/api/token", async (c) => {
    return c.json({
      access_token: "mock-access-token",
      refresh_token: "mock-refresh-token",
      token_type: "Bearer",
      expires_in: 86400 * 365,
      scope: "user-modify-playback-state user-read-playback-state playlist-read-private playlist-modify-private",
    });
  });

  app.use("/v1/*", async (c, next) => {
    if (!requireBearer(c)) {
      return c.json({ error: { message: "Invalid access token" } }, 401);
    }
    if (player.isRateLimited()) {
      return rateLimitResponse(player);
    }
    await next();
  });

  app.get("/v1/search", (c) => {
    const query = c.req.query("q") ?? "";
    const type = c.req.query("type") ?? "track";
    const limit = Math.min(10, Math.max(1, Number(c.req.query("limit") ?? 10)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));

    const matched = tracks.filter((track) => matchesQuery(track, query));
    const page = matched.slice(offset, offset + limit).map(toSpotifyTrack);

    const body: Record<string, unknown> = {};
    if (type.includes("track")) {
      body.tracks = { items: page };
    }
    if (type.includes("artist")) {
      const artistMatches = artists.filter((artist) =>
        artist.name.toLowerCase().includes(query.toLowerCase()),
      );
      body.artists = {
        items: artistMatches.slice(0, limit).map((artist) => ({
          id: artist.id,
          name: artist.name,
          images: [{ url: artist.imageUrl }],
        })),
      };
    }
    return c.json(body);
  });

  app.get("/v1/artists/:id", (c) => {
    const artist = artists.find((entry) => entry.id === c.req.param("id"));
    if (!artist) return c.json({ error: { message: "Not found" } }, 404);
    return c.json({
      id: artist.id,
      name: artist.name,
      images: [{ url: artist.imageUrl }],
    });
  });

  app.get("/v1/playlists/:id/items", (c) => {
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 100)));
    const page = tracks.slice(0, limit).map((track) => ({
      item: toSpotifyTrack(track),
    }));
    return c.json({ items: page, next: null });
  });

  app.get("/v1/me/playlists", (c) => {
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 50)));
    const playlists = [
      {
        collaborative: false,
        description: "Mock seed playlist for local development",
        external_urls: { spotify: "https://open.spotify.com/playlist/mock-seed" },
        href: "https://api.spotify.com/v1/playlists/mock-seed",
        id: "mock-seed",
        images: tracks[0]
          ? [{ url: `https://mock.spotify/album/${tracks[0].id}.jpg`, height: 300, width: 300 }]
          : [],
        name: "Mock Party Mix",
        owner: {
          display_name: "Mock Host",
          external_urls: { spotify: "https://open.spotify.com/user/mock-host" },
          href: "https://api.spotify.com/v1/users/mock-host",
          id: "mock-host",
          type: "user",
          uri: "spotify:user:mock-host",
        },
        public: true,
        snapshot_id: "mock-snapshot",
        items: { href: "https://api.spotify.com/v1/playlists/mock-seed/items", total: tracks.length },
        tracks: { href: "https://api.spotify.com/v1/playlists/mock-seed/tracks", total: tracks.length },
        type: "playlist",
        uri: "spotify:playlist:mock-seed",
      },
      {
        collaborative: true,
        description: null,
        external_urls: { spotify: "https://open.spotify.com/playlist/mock-empty" },
        href: "https://api.spotify.com/v1/playlists/mock-empty",
        id: "mock-empty",
        images: [],
        name: "Empty Playlist",
        owner: {
          display_name: "Friend",
          external_urls: { spotify: "https://open.spotify.com/user/friend" },
          href: "https://api.spotify.com/v1/users/friend",
          id: "friend",
          type: "user",
          uri: "spotify:user:friend",
        },
        public: false,
        snapshot_id: "mock-empty",
        items: { href: "https://api.spotify.com/v1/playlists/mock-empty/items", total: 0 },
        tracks: { href: "https://api.spotify.com/v1/playlists/mock-empty/tracks", total: 0 },
        type: "playlist",
        uri: "spotify:playlist:mock-empty",
      },
      ...[...userPlaylists.values()].map((playlist) => ({
        collaborative: false,
        description: "Ephemeral Jukebox party playlist",
        external_urls: { spotify: `https://open.spotify.com/playlist/${playlist.id}` },
        href: `https://api.spotify.com/v1/playlists/${playlist.id}`,
        id: playlist.id,
        images: [],
        name: playlist.name,
        owner: {
          display_name: "Mock Host",
          external_urls: { spotify: "https://open.spotify.com/user/mock-host" },
          href: "https://api.spotify.com/v1/users/mock-host",
          id: "mock-host",
          type: "user",
          uri: "spotify:user:mock-host",
        },
        public: false,
        snapshot_id: `mock-${playlist.id}`,
        items: {
          href: `https://api.spotify.com/v1/playlists/${playlist.id}/items`,
          total: playlist.trackUris.length,
        },
        tracks: {
          href: `https://api.spotify.com/v1/playlists/${playlist.id}/tracks`,
          total: playlist.trackUris.length,
        },
        type: "playlist",
        uri: playlist.uri,
      })),
    ];
    return c.json({
      href: "https://api.spotify.com/v1/me/playlists",
      limit,
      next: null,
      offset: 0,
      previous: null,
      total: playlists.length,
      items: playlists.slice(0, limit),
    });
  });

  app.post("/v1/me/playlists", async (c) => {
    const body = (await c.req.json()) as { name?: string };
    const id = `mock-party-${nextPlaylistNum++}`;
    const playlist = {
      id,
      name: body.name ?? "Untitled",
      uri: `spotify:playlist:${id}`,
      trackUris: [] as string[],
    };
    userPlaylists.set(id, playlist);
    return c.json({
      collaborative: false,
      description: "Ephemeral Jukebox party playlist",
      external_urls: { spotify: `https://open.spotify.com/playlist/${id}` },
      followers: { href: null, total: 0 },
      href: `https://api.spotify.com/v1/playlists/${id}`,
      id,
      images: [],
      name: playlist.name,
      owner: {
        display_name: "Mock Host",
        external_urls: { spotify: "https://open.spotify.com/user/mock-host" },
        href: "https://api.spotify.com/v1/users/mock-host",
        id: "mock-host",
        type: "user",
        uri: "spotify:user:mock-host",
      },
      public: false,
      snapshot_id: `mock-${id}`,
      tracks: { href: `https://api.spotify.com/v1/playlists/${id}/tracks`, total: 0 },
      type: "playlist",
      uri: playlist.uri,
    });
  });

  app.post("/v1/playlists/:id/items", async (c) => {
    const playlist = userPlaylists.get(c.req.param("id"));
    if (!playlist) return c.json({ error: { message: "Not found" } }, 404);
    const uris = (c.req.query("uris") ?? "").split(",").filter(Boolean);
    playlist.trackUris.push(...uris);
    return c.body(null, 201);
  });

  app.delete("/v1/playlists/:id", (c) => {
    userPlaylists.delete(c.req.param("id"));
    return c.body(null, 200);
  });

  app.get("/v1/me/player/devices", (c) => {
    return c.json({ devices: mockDevices });
  });

  app.get("/v1/me/player", (c) => {
    return c.json(toPlayerResponse(player));
  });

  app.get("/v1/me/player/currently-playing", (c) => {
    const body = toPlayerResponse(player);
    if (!body.item) return c.body(null, 204);
    return c.json({
      is_playing: body.is_playing,
      progress_ms: body.progress_ms,
      item: body.item,
    });
  });

  app.get("/v1/me/player/queue", (c) => {
    const state = player.getState();
    if (!state.currentlyPlaying && state.queue.length === 0) {
      return c.body(null, 204);
    }
    return c.json(toQueueResponse(player));
  });

  app.post("/v1/me/player/queue", (c) => {
    const uri = c.req.query("uri");
    if (uri) player.addToQueue(uri, tracksByUri);
    return c.body(null, 204);
  });

  app.post("/v1/me/player/next", (c) => {
    player.advance();
    return c.body(null, 204);
  });

  app.put("/v1/me/player/play", async (c) => {
    const deviceId = c.req.query("device_id");
    if (deviceId) {
      const device = mockDevices.find((entry) => entry.id === deviceId);
      if (device) {
        player.setDevice({
          id: device.id,
          name: device.name,
          type: device.type,
          is_restricted: device.is_restricted,
        });
      }
    }
    const body = await c.req.json().catch(() => null) as
      | { context_uri?: string; offset?: { position?: number } }
      | null;
    if (body?.context_uri?.startsWith("spotify:playlist:")) {
      const playlistId = body.context_uri.split(":").pop() ?? "";
      const playlist = userPlaylists.get(playlistId);
      if (playlist) {
        const offset = body.offset?.position ?? 0;
        const uri = playlist.trackUris[offset];
        if (uri) {
          player.startTrack(uri, tracksByUri);
        }
      }
    } else {
      player.play();
    }
    return c.body(null, 204);
  });

  app.put("/v1/me/player/pause", (c) => {
    player.pause();
    return c.body(null, 204);
  });

  app.post("/mock/reset", (c) => {
    player.reset();
    return c.json({ ok: true });
  });

  app.post("/mock/advance", (c) => {
    player.advance();
    return c.json(toQueueResponse(player));
  });

  app.post("/mock/rate-limit", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { seconds?: number };
    const seconds = Math.max(1, Number(body.seconds ?? 15));
    player.setRateLimit(seconds);
    return c.json({ ok: true, retryAfterSec: seconds });
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      tracks: tracks.length,
      durationMs,
      progress_ms: player.progressMs(),
      ...toQueueResponse(player),
    }),
  );

  return app;
}
