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

  test("rejects mock mode in production", () => {
    const prev = { ...process.env };
    try {
      process.env.SPOTIFY_MODE = "mock";
      expect(() => loadConfig("production")).toThrow(/mock/i);
    } finally {
      process.env = prev;
    }
  });

  test("allows mock mode in development with defaults", () => {
    const prev = { ...process.env };
    try {
      delete process.env.SPOTIFY_CLIENT_ID;
      delete process.env.SPOTIFY_CLIENT_SECRET;
      delete process.env.SPOTIFY_REDIRECT_URI;
      delete process.env.ENCRYPTION_KEY;
      process.env.SPOTIFY_MODE = "mock";
      process.env.SPOTIFY_API_BASE_URL = "http://127.0.0.1:8080/v1";
      process.env.SPOTIFY_ACCOUNTS_BASE_URL = "http://127.0.0.1:8080";

      const config = loadConfig("development");
      expect(config.spotifyMode).toBe("mock");
      expect(config.spotifyClientId).toBe("mock-client");
      expect(config.spotifyApiBaseUrl).toBe("http://127.0.0.1:8080/v1");
      expect(config.bindHost).toBe("0.0.0.0");
    } finally {
      process.env = prev;
    }
  });

  test("requires HOST_SETUP_TOKEN when env value is set", () => {
    const prev = { ...process.env };
    try {
      process.env.NODE_ENV = "production";
      process.env.JUKEBOX_ENV = "production";
      process.env.BASE_URL = "https://jukebox.example.com";
      process.env.SPOTIFY_REDIRECT_URI =
        "https://jukebox.example.com/api/v1/host/spotify/callback";
      for (const [key, value] of Object.entries(baseEnv)) {
        process.env[key] = value;
      }

      const config = loadConfig("production");
      expect(config.hostSetupTokenRequired).toBe(true);
      expect(config.hostSetupToken).toBe("setup-token");
    } finally {
      process.env = prev;
    }
  });

  test("skips HOST_SETUP_TOKEN when env value is unset", () => {
    const prev = { ...process.env };
    try {
      process.env.NODE_ENV = "production";
      process.env.JUKEBOX_ENV = "production";
      process.env.BASE_URL = "http://127.0.0.1:3000";
      process.env.SPOTIFY_REDIRECT_URI =
        "http://127.0.0.1:3000/api/v1/host/spotify/callback";
      process.env.ALLOW_INSECURE_HTTP = "1";
      process.env.BIND_HOST = "127.0.0.1";
      for (const [key, value] of Object.entries(baseEnv)) {
        process.env[key] = value;
      }
      delete process.env.HOST_SETUP_TOKEN;

      const config = loadConfig("production");
      expect(config.hostSetupTokenRequired).toBe(false);
      expect(config.hostSetupToken).toBeNull();
      expect(config.bindHost).toBe("127.0.0.1");
    } finally {
      process.env = prev;
    }
  });

  test("requires HOST_SETUP_TOKEN in development when env value is set", () => {
    const prev = { ...process.env };
    try {
      process.env.SPOTIFY_CLIENT_ID = "id";
      process.env.SPOTIFY_CLIENT_SECRET = "secret";
      process.env.SPOTIFY_REDIRECT_URI =
        "http://127.0.0.1:3000/api/v1/host/spotify/callback";
      process.env.ENCRYPTION_KEY = "a".repeat(32);
      process.env.HOST_SETUP_TOKEN = "setup-token";
      const config = loadConfig("development");
      expect(config.hostSetupTokenRequired).toBe(true);
      expect(config.hostSetupToken).toBe("setup-token");
    } finally {
      process.env = prev;
    }
  });
});
