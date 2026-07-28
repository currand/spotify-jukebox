import { describe, expect, test } from "bun:test";
import {
  formatGuestRateLimitMessage,
  formatRetryAfter,
  formatSearchRateLimitMessage,
  resolveRateLimitMessage,
} from "../../src/shared/rate-limit-messages";

describe("formatRetryAfter", () => {
  test("formats seconds", () => {
    expect(formatRetryAfter(42_000)).toBe("42 seconds");
    expect(formatRetryAfter(1_000)).toBe("1 second");
  });

  test("formats minutes", () => {
    expect(formatRetryAfter(12 * 60_000)).toBe("12 minutes");
    expect(formatRetryAfter(60_000)).toBe("1 minute");
  });

  test("formats hours", () => {
    expect(formatRetryAfter(3_600_000)).toBe("1 hour");
    expect(formatRetryAfter(7_200_000)).toBe("2 hours");
    expect(formatRetryAfter(5_400_000)).toBe("1.5 hours");
  });

  test("returns empty for missing or zero", () => {
    expect(formatRetryAfter(undefined)).toBe("");
    expect(formatRetryAfter(0)).toBe("");
    expect(formatRetryAfter(-1)).toBe("");
  });
});

describe("formatGuestRateLimitMessage", () => {
  test("add uses singular and plural", () => {
    expect(
      formatGuestRateLimitMessage("add", { count: 1, windowMs: 20 * 60_000 }),
    ).toBe("You've added your limit of 1 song.");
    expect(
      formatGuestRateLimitMessage("add", { count: 3, windowMs: 20 * 60_000 }, 12 * 60_000),
    ).toBe("You've added your limit of 3 songs. Try again in 12 minutes.");
  });

  test("upvote and downvote include counts", () => {
    expect(
      formatGuestRateLimitMessage("upvote", { count: 10, windowMs: 3_600_000 }, 45 * 60_000),
    ).toBe("You've used all 10 upvotes. Try again in 45 minutes.");
    expect(
      formatGuestRateLimitMessage("downvote", { count: 1, windowMs: 30 * 60_000 }),
    ).toBe("You've used all 1 downvote.");
  });

  test("boost singular and plural", () => {
    expect(
      formatGuestRateLimitMessage("boost", { count: 1, windowMs: 10 * 60_000 }, 6 * 60_000),
    ).toBe("You've used your boost. Try again in 6 minutes.");
    expect(
      formatGuestRateLimitMessage("boost", { count: 2, windowMs: 10 * 60_000 }),
    ).toBe("You've used all 2 boosts.");
  });

  test("search includes retry timing", () => {
    expect(
      formatGuestRateLimitMessage("search", { count: 6, windowMs: 60_000 }, 42_000),
    ).toBe("You've used all 6 searches. Try again in 42 seconds.");
  });
});

describe("formatSearchRateLimitMessage", () => {
  test("guest search delegates to guest formatter", () => {
    expect(
      formatSearchRateLimitMessage(
        "guest_search",
        { count: 6, windowMs: 60_000 },
        42_000,
      ),
    ).toBe("You've used all 6 searches. Try again in 42 seconds.");
  });

  test("party search and spotify backoff", () => {
    expect(
      formatSearchRateLimitMessage("party_search", { count: 24, windowMs: 30_000 }, 5_000),
    ).toBe("The party has reached its search limit. Try again in 5 seconds.");
    expect(
      formatSearchRateLimitMessage("spotify_backoff", undefined, 30_000),
    ).toBe("Search is temporarily unavailable. Try again in 30 seconds.");
  });
});

describe("resolveRateLimitMessage", () => {
  test("prefers server message when specific", () => {
    expect(
      resolveRateLimitMessage(
        "You've added your limit of 3 songs. Try again in 12 minutes.",
        "fallback",
      ),
    ).toBe("You've added your limit of 3 songs. Try again in 12 minutes.");
  });

  test("falls back for legacy generic messages", () => {
    expect(resolveRateLimitMessage("Rate limited", "You've used all your upvotes.")).toBe(
      "You've used all your upvotes.",
    );
    expect(resolveRateLimitMessage("Search rate limited", "Search fallback")).toBe(
      "Search fallback",
    );
    expect(resolveRateLimitMessage(undefined, "fallback")).toBe("fallback");
  });
});
