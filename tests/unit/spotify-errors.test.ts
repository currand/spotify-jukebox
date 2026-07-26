import { describe, expect, test } from "bun:test";
import {
  computeRateLimitBackoffMs,
  formatSpotifyErrorForUser,
  getSpotifyRetryAfterMs,
  isSpotifyRateLimitError,
  parseRetryAfterFromBody,
  parseRetryAfterHeader,
  parseRetryAfterMs,
  resolveSpotifyRateLimitMs,
  SpotifyApiError,
} from "../../src/server/services/spotify-errors";

describe("parseRetryAfterHeader", () => {
  test("parses seconds", () => {
    expect(parseRetryAfterHeader("12")).toBe(12000);
  });

  test("treats 0 as 1 second minimum", () => {
    expect(parseRetryAfterHeader("0")).toBe(1000);
  });

  test("returns null when absent", () => {
    expect(parseRetryAfterHeader(null)).toBeNull();
  });
});

describe("parseRetryAfterFromBody", () => {
  test("parses top-level retryAfter", () => {
    expect(
      parseRetryAfterFromBody(
        JSON.stringify({
          error: { status: 429, message: "API rate limit exceeded" },
          retryAfter: 15,
        }),
      ),
    ).toBe(15000);
  });

  test("parses string retryAfter", () => {
    expect(parseRetryAfterFromBody(JSON.stringify({ retryAfter: "8" }))).toBe(
      8000,
    );
  });
});

describe("resolveSpotifyRateLimitMs", () => {
  test("prefers header over body", () => {
    expect(
      resolveSpotifyRateLimitMs(
        "5",
        JSON.stringify({ retryAfter: 30 }),
        429,
      ),
    ).toBe(5000);
  });

  test("falls back to body when header missing", () => {
    expect(
      resolveSpotifyRateLimitMs(
        null,
        JSON.stringify({ retryAfter: 20 }),
        429,
      ),
    ).toBe(20000);
  });

  test("defaults to 5s when neither present", () => {
    expect(
      resolveSpotifyRateLimitMs(
        null,
        JSON.stringify({ error: { status: 429, message: "limit" } }),
        429,
      ),
    ).toBe(5000);
  });
});

describe("parseRetryAfterMs", () => {
  test("parses seconds header", () => {
    expect(parseRetryAfterMs("3", 429)).toBe(3000);
  });

  test("defaults 429 to 5s when header missing", () => {
    expect(parseRetryAfterMs(null, 429)).toBe(5000);
  });
});

describe("isSpotifyRateLimitError", () => {
  test("detects SpotifyApiError 429", () => {
    expect(
      isSpotifyRateLimitError(new SpotifyApiError("SPOTIFY_429:{}", 429, 8000)),
    ).toBe(true);
  });

  test("detects legacy error string", () => {
    expect(
      isSpotifyRateLimitError(
        new Error('SPOTIFY_429:{"error":{"status":429,"message":"API rate limit"}}'),
      ),
    ).toBe(true);
  });
});

describe("computeRateLimitBackoffMs", () => {
  test("enforces minimum backoff above sync tick interval", () => {
    expect(computeRateLimitBackoffMs(5000, 1)).toBe(15_000);
    expect(computeRateLimitBackoffMs(1000, 1)).toBe(15_000);
  });

  test("uses Spotify retry-after when longer than minimum and exponential", () => {
    expect(computeRateLimitBackoffMs(15000, 2)).toBe(15000);
  });

  test("uses exponential backoff when longer than Spotify hint and minimum", () => {
    expect(computeRateLimitBackoffMs(1000, 5)).toBe(16_000);
  });

  test("caps exponential backoff at 60s", () => {
    expect(computeRateLimitBackoffMs(1000, 10)).toBe(60_000);
  });
});

describe("formatSpotifyErrorForUser", () => {
  test("returns re-auth message for revoked refresh token", () => {
    expect(formatSpotifyErrorForUser(new Error("SPOTIFY_REAUTH_REQUIRED"))).toBe(
      "Spotify authorization expired — connect Spotify again in admin.",
    );
  });

  test("returns Spotify API error message when present", () => {
    expect(
      formatSpotifyErrorForUser(
        new Error(
          'SPOTIFY_403:{"error":{"status":403,"message":"Restricted device"}}',
        ),
      ),
    ).toBe("Restricted device");
  });
});

describe("getSpotifyRetryAfterMs", () => {
  test("uses retryAfterMs from SpotifyApiError", () => {
    expect(
      getSpotifyRetryAfterMs(new SpotifyApiError("SPOTIFY_429:{}", 429, 12000)),
    ).toBe(12000);
  });

  test("parses retryAfter from serialized error body", () => {
    expect(
      getSpotifyRetryAfterMs(
        new Error(
          'SPOTIFY_429:{"error":{"status":429,"message":"limit"},"retryAfter":9}',
        ),
      ),
    ).toBe(9000);
  });
});
