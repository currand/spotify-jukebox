import { describe, expect, test } from "bun:test";
import { formatGuestQueuePosition } from "../../src/server/services/guests";
import type { QueueItemRow } from "../../src/server/services/queue";

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

describe("formatGuestQueuePosition", () => {
  const upcoming = [
    base({ id: "next", status: "pending" }),
    base({ id: "later", status: "pending", added_at: "2026-01-02T00:00:00.000Z" }),
  ];

  test("labels now playing", () => {
    expect(
      formatGuestQueuePosition("now", "playing", upcoming, "next"),
    ).toBe("Now playing");
  });

  test("labels up next", () => {
    expect(formatGuestQueuePosition("next", "pending", upcoming, "next")).toBe(
      "Up next",
    );
  });

  test("labels queue position", () => {
    expect(
      formatGuestQueuePosition("later", "queued", upcoming, "next"),
    ).toBe("#2 in queue");
  });

  test("returns null for played songs", () => {
    expect(
      formatGuestQueuePosition("old", "played", upcoming, "next"),
    ).toBeNull();
  });
});
