import { describe, expect, test } from "bun:test";
import {
  compareNormalQueue,
  getAdminReorderableNormal,
  getBoostLane,
  getNextUpcomingItem,
  getPlayOrder,
  getSpotifyBufferItem,
  getUpcomingPlayOrder,
  isGuestBoostBlocked,
  isGuestUpvoteBlocked,
  isGuestVetoBlocked,
  type QueueItemRow,
} from "../../src/server/services/queue";

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
  from_spotify: 0,
  added_at: "2026-01-01T00:00:00.000Z",
  finished_at: null,
  duration_ms: null,
  ...overrides,
});

describe("getPlayOrder", () => {
  test("pins queued Spotify buffer before boost lane", () => {
    const queued = base({ id: "queued", status: "queued" });
    const boosted = base({
      id: "boost",
      is_boosted: 1,
      boost_position: 1,
      added_at: "2026-01-02T00:00:00.000Z",
    });
    const later = base({
      id: "later",
      added_at: "2026-01-03T00:00:00.000Z",
    });
    const items = [queued, boosted, later];
    expect(getUpcomingPlayOrder(items).map((i) => i.id)).toEqual([
      "queued",
      "boost",
      "later",
    ]);
    expect(getNextUpcomingItem(items)?.id).toBe("queued");
  });

  test("keeps sole pending normal ahead of boosts (Sending to Spotify)", () => {
    const normal = base({ id: "normal" });
    const boosted = base({
      id: "boost",
      is_boosted: 1,
      boost_position: 1,
      added_at: "2026-01-02T00:00:00.000Z",
    });
    expect(getUpcomingPlayOrder([normal, boosted]).map((i) => i.id)).toEqual([
      "normal",
      "boost",
    ]);
  });

  test("boost lane leads when something is playing", () => {
    const playing = base({ id: "now", status: "playing" });
    const normal = base({
      id: "normal",
      added_at: "2026-01-02T00:00:00.000Z",
    });
    const boosted = base({
      id: "boost",
      is_boosted: 1,
      boost_position: 1,
      added_at: "2026-01-03T00:00:00.000Z",
    });
    expect(
      getUpcomingPlayOrder([playing, normal, boosted]).map((i) => i.id),
    ).toEqual(["boost", "normal"]);
  });

  test("boost lane sorts by upvotes then boost position", () => {
    const lowVotes = base({
      id: "low",
      is_boosted: 1,
      boost_position: 2,
      upvote_count: 1,
    });
    const highVotes = base({
      id: "high",
      is_boosted: 1,
      boost_position: 1,
      upvote_count: 5,
    });
    expect(getBoostLane([lowVotes, highVotes]).map((i) => i.id)).toEqual([
      "high",
      "low",
    ]);
    expect(
      getUpcomingPlayOrder([lowVotes, highVotes]).map((i) => i.id),
    ).toEqual(["high", "low"]);
  });

  test("boost lane leads over multiple normals when not pinned", () => {
    const normalA = base({ id: "a", upvote_count: 5 });
    const normalB = base({
      id: "b",
      upvote_count: 1,
      added_at: "2026-01-02T00:00:00.000Z",
    });
    const boosted = base({
      id: "boost",
      is_boosted: 1,
      boost_position: 1,
      added_at: "2026-01-03T00:00:00.000Z",
    });
    expect(
      getUpcomingPlayOrder([normalA, normalB, boosted]).map((i) => i.id),
    ).toEqual(["boost", "a", "b"]);
  });

  test("includes now playing before upcoming", () => {
    const playing = base({ id: "now", status: "playing" });
    const next = base({ id: "next", added_at: "2026-01-02T00:00:00.000Z" });
    expect(getPlayOrder([playing, next]).map((i) => i.id)).toEqual([
      "now",
      "next",
    ]);
  });
});

describe("guest buffer locks", () => {
  test("locks queued and up-next tracks for upvote/boost", () => {
    const queued = base({ id: "queued", status: "queued" });
    const boosted = base({
      id: "boost",
      is_boosted: 1,
      boost_position: 1,
      added_at: "2026-01-02T00:00:00.000Z",
    });
    const items = [queued, boosted];

    expect(isGuestUpvoteBlocked(items, "queued")).toBe(true);
    expect(isGuestBoostBlocked(items, "boost")).toBe(true);
    expect(isGuestUpvoteBlocked(items, "boost")).toBe(false);
  });

  test("locks Spotify tail tracks adopted as pending", () => {
    const tail = base({
      id: "tail",
      status: "pending",
      from_spotify: 1,
      spotify_uri: "spotify:track:tail",
    });
    const normal = base({
      id: "normal",
      added_at: "2026-01-02T00:00:00.000Z",
    });
    const items = [tail, normal];

    expect(isGuestUpvoteBlocked(items, "tail")).toBe(true);
    expect(isGuestBoostBlocked(items, "tail")).toBe(true);
    expect(isGuestVetoBlocked(items, "tail")).toBe(true);
    expect(isGuestUpvoteBlocked(items, "normal")).toBe(false);
  });
});

describe("getAdminReorderableNormal", () => {
  test("excludes queued buffer and Spotify tail tracks", () => {
    const queued = base({ id: "queued", status: "queued" });
    const tail = base({
      id: "tail",
      status: "pending",
      from_spotify: 1,
      added_at: "2026-01-02T00:00:00.000Z",
    });
    const normal = base({
      id: "normal",
      added_at: "2026-01-03T00:00:00.000Z",
    });
    const items = [queued, tail, normal];

    expect(getAdminReorderableNormal(items).map((i) => i.id)).toEqual([
      "normal",
    ]);
  });
});

describe("compareNormalQueue idle seed priority", () => {
  test("guest add ranks above idle seed with same upvotes", () => {
    const guestAdd = base({
      id: "guest",
      from_seed: 0,
      added_at: "2026-01-02T00:00:00.000Z",
    });
    const idleSeed = base({
      id: "seed",
      from_seed: 1,
      added_at: "2026-01-01T00:00:00.000Z",
    });
    expect([idleSeed, guestAdd].sort(compareNormalQueue).map((i) => i.id)).toEqual([
      "guest",
      "seed",
    ]);
  });

  test("seed with upvotes stays above guest add with zero upvotes", () => {
    const guestAdd = base({
      id: "guest",
      from_seed: 0,
      added_at: "2026-01-02T00:00:00.000Z",
    });
    const votedSeed = base({
      id: "seed",
      from_seed: 1,
      upvote_count: 2,
      added_at: "2026-01-01T00:00:00.000Z",
    });
    expect([guestAdd, votedSeed].sort(compareNormalQueue).map((i) => i.id)).toEqual([
      "seed",
      "guest",
    ]);
  });
});
