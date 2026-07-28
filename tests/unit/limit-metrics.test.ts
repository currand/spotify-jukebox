import { describe, expect, test } from "bun:test";
import {
  clearLimitHitMetricsForTests,
  getLimitHitMetricsSnapshot,
  recordLimitHit,
} from "../../src/server/services/limit-metrics";

describe("limit-metrics", () => {
  test("tracks guest and search limit hits", () => {
    clearLimitHitMetricsForTests();
    recordLimitHit("guest_upvote");
    recordLimitHit("guest_upvote");
    recordLimitHit("party_search");

    expect(getLimitHitMetricsSnapshot()).toEqual({
      total: 3,
      last5m: 3,
      byKindLast5m: {
        guest_upvote: 2,
        party_search: 1,
      },
      byKindTotal: {
        guest_upvote: 2,
        party_search: 1,
      },
    });
  });
});
