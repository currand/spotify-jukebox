export class SpotifyApiError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(message: string, status: number, retryAfterMs: number | null = null) {
    super(message);
    this.name = "SpotifyApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function coerceRetryAfterSeconds(value: unknown): number | null {
  if (typeof value === "number" && !Number.isNaN(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

/** Convert Spotify Retry-After seconds to ms; 0 means "wait briefly" — use 1s minimum. */
export function retryAfterSecondsToMs(seconds: number): number {
  if (seconds === 0) return 1000;
  return Math.max(1000, seconds * 1000);
}

/** Parse Retry-After HTTP header (seconds or HTTP-date). Returns null when absent. */
export function parseRetryAfterHeader(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return retryAfterSecondsToMs(seconds);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.max(1000, date - Date.now());
  }
  return null;
}

/** Parse retryAfter / retry_after from a Spotify 429 JSON body. */
export function parseRetryAfterFromBody(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as {
      retryAfter?: unknown;
      retry_after?: unknown;
      error?: { retryAfter?: unknown; retry_after?: unknown };
    };
    const seconds =
      coerceRetryAfterSeconds(parsed.retryAfter) ??
      coerceRetryAfterSeconds(parsed.retry_after) ??
      coerceRetryAfterSeconds(parsed.error?.retryAfter) ??
      coerceRetryAfterSeconds(parsed.error?.retry_after);
    if (seconds != null) return retryAfterSecondsToMs(seconds);
  } catch {
    // not JSON
  }
  return null;
}

/** Resolve backoff duration for a Spotify rate-limit response. Header wins, then body. */
export function resolveSpotifyRateLimitMs(
  retryAfterHeader: string | null,
  body: string | null,
  status?: number,
): number {
  const fromHeader = parseRetryAfterHeader(retryAfterHeader);
  if (fromHeader != null) return fromHeader;

  if (body) {
    const fromBody = parseRetryAfterFromBody(body);
    if (fromBody != null) return fromBody;
  }

  if (status === 429) return 5000;
  return 5000;
}

/** @deprecated Use parseRetryAfterHeader or resolveSpotifyRateLimitMs */
export function parseRetryAfterMs(
  header: string | null,
  status?: number,
): number | null {
  const fromHeader = parseRetryAfterHeader(header);
  if (fromHeader != null) return fromHeader;
  if (status === 429) return 5000;
  return null;
}

export function parseSpotifyError(message: string): {
  status: number | null;
  spotifyMessage: string | null;
} {
  const match = message.match(/^SPOTIFY_(\d+):(.*)$/s);
  if (!match) return { status: null, spotifyMessage: null };
  try {
    const body = JSON.parse(match[2]) as {
      error?: { status?: number; message?: string };
    };
    return {
      status: Number(match[1]),
      spotifyMessage: body.error?.message ?? null,
    };
  } catch {
    return { status: Number(match[1]), spotifyMessage: null };
  }
}

export function getSpotifyErrorStatus(error: unknown): number | null {
  if (error instanceof SpotifyApiError) return error.status;
  const message = error instanceof Error ? error.message : String(error);
  return parseSpotifyError(message).status;
}

export function isSpotifyRateLimitError(error: unknown): boolean {
  return getSpotifyErrorStatus(error) === 429;
}

export function getSpotifyRetryAfterMs(error: unknown): number {
  if (error instanceof SpotifyApiError && error.retryAfterMs != null) {
    return error.retryAfterMs;
  }

  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/^SPOTIFY_429:(.*)$/s);
  if (match) {
    return resolveSpotifyRateLimitMs(null, match[1], 429);
  }

  if (isSpotifyRateLimitError(error)) return 5000;
  return 5000;
}

/** Combine Spotify Retry-After with exponential backoff on repeated 429s. */
export function computeRateLimitBackoffMs(
  spotifyRetryAfterMs: number,
  consecutiveHits: number,
): number {
  const exponentialMs = Math.min(
    60_000,
    1000 * 2 ** Math.max(0, consecutiveHits - 1),
  );
  return Math.max(spotifyRetryAfterMs, exponentialMs);
}

export function formatSpotifyErrorForUser(error: unknown): string | null {
  if (error instanceof Error && error.message === "SPOTIFY_REAUTH_REQUIRED") {
    return "Spotify authorization expired — connect Spotify again in admin.";
  }
  if (error instanceof Error && error.message === "NOT_CONNECTED") {
    return "Spotify not connected.";
  }

  const message = error instanceof Error ? error.message : String(error);
  const { status, spotifyMessage } = parseSpotifyError(message);
  if (spotifyMessage) return spotifyMessage;

  if (status === 429) {
    return "Spotify rate limit exceeded — slowing down requests.";
  }
  if (status === 401) {
    return "Spotify authorization expired — connect Spotify again in admin.";
  }
  if (status === 403) {
    return "Spotify denied this action — check device and permissions.";
  }
  return null;
}

export function isSpotifyReauthRequired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === "SPOTIFY_REAUTH_REQUIRED";
}

export function isRestrictedDeviceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const { status, spotifyMessage } = parseSpotifyError(message);
  return status === 403 && spotifyMessage === "Restricted device";
}

export function isNoActiveDeviceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("SPOTIFY_404") ||
    message.includes("SPOTIFY_204") ||
    message.includes("NO_ACTIVE_DEVICE")
  );
}
