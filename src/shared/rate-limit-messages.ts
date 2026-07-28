import type { RateLimitConfig } from "./types";

export type GuestRateLimitAction = "add" | "upvote" | "veto" | "boost" | "search";

export type SearchRateLimitKind =
  | "guest_search"
  | "party_search"
  | "spotify_backoff";

/** Legacy generic messages the client may still receive from older servers. */
export const LEGACY_RATE_LIMIT_MESSAGES = new Set([
  "Rate limited",
  "Search rate limited",
]);

export function formatRetryAfter(ms: number | undefined): string {
  if (ms == null || ms <= 0) return "";
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return seconds === 1 ? "1 second" : `${seconds} seconds`;
  }
  if (ms < 3_600_000) {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  const hours = ms / 3_600_000;
  if (Math.abs(hours - Math.round(hours)) < 0.05) {
    const rounded = Math.round(hours);
    return rounded === 1 ? "1 hour" : `${rounded} hours`;
  }
  return `${hours.toFixed(1)} hours`;
}

function retrySuffix(retryAfterMs: number | undefined): string {
  const duration = formatRetryAfter(retryAfterMs);
  return duration ? ` Try again in ${duration}.` : "";
}

export function formatGuestRateLimitMessage(
  action: GuestRateLimitAction,
  config: RateLimitConfig,
  retryAfterMs?: number,
): string {
  const retry = retrySuffix(retryAfterMs);
  switch (action) {
    case "add": {
      const noun = config.count === 1 ? "song" : "songs";
      return `You've added your limit of ${config.count} ${noun}.${retry}`;
    }
    case "upvote":
      return `You've used all ${config.count} upvote${config.count === 1 ? "" : "s"}.${retry}`;
    case "veto":
      return `You've used all ${config.count} downvote${config.count === 1 ? "" : "s"}.${retry}`;
    case "boost":
      return config.count === 1
        ? `You've used your boost.${retry}`
        : `You've used all ${config.count} boosts.${retry}`;
    case "search":
      return `You've used all ${config.count} search${config.count === 1 ? "" : "es"}.${retry}`;
  }
}

export function formatSearchRateLimitMessage(
  kind: SearchRateLimitKind,
  config: RateLimitConfig | undefined,
  retryAfterMs?: number,
): string {
  const retry = retrySuffix(retryAfterMs);
  switch (kind) {
    case "guest_search":
      return formatGuestRateLimitMessage(
        "search",
        config ?? { count: 1, windowMs: 60_000 },
        retryAfterMs,
      );
    case "party_search":
      return `The party has reached its search limit.${retry}`;
    case "spotify_backoff":
      return `Search is temporarily unavailable.${retry}`;
  }
}

/** Prefer a server-provided message; fall back when it is still generic. */
export function resolveRateLimitMessage(
  serverMessage: string | undefined,
  fallback: string,
): string {
  if (!serverMessage || LEGACY_RATE_LIMIT_MESSAGES.has(serverMessage)) {
    return fallback;
  }
  return serverMessage;
}
