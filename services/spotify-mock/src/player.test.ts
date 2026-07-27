import { describe, expect, test } from "bun:test";
import {
  createPlayerState,
  toPlayerResponse,
  toQueueResponse,
  type MockTrack,
} from "./player";

const tracks: MockTrack[] = [
  {
    uri: "spotify:track:1",
    id: "1",
    name: "One",
    artists: [{ id: "a1", name: "Artist" }],
    album: { images: [{ url: "https://example.com/1.jpg" }] },
    duration_ms: 180_000,
  },
  {
    uri: "spotify:track:2",
    id: "2",
    name: "Two",
    artists: [{ id: "a1", name: "Artist" }],
    album: { images: [{ url: "https://example.com/2.jpg" }] },
    duration_ms: 180_000,
  },
  {
    uri: "spotify:track:3",
    id: "3",
    name: "Three",
    artists: [{ id: "a1", name: "Artist" }],
    album: { images: [{ url: "https://example.com/3.jpg" }] },
    duration_ms: 180_000,
  },
];

const byUri = new Map(tracks.map((t) => [t.uri, t]));

describe("mock player playback", () => {
  test("starts idle with a device but nothing playing", () => {
    const player = createPlayerState({ tracks, durationMs: 180_000 });
    const state = player.getState();

    expect(state.device.id).toBeTruthy();
    expect(state.isPlaying).toBe(false);
    expect(state.currentlyPlaying).toBeNull();
    expect(state.queue).toEqual([]);
    const body = toPlayerResponse(player);
    expect(body.item).toBeNull();
    expect(body.is_playing).toBe(false);
    expect(body.device.id).toBeTruthy();
  });

  test("addToQueue starts playback when idle", () => {
    const player = createPlayerState({ tracks, durationMs: 180_000 });
    player.addToQueue("spotify:track:1", byUri);

    const state = player.getState();
    expect(state.isPlaying).toBe(true);
    expect(state.currentlyPlaying?.uri).toBe("spotify:track:1");
    expect(state.queue).toEqual([]);
  });

  test("addToQueue buffers subsequent tracks without advancing", () => {
    const player = createPlayerState({ tracks, durationMs: 180_000 });
    player.addToQueue("spotify:track:1", byUri);
    player.addToQueue("spotify:track:2", byUri);
    player.addToQueue("spotify:track:3", byUri);

    const state = player.getState();
    expect(state.currentlyPlaying?.uri).toBe("spotify:track:1");
    expect(state.queue.map((t) => t.uri)).toEqual([
      "spotify:track:2",
      "spotify:track:3",
    ]);
  });

  test("does not auto-advance before the track duration elapses", () => {
    let now = 1_000_000;
    const player = createPlayerState({
      tracks,
      durationMs: 180_000,
      now: () => now,
    });
    player.addToQueue("spotify:track:1", byUri);
    player.addToQueue("spotify:track:2", byUri);

    now += 30_000;
    player.tick();

    expect(player.getState().currentlyPlaying?.uri).toBe("spotify:track:1");
    const body = toPlayerResponse(player);
    expect(body?.progress_ms).toBe(30_000);
    expect(body?.item.duration_ms).toBe(180_000);
  });

  test("advances to the next queued track after duration elapses", () => {
    let now = 1_000_000;
    const player = createPlayerState({
      tracks,
      durationMs: 180_000,
      now: () => now,
    });
    player.addToQueue("spotify:track:1", byUri);
    player.addToQueue("spotify:track:2", byUri);

    now += 180_000;
    player.tick();

    expect(player.getState().currentlyPlaying?.uri).toBe("spotify:track:2");
    expect(player.getState().queue).toEqual([]);
    expect(toPlayerResponse(player)?.progress_ms).toBe(0);
  });

  test("stops when the queue is empty after the last track finishes", () => {
    let now = 1_000_000;
    const shortTrack: MockTrack = {
      ...tracks[0]!,
      duration_ms: 60_000,
    };
    const player = createPlayerState({
      tracks: [shortTrack],
      durationMs: 60_000,
      now: () => now,
    });
    player.addToQueue("spotify:track:1", new Map([[shortTrack.uri, shortTrack]]));

    now += 60_000;
    player.tick();

    expect(player.getState().currentlyPlaying).toBeNull();
    expect(player.getState().isPlaying).toBe(false);
    expect(toQueueResponse(player)).toEqual({
      currently_playing: null,
      queue: [],
    });
  });

  test("skip next advances immediately", () => {
    let now = 1_000_000;
    const player = createPlayerState({
      tracks,
      durationMs: 180_000,
      now: () => now,
    });
    player.addToQueue("spotify:track:1", byUri);
    player.addToQueue("spotify:track:2", byUri);

    now += 5_000;
    player.advance();

    expect(player.getState().currentlyPlaying?.uri).toBe("spotify:track:2");
    expect(toPlayerResponse(player)?.progress_ms).toBe(0);
  });

  test("reset returns to idle without seeding the catalog", () => {
    const player = createPlayerState({ tracks, durationMs: 180_000 });
    player.addToQueue("spotify:track:1", byUri);
    player.addToQueue("spotify:track:2", byUri);

    player.reset();

    expect(player.getState().currentlyPlaying).toBeNull();
    expect(player.getState().queue).toEqual([]);
    expect(player.getState().isPlaying).toBe(false);
  });

  test("play and pause toggle playback without advancing", () => {
    const player = createPlayerState({ tracks, durationMs: 180_000 });
    player.addToQueue("spotify:track:1", byUri);
    player.pause();

    expect(player.getState().isPlaying).toBe(false);
    expect(player.getState().currentlyPlaying?.uri).toBe("spotify:track:1");

    player.play();
    expect(player.getState().isPlaying).toBe(true);
  });
});
