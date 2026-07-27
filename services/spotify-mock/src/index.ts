import catalog from "../data/catalog.json";
import { createPlayerState, type MockTrack } from "./player";
import { createApp } from "./routes";

const port = Number(process.env.PORT ?? 8080);
const advanceMs = Number(process.env.MOCK_TRACK_ADVANCE_MS ?? 30_000);
const tracks = catalog.tracks as MockTrack[];

const player = createPlayerState(tracks);
const app = createApp({ player, tracks, advanceMs });

setInterval(() => {
  player.advance();
}, advanceMs);

console.log(
  `spotify-mock listening on http://0.0.0.0:${port} (${tracks.length} tracks, advance every ${advanceMs}ms)`,
);

export default {
  port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
