import type { PartyRateLimits } from "@/shared/types";
import type { AppEnv } from "./load-env";

export type SpotifyMode = "live" | "mock";

export interface Config {
  env: AppEnv;
  port: number;
  baseUrl: string;
  databasePath: string;
  spotifyMode: SpotifyMode;
  spotifyApiBaseUrl: string;
  spotifyAccountsBaseUrl: string;
  spotifyClientId: string;
  spotifyClientSecret: string;
  spotifyRedirectUri: string;
  encryptionKey: string;
  hostSetupToken: string | null;
  /** When false, OAuth login skips HOST_SETUP_TOKEN (localhost-only or Cloudflare tunnel). */
  hostSetupTokenRequired: boolean;
  /** Server bind address (127.0.0.1 = localhost only; 0.0.0.0 = all interfaces). */
  bindHost: string;
  isProduction: boolean;
  /** false when BASE_URL uses http:// (e.g. LAN or TLS terminated elsewhere) */
  secureCookies: boolean;
  spotifyApiBudgetCount: number;
  spotifyApiBudgetWindowMs: number;
  /** Warn in diagnostics when 24h API calls exceed this; null disables warning */
  spotifyDailyWarnCalls: number | null;
  /** When true, sync worker polls Spotify every 10s (legacy behavior). */
  syncFastPoll: boolean;
  /** Poll this many ms before estimated track end (adaptive mode). */
  syncEndWindowMs: number;
  /** Poll interval when playing but track timing is unknown. */
  syncFallbackIntervalMs: number;
  /** Poll interval when idle or paused with no pending sync work. */
  syncIdleIntervalMs: number;
  /** Optional env override for guest default rate limits (below DB-stored host settings). */
  defaultRateLimits: PartyRateLimits | null;
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

function parseBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  throw new Error(`${name} must be true/false or 1/0`);
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

function parseSpotifyMode(env: AppEnv): SpotifyMode {
  const raw = process.env.SPOTIFY_MODE?.trim().toLowerCase();
  if (!raw || raw === "live") return "live";
  if (raw === "mock") {
    if (env === "production") {
      throw new Error("SPOTIFY_MODE=mock is only allowed when JUKEBOX_ENV=development");
    }
    return "mock";
  }
  throw new Error("SPOTIFY_MODE must be live or mock");
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

const RATE_LIMIT_ACTION_KEYS = [
  "add",
  "upvote",
  "downvote",
  "boost",
  "search",
  "partySearch",
] as const;

function isValidRateLimitConfigShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const { count, windowMs } = value as { count?: unknown; windowMs?: unknown };
  return (
    Number.isInteger(count) &&
    (count as number) >= 1 &&
    Number.isInteger(windowMs) &&
    (windowMs as number) >= 1000
  );
}

function parseDefaultRateLimitsFromEnv(): PartyRateLimits | null {
  const raw = process.env.JUKEBOX_DEFAULT_RATE_LIMITS?.trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("JUKEBOX_DEFAULT_RATE_LIMITS must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JUKEBOX_DEFAULT_RATE_LIMITS must be a JSON object");
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(RATE_LIMIT_ACTION_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `JUKEBOX_DEFAULT_RATE_LIMITS has unknown key "${key}" (expected one of: ${RATE_LIMIT_ACTION_KEYS.join(", ")})`,
      );
    }
    if (!isValidRateLimitConfigShape(value)) {
      throw new Error(
        `JUKEBOX_DEFAULT_RATE_LIMITS.${key} must be { count: integer >= 1, windowMs: integer >= 1000 }`,
      );
    }
  }
  return parsed as PartyRateLimits;
}

function parseBindHost(
  env: AppEnv,
  isProduction: boolean,
  spotifyMode: SpotifyMode,
): string {
  const raw = process.env.BIND_HOST?.trim();
  if (raw) {
    if (raw !== "127.0.0.1" && raw !== "0.0.0.0") {
      throw new Error('BIND_HOST must be "127.0.0.1" or "0.0.0.0"');
    }
    return raw;
  }
  return isProduction || spotifyMode === "mock" ? "0.0.0.0" : "127.0.0.1";
}

function parseHostSetupTokenPolicy(
  env: AppEnv,
  isProduction: boolean,
  bindHost: string,
  baseUrl: string,
): { hostSetupToken: string | null; hostSetupTokenRequired: boolean } {
  if (!isProduction) {
    const token = process.env.HOST_SETUP_TOKEN?.trim() || null;
    return { hostSetupToken: token, hostSetupTokenRequired: Boolean(token) };
  }

  const cloudflareTunnel =
    parseBoolean("CLOUDFLARE_TUNNEL", false) ||
    parseBoolean("JUKEBOX_CLOUDFLARE_TUNNEL", false);
  const localhostOnly =
    bindHost === "127.0.0.1" ||
    new URL(baseUrl).hostname === "127.0.0.1";
  const explicitlyDisabled = parseBoolean("DISABLE_HOST_SETUP_TOKEN", false);

  if (cloudflareTunnel || localhostOnly || explicitlyDisabled) {
    return { hostSetupToken: null, hostSetupTokenRequired: false };
  }

  return {
    hostSetupToken: requireEnv("HOST_SETUP_TOKEN", env),
    hostSetupTokenRequired: true,
  };
}

