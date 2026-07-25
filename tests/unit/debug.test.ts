import { afterEach, describe, expect, test } from "bun:test";
import { debugLog, isDebugEnabled } from "../../src/server/debug";

describe("isDebugEnabled", () => {
  afterEach(() => {
    delete process.env.DEBUG;
  });

  test("disabled when unset", () => {
    expect(isDebugEnabled("spotify")).toBe(false);
  });

  test("enables all for DEBUG=1", () => {
    process.env.DEBUG = "1";
    expect(isDebugEnabled("spotify")).toBe(true);
    expect(isDebugEnabled("sync")).toBe(true);
  });

  test("enables named namespaces", () => {
    process.env.DEBUG = "spotify,sync";
    expect(isDebugEnabled("spotify")).toBe(true);
    expect(isDebugEnabled("sync")).toBe(true);
    expect(isDebugEnabled("http")).toBe(false);
  });
});

describe("debugLog", () => {
  afterEach(() => {
    delete process.env.DEBUG;
  });

  test("does not throw when disabled", () => {
    expect(() => debugLog("spotify", "hello")).not.toThrow();
  });
});
