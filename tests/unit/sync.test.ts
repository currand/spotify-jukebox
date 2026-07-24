import { describe, expect, test } from "bun:test";
import {
  getManagedSpotifyQueueUris,
  isUriBufferedInSpotify,
  shouldAddNextToSpotifyBuffer,
  shouldSkipUnexpectedPlayback,
} from "../../src/server/services/sync";
import type { QueueItemRow } from "../../src/server/services/queue";

describe("isUriBufferedInSpotify", () => {
  const uri = "spotify:track:abc123";

  test("detects track in upcoming queue", () => {
    expect(
      isUriBufferedInSpotify(uri, {
        currentlyPlaying: null,
        queue: [{ uri: "spotify:track:other" }, { uri }],
      }),
    ).toBe(true);
  });

  test("detects track as currently playing", () => {
    expect(
      isUriBufferedInSpotify(uri, {
        currentlyPlaying: { uri },
        queue: [],
      }),
    ).toBe(true);
  });

  test("returns false when track is absent", () => {
    expect(
      isUriBufferedInSpotify(uri, {
        currentlyPlaying: { uri: "spotify:track:other" },
        queue: [{ uri: "spotify:track:another" }],
      }),
    ).toBe(false);
  });
});

describe("getManagedSpotifyQueueUris", () => {
  const base = (overrides: Partial<QueueItemRow>): QueueItemRow => ({
    id: "1",
    party_id: "p",
    spotify_uri: "spotify:track:one",
    track_name: "t",
    artist_name: "a",
    album_art_url: null,
    upvote_count: 0,
    veto_count: 0,
    status: "pending",
    is_boosted: 0,
    boost_position: null,
    manual_order: null,
    added_by_guest_id: null,
    from_seed: 0,
    added_at: "2026-01-01T00:00:00.000Z",
    finished_at: null,
    ...overrides,
  });

  test("returns only active virtual queue URIs from Spotify queue", () => {
    const items = [
      base({ spotify_uri: "spotify:track:stale", status: "pending" }),
      base({ id: "2", spotify_uri: "spotify:track:played", status: "played" }),
    ];
    expect(
      getManagedSpotifyQueueUris(items, {
        queue: [
          { uri: "spotify:track:stale" },
          { uri: "spotify:track:foreign" },
          { uri: "spotify:track:played" },
        ],
      }),
    ).toEqual(["spotify:track:stale"]);
  });
});

describe("shouldAddNextToSpotifyBuffer", () => {
  const base = (overrides: Partial<QueueItemRow>): QueueItemRow => ({
    id: "1",
    party_id: "p",
    spotify_uri: "spotify:track:next",
    track_name: "t",
    artist_name: "a",
    album_art_url: null,
    upvote_count: 0,
    veto_count: 0,
    status: "pending",
    is_boosted: 0,
    boost_position: null,
    manual_order: null,
    added_by_guest_id: null,
    from_seed: 0,
    added_at: "2026-01-01T00:00:00.000Z",
    finished_at: null,
    ...overrides,
  });

  test("allows add when buffer is empty", () => {
    const next = base({});
    const items = [
      next,
      base({ id: "2", spotify_uri: "spotify:track:later", added_at: "2026-01-02T00:00:00.000Z" }),
    ];
    expect(
      shouldAddNextToSpotifyBuffer(
        next,
        items,
        { currentlyPlaying: { uri: "spotify:track:now" }, queue: [] },
        "pending",
        false,
      ),
    ).toBe(true);
  });

  test("defers add when another jukebox track occupies Spotify buffer", () => {
    const next = base({ spotify_uri: "spotify:track:new-next" });
    const stale = base({
      id: "2",
      spotify_uri: "spotify:track:stale",
      added_at: "2026-01-02T00:00:00.000Z",
    });
    expect(
      shouldAddNextToSpotifyBuffer(
        next,
        [next, stale],
        {
          currentlyPlaying: { uri: "spotify:track:now" },
          queue: [{ uri: "spotify:track:stale" }],
        },
        "pending",
        false,
      ),
    ).toBe(false);
  });

  test("does not add when virtual next is already buffered", () => {
    const next = base({});
    expect(
      shouldAddNextToSpotifyBuffer(
        next,
        [next],
        {
          currentlyPlaying: { uri: "spotify:track:now" },
          queue: [{ uri: next.spotify_uri }],
        },
        "pending",
        false,
      ),
    ).toBe(false);
  });
});

describe("shouldSkipUnexpectedPlayback", () => {
  const base = (overrides: Partial<QueueItemRow>): QueueItemRow => ({
    id: "1",
    party_id: "p",
    spotify_uri: "spotify:track:one",
    track_name: "t",
    artist_name: "a",
    album_art_url: null,
    upvote_count: 0,
    veto_count: 0,
    status: "pending",
    is_boosted: 0,
    boost_position: null,
    manual_order: null,
    added_by_guest_id: null,
    from_seed: 0,
    added_at: "2026-01-01T00:00:00.000Z",
    finished_at: null,
    ...overrides,
  });

  test("skips vetoed tracks", () => {
    const item = base({ status: "vetoed" });
    expect(shouldSkipUnexpectedPlayback(item, [item])).toBe(true);
  });

  test("skips demoted tracks that are no longer virtual next", () => {
    const stale = base({ id: "stale", spotify_uri: "spotify:track:stale" });
    const next = base({
      id: "next",
      spotify_uri: "spotify:track:next",
      upvote_count: 5,
      added_at: "2026-01-02T00:00:00.000Z",
    });
    expect(shouldSkipUnexpectedPlayback(stale, [stale, next])).toBe(true);
  });

  test("allows expected virtual next to play", () => {
    const next = base({ id: "next" });
    const later = base({
      id: "later",
      spotify_uri: "spotify:track:later",
      added_at: "2026-01-02T00:00:00.000Z",
    });
    expect(shouldSkipUnexpectedPlayback(next, [next, later])).toBe(false);
  });
});
