import type { AppEnv } from "./load-env";

export interface Config {
  env: AppEnv;
  port: number;
  baseUrl: string;
  databasePath: string;
  spotifyClientId: string;
  spotifyClientSecret: string;
  spotifyRedirectUri: string;
  encryptionKey: string;
  hostSetupToken: string | null;
  isProduction: boolean;
  /** false when BASE_URL uses http:// (e.g. LAN or TLS terminated elsewhere) */
  secureCookies: boolean;
  spotifyApiBudgetCount: number;
  spotifyApiBudgetWindowMs: number;
  /** Warn in diagnostics when 24h API calls exceed this; null disables warning */
  spotifyDailyWarnCalls: number | null;
}

function parseOptionalPositiveInt(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Math.floor(parsed);
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Math.floor(parsed);
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
  allowInsecureHttp: boolean,
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
    const baseHttps = baseUrl.startsWith("https://");
    const redirectHttps = redirectUri.startsWith("https://");
    if (!allowInsecureHttp && !baseHttps) {
      throw new Error(
        "Production BASE_URL must be https:// (your public URL), or set ALLOW_INSECURE_HTTP=1 for http:// LAN/proxy setups",
      );
    }
    if (!allowInsecureHttp && !redirectHttps) {
      throw new Error(
        "Production SPOTIFY_REDIRECT_URI must be https:// (same host as BASE_URL), or set ALLOW_INSECURE_HTTP=1",
      );
    }
    if (allowInsecureHttp && baseHttps !== redirectHttps) {
      throw new Error(
        "BASE_URL and SPOTIFY_REDIRECT_URI must both use http:// or both use https://",
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
  const allowInsecureHttp =
    process.env.ALLOW_INSECURE_HTTP === "1" ||
    process.env.ALLOW_INSECURE_HTTP === "true";

  assertUrlPolicy(env, baseUrl, spotifyRedirectUri, allowInsecureHttp);

  const encryptionKey = requireEnv("ENCRYPTION_KEY", env);
  if (isProduction && encryptionKey.startsWith("dev-only")) {
    throw new Error("Set a strong ENCRYPTION_KEY in .env.production");
  }
  if (isProduction && encryptionKey.length < 32) {
    throw new Error(
      "ENCRYPTION_KEY must be at least 32 characters (use: openssl rand -hex 32)",
    );
  }

  const hostSetupToken = isProduction
    ? requireEnv("HOST_SETUP_TOKEN", env)
    : (process.env.HOST_SETUP_TOKEN ?? null);

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
    encryptionKey,
    hostSetupToken,
    isProduction,
    secureCookies: baseUrl.startsWith("https://"),
    spotifyApiBudgetCount: parsePositiveInt("SPOTIFY_API_BUDGET_COUNT", 90),
    spotifyApiBudgetWindowMs: parsePositiveInt("SPOTIFY_API_BUDGET_WINDOW_MS", 30_000),
    spotifyDailyWarnCalls: parseOptionalPositiveInt("SPOTIFY_DAILY_WARN_CALLS") ?? 8000,
  };
}

export const SPOTIFY_SCOPES = [
  "user-modify-playback-state",
  "user-read-playback-state",
  "playlist-read-private",
].join(" ");