export function loadConfig(env: AppEnv): Config {
  const isProduction = env === "production";
  const spotifyMode = parseSpotifyMode(env);
  const port = Number(process.env.PORT ?? 3000);
  // Dev UI on Vite (:5173); API/oauth callback on :3000. Prod uses one HTTPS URL.
  const baseUrl = isProduction
    ? requireEnv("BASE_URL", env)
    : (process.env.BASE_URL ?? "http://127.0.0.1:5173");
  const spotifyRedirectUri =
    spotifyMode === "mock"
      ? optionalEnv(
          "SPOTIFY_REDIRECT_URI",
          "http://127.0.0.1:3000/api/v1/host/spotify/callback",
        )
      : requireEnv("SPOTIFY_REDIRECT_URI", env);
  const allowInsecureHttp =
    process.env.ALLOW_INSECURE_HTTP === "1" ||
    process.env.ALLOW_INSECURE_HTTP === "true";

  assertUrlPolicy(env, baseUrl, spotifyRedirectUri, allowInsecureHttp);

  const encryptionKey =
    spotifyMode === "mock"
      ? optionalEnv("ENCRYPTION_KEY", "dev-only-change-me")
      : requireEnv("ENCRYPTION_KEY", env);
  if (isProduction && encryptionKey.startsWith("dev-only")) {
    throw new Error("Set a strong ENCRYPTION_KEY in .env.production");
  }
  if (isProduction && encryptionKey.length < 32) {
    throw new Error(
      "ENCRYPTION_KEY must be at least 32 characters (use: openssl rand -hex 32)",
    );
  }

  const bindHost = parseBindHost(env, isProduction, spotifyMode);
  const { hostSetupToken, hostSetupTokenRequired } = parseHostSetupTokenPolicy(
    env,
    isProduction,
    bindHost,
    baseUrl,
  );

  const spotifyApiBaseUrl = optionalEnv(
    "SPOTIFY_API_BASE_URL",
    "https://api.spotify.com/v1",
  ).replace(/\/$/, "");
  const spotifyAccountsBaseUrl = optionalEnv(
    "SPOTIFY_ACCOUNTS_BASE_URL",
    "https://accounts.spotify.com",
  ).replace(/\/$/, "");

  return {
    env,
    port,
    baseUrl,
    databasePath:
      process.env.DATABASE_PATH ??
      (isProduction ? "/data/jukebox.db" : "./data/jukebox-dev.db"),
    spotifyMode,
    spotifyApiBaseUrl,
    spotifyAccountsBaseUrl,
    spotifyClientId:
      spotifyMode === "mock"
        ? optionalEnv("SPOTIFY_CLIENT_ID", "mock-client")
        : requireEnv("SPOTIFY_CLIENT_ID", env),
    spotifyClientSecret:
      spotifyMode === "mock"
        ? optionalEnv("SPOTIFY_CLIENT_SECRET", "mock-secret")
        : requireEnv("SPOTIFY_CLIENT_SECRET", env),
    spotifyRedirectUri,
    encryptionKey,
    hostSetupToken,
    hostSetupTokenRequired,
    bindHost,
    isProduction,
    secureCookies: baseUrl.startsWith("https://"),
    spotifyApiBudgetCount: parsePositiveInt("SPOTIFY_API_BUDGET_COUNT", 90),
    spotifyApiBudgetWindowMs: parsePositiveInt("SPOTIFY_API_BUDGET_WINDOW_MS", 30_000),
    spotifyDailyWarnCalls: parseOptionalPositiveInt("SPOTIFY_DAILY_WARN_CALLS") ?? 8000,
    syncFastPoll: parseBoolean("SYNC_FAST_POLL", false),
    syncEndWindowMs: parsePositiveInt("SYNC_END_WINDOW_MS", 7000),
    syncFallbackIntervalMs: parsePositiveInt("SYNC_FALLBACK_INTERVAL_MS", 30_000),
    syncIdleIntervalMs: parsePositiveInt("SYNC_IDLE_INTERVAL_MS", 60_000),
    defaultRateLimits: parseDefaultRateLimitsFromEnv(),
  };
}

export const SPOTIFY_SCOPES = [
  "user-modify-playback-state",
  "user-read-playback-state",
  "playlist-read-private",
].join(" ");
