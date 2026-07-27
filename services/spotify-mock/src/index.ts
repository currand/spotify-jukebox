import catalog from "../data/catalog.json";
import { createPlayerState, type MockTrack } from "./player";
import { createApp } from "./routes";

const port = Number(process.env.PORT ?? 8080);
/** Effective song length for tracks that omit duration_ms (default 3 minutes). */
const durationMs = Number(
  process.env.MOCK_TRACK_DURATION_MS ??
    process.env.MOCK_TRACK_ADVANCE_MS ??
    180_000,
);
const tracks = catalog.tracks as MockTrack[];

const player = createPlayerState({ tracks, durationMs });
const app = createApp({ player, tracks, durationMs });

/** Tick often enough to promote the next track shortly after a song ends. */
const tickMs = Math.min(1_000, Math.max(100, Math.floor(durationMs / 30)));
setInterval(() => {
  player.tick();
}, tickMs);

console.log(
  `spotify-mock listening on http://0.0.0.0:${port} (${tracks.length} tracks, ${durationMs}ms/song)`,
);

export default {
  port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
