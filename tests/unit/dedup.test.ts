import { describe, expect, test } from "bun:test";
import { isDuplicateTitle, normalizeTitle } from "../../src/shared/dedup";
import { compareNormalQueue, isGuestBoostBlocked, isGuestUpvoteBlocked, isGuestVetoBlocked, type QueueItemRow } from "../../src/server/services/queue";

describe("dedup", () => {
  test("normalizeTitle strips punctuation", () => {
    expect(normalizeTitle("Hello, World!")).toBe("hello world");
  });

  test("detects fuzzy duplicates", () => {
    expect(isDuplicateTitle("Bohemian Rhapsody", ["Bohemian Rhapsody"])).toBe(true);
    expect(isDuplicateTitle("Bohemian Rhapsody", ["Totally Different"])).toBe(false);
  });
});

describe("queue sort", () => {
  const base = (overrides: Partial<QueueItemRow>): QueueItemRow => ({
    id: "1",
    party_id: "p",
    spotify_uri: "uri",
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
    added_at: "2026-01-01T00:00:00.000Z",
    finished_at: null,
    ...overrides,
  });

  test("sorts by upvotes then addedAt", () => {
    const a = base({ id: "a", upvote_count: 2, added_at: "2026-01-02T00:00:00.000Z" });
    const b = base({ id: "b", upvote_count: 5, added_at: "2026-01-03T00:00:00.000Z" });
    const c = base({ id: "c", upvote_count: 2, added_at: "2026-01-01T00:00:00.000Z" });
    expect([a, b, c].sort(compareNormalQueue).map((i) => i.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
});

describe("guest action locks", () => {
  const base = (overrides: Partial<QueueItemRow>): QueueItemRow => ({
    id: "1",
    party_id: "p",
    spotify_uri: "uri",
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
    added_at: "2026-01-01T00:00:00.000Z",
    finished_at: null,
    ...overrides,
  });

  test("blocks upvote/boost for pending next-up, not veto", () => {
    const next = base({ id: "next", status: "pending" });
    const later = base({ id: "later", status: "pending", added_at: "2026-01-02T00:00:00.000Z" });
    const items = [next, later];

    expect(isGuestUpvoteBlocked(items, "next")).toBe(true);
    expect(isGuestBoostBlocked(items, "next")).toBe(true);
    expect(isGuestVetoBlocked(items, "next")).toBe(false);

    expect(isGuestUpvoteBlocked(items, "later")).toBe(false);
    expect(isGuestBoostBlocked(items, "later")).toBe(false);
  });

  test("blocks all guest actions when queued in Spotify", () => {
    const next = base({ id: "next", status: "queued" });
    const items = [next];

    expect(isGuestUpvoteBlocked(items, "next")).toBe(true);
    expect(isGuestBoostBlocked(items, "next")).toBe(true);
    expect(isGuestVetoBlocked(items, "next")).toBe(true);
  });
});
