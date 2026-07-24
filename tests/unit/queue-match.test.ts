import { describe, expect, test } from "bun:test";
import { isTrackInPartyQueue } from "../../src/shared/queue-match";
import type { QueueItemView } from "../../src/shared/types";

const item = (overrides: Partial<QueueItemView>): QueueItemView => ({
  id: "1",
  spotifyUri: "spotify:track:one",
  trackName: "Bohemian Rhapsody",
  artistName: "Queen",
  albumArtUrl: null,
  upvoteCount: 0,
  vetoCount: 0,
  status: "pending",
  isBoosted: false,
  boostPosition: null,
  addedBy: "Guest",
  addedByGuestId: null,
  addedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("isTrackInPartyQueue", () => {
  test("matches active queue by URI", () => {
    const queue = {
      nowPlaying: null,
      boostLane: [],
      upcoming: [item({ spotifyUri: "spotify:track:abc" })],
      dedupTitles: [],
    };
    expect(
      isTrackInPartyQueue(
        { uri: "spotify:track:abc", name: "Different Title" },
        queue,
      ),
    ).toBe(true);
  });

  test("matches recent history by fuzzy title", () => {
    const queue = {
      nowPlaying: null,
      boostLane: [],
      upcoming: [],
      dedupTitles: ["Bohemian Rhapsody"],
    };
    expect(
      isTrackInPartyQueue(
        { uri: "spotify:track:new", name: "Bohemian Rhapsody" },
        queue,
      ),
    ).toBe(true);
  });

  test("returns false for unrelated tracks", () => {
    const queue = {
      nowPlaying: null,
      boostLane: [],
      upcoming: [item({ trackName: "Other Song", spotifyUri: "spotify:track:other" })],
      dedupTitles: ["Other Song"],
    };
    expect(
      isTrackInPartyQueue(
        { uri: "spotify:track:new", name: "Never Gonna Give You Up" },
        queue,
      ),
    ).toBe(false);
  });

  test("allows re-adding a song that was removed but not played", () => {
    const queue = {
      nowPlaying: null,
      boostLane: [],
      upcoming: [],
      dedupTitles: [],
    };
    expect(
      isTrackInPartyQueue(
        { uri: "spotify:track:new", name: "Bohemian Rhapsody" },
        queue,
      ),
    ).toBe(false);
  });
});
