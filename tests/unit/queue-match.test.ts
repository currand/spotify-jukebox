import { describe, expect, test } from "bun:test";
import {
  findActiveQueueItem,
  findActiveQueueItemByFold,
  getSearchTrackQueueState,
  isTrackInPartyQueue,
} from "../../src/shared/queue-match";
import type { QueueItemView } from "../../src/shared/types";

const item = (overrides: Partial<QueueItemView>): QueueItemView => ({
  id: "1",
  spotifyUri: "spotify:track:one",
  trackName: "Bohemian Rhapsody",
  artistName: "Queen",
  albumArtUrl: null,
  durationMs: null,
  upvoteCount: 0,
  downvoteCount: 0,
  status: "pending",
  isBoosted: false,
  boostPosition: null,
  boostedBy: null,
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
      upcoming: [item({ spotifyUri: "spotify:track:abc", id: "abc" })],
      dedupTracks: [],
    };
    expect(
      isTrackInPartyQueue(
        { uri: "spotify:track:abc", name: "Different Title", artistName: "X" },
        queue,
      ),
    ).toBe(true);
  });

  test("matches recent history by Spotify URI even when title differs", () => {
    const queue = {
      nowPlaying: null,
      boostLane: [],
      upcoming: [],
      dedupTracks: [
        {
          spotifyUri: "spotify:track:abc",
          trackName: "Bohemian Rhapsody",
          artistName: "Queen",
        },
      ],
    };
    expect(
      isTrackInPartyQueue(
        { uri: "spotify:track:abc", name: "Different Title", artistName: "X" },
        queue,
      ),
    ).toBe(true);
  });

  test("matches recent history by fuzzy title and artist", () => {
    const queue = {
      nowPlaying: null,
      boostLane: [],
      upcoming: [],
      dedupTracks: [{ trackName: "Bohemian Rhapsody", artistName: "Queen" }],
    };
    expect(
      isTrackInPartyQueue(
        { uri: "spotify:track:new", name: "Bohemian Rhapsody", artistName: "Queen" },
        queue,
      ),
    ).toBe(true);
  });

  test("matches Bee Gees variants by fold", () => {
    const queue = {
      nowPlaying: null,
      boostLane: [],
      upcoming: [],
      dedupTracks: [{ trackName: "Stayin' Alive", artistName: "The Bee Gees" }],
    };
    expect(
      isTrackInPartyQueue(
        { uri: "spotify:track:new", name: "Stayin Alive", artistName: "Bee Gees" },
        queue,
      ),
    ).toBe(true);
  });

  test("same title with different artist is not in queue", () => {
    const queue = {
      nowPlaying: null,
      boostLane: [],
      upcoming: [],
      dedupTracks: [{ trackName: "Imagine", artistName: "John Lennon" }],
    };
    expect(
      isTrackInPartyQueue(
        { uri: "spotify:track:new", name: "Imagine", artistName: "A Perfect Circle" },
        queue,
      ),
    ).toBe(false);
  });

  test("returns false for unrelated tracks", () => {
    const queue = {
      nowPlaying: null,
      boostLane: [],
      upcoming: [item({ trackName: "Other Song", spotifyUri: "spotify:track:other" })],
      dedupTracks: [{ trackName: "Other Song", artistName: "Queen" }],
    };
    expect(
      isTrackInPartyQueue(
        { uri: "spotify:track:new", name: "Never Gonna Give You Up", artistName: "Rick Astley" },
        queue,
      ),
    ).toBe(false);
  });

  test("allows re-adding a song that was removed but not played", () => {
    const queue = {
      nowPlaying: null,
      boostLane: [],
      upcoming: [],
      dedupTracks: [],
    };
    expect(
      isTrackInPartyQueue(
        { uri: "spotify:track:new", name: "Bohemian Rhapsody", artistName: "Queen" },
        queue,
      ),
    ).toBe(false);
  });
});

describe("findActiveQueueItem", () => {
  test("returns item when URI is in upcoming order", () => {
    const upcomingItem = item({ id: "up", spotifyUri: "spotify:track:up" });
    const queue = {
      nowPlaying: null,
      boostLane: [],
      upcoming: [upcomingItem],
      dedupTracks: [],
    };
    expect(
      findActiveQueueItem({ uri: "spotify:track:up" }, queue)?.id,
    ).toBe("up");
  });

  test("returns null for dedup-only history match", () => {
    const queue = {
      nowPlaying: null,
      boostLane: [],
      upcoming: [],
      dedupTracks: [{ trackName: "Old Song", artistName: "Band" }],
    };
    expect(
      findActiveQueueItem({ uri: "spotify:track:old" }, queue),
    ).toBeNull();
  });
});

describe("findActiveQueueItemByFold", () => {
  test("returns active item with different URI but same fold", () => {
    const upcomingItem = item({
      id: "bee",
      spotifyUri: "spotify:track:album",
      trackName: "Stayin' Alive",
      artistName: "The Bee Gees",
    });
    const queue = {
      nowPlaying: null,
      boostLane: [],
      upcoming: [upcomingItem],
      dedupTracks: [],
    };
    expect(
      findActiveQueueItemByFold(
        { name: "Stayin Alive", artistName: "Bee Gees" },
        queue,
      )?.id,
    ).toBe("bee");
  });
});

describe("getSearchTrackQueueState", () => {
  test("returns active state with queue item id", () => {
    const upcomingItem = item({ id: "live", spotifyUri: "spotify:track:live" });
    const queue = {
      nowPlaying: null,
      boostLane: [],
      upcoming: [upcomingItem],
      dedupTracks: [],
    };
    expect(
      getSearchTrackQueueState(
        { uri: "spotify:track:live", name: "Live", artistName: "Band" },
        queue,
      ),
    ).toEqual({ blockedReason: "active", queueItemId: "live" });
  });

  test("returns active state for fold match with different URI", () => {
    const upcomingItem = item({
      id: "bee",
      spotifyUri: "spotify:track:album",
      trackName: "Stayin' Alive",
      artistName: "The Bee Gees",
    });
    const queue = {
      nowPlaying: null,
      boostLane: [],
      upcoming: [upcomingItem],
      dedupTracks: [],
    };
    expect(
      getSearchTrackQueueState(
        {
          uri: "spotify:track:compilation",
          name: "Stayin Alive",
          artistName: "Bee Gees",
        },
        queue,
      ),
    ).toEqual({ blockedReason: "active", queueItemId: "bee" });
  });

  test("returns history state without queue item id", () => {
    const queue = {
      nowPlaying: null,
      boostLane: [],
      upcoming: [],
      dedupTracks: [{ trackName: "Played", artistName: "Band" }],
    };
    expect(
      getSearchTrackQueueState(
        { uri: "spotify:track:other", name: "Played", artistName: "Band" },
        queue,
      ),
    ).toEqual({ blockedReason: "history", queueItemId: null });
  });
});
