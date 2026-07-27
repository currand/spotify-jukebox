import { describe, expect, test } from "bun:test";
import {
  foldArtist,
  foldTitle,
  isDuplicateDisplayName,
  isDuplicateTitle,
  isDuplicateTrack,
  normalizeTitle,
} from "../../src/shared/dedup";
import {
  compareNormalQueue,
  isGuestBoostBlocked,
  isGuestUpvoteBlocked,
  isGuestVetoBlocked,
  type QueueItemRow,
} from "../../src/server/services/queue";

describe("dedup", () => {
  test("normalizeTitle strips punctuation", () => {
    expect(normalizeTitle("Hello, World!")).toBe("hello world");
  });

  test("foldTitle strips apostrophe and cosmetic remaster suffix", () => {
    expect(foldTitle("Stayin' Alive")).toBe("stayinalive");
    expect(foldTitle("Stayin Alive")).toBe("stayinalive");
    expect(foldTitle("Stayin Alive (2007 Remaster)")).toBe("stayinalive");
  });

  test("foldTitle keeps live and remix suffixes distinct", () => {
    expect(foldTitle("Song (Live)")).toBe("songlive");
    expect(foldTitle("Song (Remix)")).toBe("songremix");
    expect(foldTitle("Song")).toBe("song");
  });

  test("foldArtist normalizes articles and primary artist", () => {
    expect(foldArtist("The Bee Gees")).toBe("beegees");
    expect(foldArtist("Bee Gees")).toBe("beegees");
    expect(foldArtist("Bee Gees, The")).toBe("beegees");
  });

  test("foldTitle folds accented characters", () => {
    expect(foldTitle("Beyoncé")).toBe("beyonce");
    expect(foldTitle("Beyonce")).toBe("beyonce");
  });

  test("detects fuzzy duplicates", () => {
    expect(isDuplicateTitle("Bohemian Rhapsody", ["Bohemian Rhapsody"])).toBe(true);
    expect(isDuplicateTitle("Bohemian Rhapsody", ["Totally Different"])).toBe(false);
  });

  test("detects duplicate tracks by folded title and artist", () => {
    expect(
      isDuplicateTrack(
        { trackName: "Stayin Alive", artistName: "Bee Gees" },
        [{ trackName: "Stayin' Alive", artistName: "The Bee Gees" }],
      ),
    ).toBe(true);
    expect(
      isDuplicateTrack(
        { trackName: "Stayin Alive (2007 Remaster)", artistName: "Bee Gees" },
        [{ trackName: "Stayin' Alive", artistName: "Bee Gees" }],
      ),
    ).toBe(true);
    expect(
      isDuplicateTrack(
        { trackName: "Imagine", artistName: "John Lennon" },
        [{ trackName: "Imagine", artistName: "John Lennon" }],
      ),
    ).toBe(true);
    expect(
      isDuplicateTrack(
        { trackName: "Imagine", artistName: "A Perfect Circle" },
        [{ trackName: "Imagine", artistName: "John Lennon" }],
      ),
    ).toBe(false);
  });

  test("duration guard rejects same fold with very different lengths", () => {
    expect(
      isDuplicateTrack(
        { trackName: "Song", artistName: "Band", durationMs: 210_000 },
        [{ trackName: "Song (Live)", artistName: "Band", durationMs: 360_000 }],
      ),
    ).toBe(false);
  });

  test("duration guard accepts same fold within tolerance", () => {
    expect(
      isDuplicateTrack(
        { trackName: "Stayin Alive", artistName: "Bee Gees", durationMs: 285_000 },
        [{ trackName: "Stayin' Alive (2007 Remaster)", artistName: "The Bee Gees", durationMs: 287_000 }],
      ),
    ).toBe(true);
  });

  test("duration guard skipped when either side lacks duration", () => {
    expect(
      isDuplicateTrack(
        { trackName: "Stayin Alive", artistName: "Bee Gees" },
        [{ trackName: "Stayin' Alive", artistName: "The Bee Gees", durationMs: 285_000 }],
      ),
    ).toBe(true);
  });

  test("detects duplicate display names case-insensitively", () => {
    expect(isDuplicateDisplayName("Bob", ["bob"])).toBe(true);
    expect(isDuplicateDisplayName("Alice", ["Bob"])).toBe(false);
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
    from_seed: 0,
    from_spotify: 0,
    added_at: "2026-01-01T00:00:00.000Z",
    finished_at: null,
    duration_ms: null,
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
    from_seed: 0,
    from_spotify: 0,
    added_at: "2026-01-01T00:00:00.000Z",
    finished_at: null,
    duration_ms: null,
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
