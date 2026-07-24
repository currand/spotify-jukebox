import { describe, expect, test } from "bun:test";
import { checkIpRateLimit } from "../../src/server/services/ip-rate-limit";

describe("checkIpRateLimit", () => {
  test("allows requests under the limit", () => {
    const key = `test-${crypto.randomUUID()}`;
    expect(checkIpRateLimit(key, 3, 60_000).allowed).toBe(true);
    expect(checkIpRateLimit(key, 3, 60_000).allowed).toBe(true);
    expect(checkIpRateLimit(key, 3, 60_000).allowed).toBe(true);
  });

  test("blocks requests over the limit", () => {
    const key = `test-${crypto.randomUUID()}`;
    checkIpRateLimit(key, 2, 60_000);
    checkIpRateLimit(key, 2, 60_000);
    const blocked = checkIpRateLimit(key, 2, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });
});
