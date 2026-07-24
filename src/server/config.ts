import type { AppEnv } from "./load-env";

export interface Config {
  env: AppEnv;
  port: number;
  baseUrl: string;
  databasePath: string;
  spotifyClientId: string;
  spotifyClientSecret: string;
  spotifyRedirectUri: string;
  /** ISO 3166-1 alpha-2 — required for artist top-tracks API */
  spotifyMarket: string;
  encryptionKey: string;
  isProduction: boolean;
}

function requireEnv(name: string, env: AppEnv): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.${env}.example to .env.${env} and fill in values.`,
    );
  }
  return value;
}

function assertUrlPolicy(
  env: AppEnv,
  baseUrl: string,
  redirectUri: string,
): void {
  if (baseUrl.includes("localhost") || redirectUri.includes("localhost")) {
    throw new Error(
      "Use 127.0.0.1 instead of localhost — Spotify rejects localhost redirect URIs.",
    );
  }

  if (env === "development") {
    if (!baseUrl.startsWith("http://127.0.0.1")) {
      throw new Error(
        "Development BASE_URL must use http://127.0.0.1 (e.g. http://127.0.0.1:5173)",
      );
    }
    if (!redirectUri.startsWith("http://127.0.0.1")) {
      throw new Error(
        "Development SPOTIFY_REDIRECT_URI must use http://127.0.0.1:3000/...",
      );
    }
  }

  if (env === "production") {
    if (!baseUrl.startsWith("https://")) {
      throw new Error(
        "Production BASE_URL must be https:// (your Cloudflare Tunnel URL)",
      );
    }
    if (!redirectUri.startsWith("https://")) {
      throw new Error(
        "Production SPOTIFY_REDIRECT_URI must be https:// (same host as BASE_URL)",
      );
    }
    const baseHost = new URL(baseUrl).host;
    const redirectHost = new URL(redirectUri).host;
    if (baseHost !== redirectHost) {
      throw new Error(
        "Production BASE_URL and SPOTIFY_REDIRECT_URI must share the same hostname",
      );
    }
  }
}

export function loadConfig(env: AppEnv): Config {
  const isProduction = env === "production";
  const port = Number(process.env.PORT ?? 3000);
  // Dev UI on Vite (:5173); API/oauth callback on :3000. Prod uses one HTTPS URL.
  const baseUrl = isProduction
    ? requireEnv("BASE_URL", env)
    : (process.env.BASE_URL ?? "http://127.0.0.1:5173");
  const spotifyRedirectUri = requireEnv("SPOTIFY_REDIRECT_URI", env);

  assertUrlPolicy(env, baseUrl, spotifyRedirectUri);

  const encryptionKey = requireEnv("ENCRYPTION_KEY", env);
  if (isProduction && encryptionKey.startsWith("dev-only")) {
    throw new Error("Set a strong ENCRYPTION_KEY in .env.production");
  }

  return {
    env,
    port,
    baseUrl,
    databasePath:
      process.env.DATABASE_PATH ??
      (isProduction ? "/data/jukebox.db" : "./data/jukebox-dev.db"),
    spotifyClientId: requireEnv("SPOTIFY_CLIENT_ID", env),
    spotifyClientSecret: requireEnv("SPOTIFY_CLIENT_SECRET", env),
    spotifyRedirectUri,
    spotifyMarket: (process.env.SPOTIFY_MARKET ?? "US").toUpperCase(),
    encryptionKey,
    isProduction,
  };
}

export const SPOTIFY_SCOPES = [
  "user-modify-playback-state",
  "user-read-playback-state",
  "playlist-read-private",
].join(" ");
