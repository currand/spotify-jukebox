import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/server/config";

describe("loadConfig URL policy", () => {
  const baseEnv = {
    SPOTIFY_CLIENT_ID: "id",
    SPOTIFY_CLIENT_SECRET: "secret",
    ENCRYPTION_KEY: "a".repeat(32),
    HOST_SETUP_TOKEN: "setup-token",
  };

  test("allows http production URLs when ALLOW_INSECURE_HTTP=1", () => {
    const prev = { ...process.env };
    try {
      process.env.NODE_ENV = "production";
      process.env.JUKEBOX_ENV = "production";
      process.env.BASE_URL = "http://192.168.1.50:3000";
      process.env.SPOTIFY_REDIRECT_URI =
        "http://192.168.1.50:3000/api/v1/host/spotify/callback";
      process.env.ALLOW_INSECURE_HTTP = "1";
      for (const [key, value] of Object.entries(baseEnv)) {
        process.env[key] = value;
      }

      const config = loadConfig("production");
      expect(config.baseUrl).toBe("http://192.168.1.50:3000");
      expect(config.secureCookies).toBe(false);
    } finally {
      process.env = prev;
    }
  });

  test("requires https in production by default", () => {
    const prev = { ...process.env };
    try {
      process.env.NODE_ENV = "production";
      process.env.JUKEBOX_ENV = "production";
      process.env.BASE_URL = "http://192.168.1.50:3000";
      process.env.SPOTIFY_REDIRECT_URI =
        "http://192.168.1.50:3000/api/v1/host/spotify/callback";
      delete process.env.ALLOW_INSECURE_HTTP;
      for (const [key, value] of Object.entries(baseEnv)) {
        process.env[key] = value;
      }

      expect(() => loadConfig("production")).toThrow(/https/i);
    } finally {
      process.env = prev;
    }
  });
});
