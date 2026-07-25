import { describe, expect, test } from "bun:test";
import { isPlaybackActive } from "../../src/server/services/spotify";

describe("isPlaybackActive", () => {
  test("active when device id is present", () => {
    expect(isPlaybackActive({ id: "abc" }, null)).toBe(true);
  });

  test("active when track is playing without device id", () => {
    expect(
      isPlaybackActive(null, { uri: "spotify:track:123" }),
    ).toBe(true);
  });

  test("inactive when neither device nor track", () => {
    expect(isPlaybackActive(null, null)).toBe(false);
  });
});
