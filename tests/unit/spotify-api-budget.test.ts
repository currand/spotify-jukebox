import { describe, expect, test } from "bun:test";
import {
  acquireSpotifyApiBudgetSlot,
  getSpotifyApiBudgetSnapshotForTests,
  resetSpotifyApiBudgetForTests,
  setSpotifyApiBudgetClockForTests,
  SPOTIFY_API_BUDGET,
} from "../../src/server/services/spotify-api-budget";

describe("spotify API budget", () => {
  test("allows calls up to the budget limit", async () => {
    resetSpotifyApiBudgetForTests();
    for (let i = 0; i < SPOTIFY_API_BUDGET.count; i += 1) {
      await acquireSpotifyApiBudgetSlot();
    }
    expect(getSpotifyApiBudgetSnapshotForTests().count).toBe(
      SPOTIFY_API_BUDGET.count,
    );
  });

  test("waits for window reset before allowing more calls", async () => {
    resetSpotifyApiBudgetForTests();
    let fakeNow = 1_000_000;
    setSpotifyApiBudgetClockForTests(() => fakeNow);

    for (let i = 0; i < SPOTIFY_API_BUDGET.count; i += 1) {
      await acquireSpotifyApiBudgetSlot();
    }

    let waitedMs = 0;
    await acquireSpotifyApiBudgetSlot({
      onWait: (ms) => {
        waitedMs = ms;
      },
      sleep: async (ms) => {
        fakeNow += ms;
      },
    });

    expect(waitedMs).toBeGreaterThan(0);
    expect(getSpotifyApiBudgetSnapshotForTests().count).toBe(1);
  });
});
