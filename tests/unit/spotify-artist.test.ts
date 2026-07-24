import { describe, expect, test } from "bun:test";
import { pickArtistSearchTracks } from "../../src/server/services/spotify";

describe("pickArtistSearchTracks", () => {
  test("prefers tracks credited to the artist", () => {
    const items = [
      { id: "a", artists: [{ id: "artist-1" }] },
      { id: "b", artists: [{ id: "other" }] },
      { id: "c", artists: [{ id: "artist-1" }, { id: "other" }] },
    ];
    expect(pickArtistSearchTracks(items, "artist-1").map((t) => t.id)).toEqual([
      "a",
      "c",
    ]);
  });

  test("falls back to all results when none match", () => {
    const items = [
      { id: "x", artists: [{ id: "other" }] },
      { id: "y", artists: [{ id: "another" }] },
    ];
    expect(pickArtistSearchTracks(items, "artist-1").map((t) => t.id)).toEqual([
      "x",
      "y",
    ]);
  });
});
