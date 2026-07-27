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
  advanceMs: number;
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

export function createApp({ player, tracks, advanceMs }: AppDeps) {
  const tracksByUri = new Map(tracks.map((track) => [track.uri, track]));
  const artists = uniqueArtists(tracks);
  const app = new Hono();

  app.post("/api/token", async (c) => {
    return c.json({
      access_token: "mock-access-token",
      refresh_token: "mock-refresh-token",
      token_type: "Bearer",
      expires_in: 86400 * 365,
      scope: "user-modify-playback-state user-read-playback-state playlist-read-private",
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

  app.get("/v1/me/player", (c) => {
    const body = toPlayerResponse(player);
    if (!body) return c.body(null, 204);
    return c.json(body);
  });

  app.get("/v1/me/player/currently-playing", (c) => {
    const state = player.getState();
    if (!state.currentlyPlaying) return c.body(null, 204);
    return c.json({
      is_playing: state.isPlaying,
      item: toSpotifyTrack(state.currentlyPlaying),
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

  app.post("/mock/reset", (c) => {
    player.reset(tracks);
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
      advanceMs,
      ...toQueueResponse(player),
    }),
  );

  return app;
}
