import type { Context } from "hono";

const buckets = new Map<string, { count: number; resetAt: number }>();

/** Simple in-memory sliding window limiter (per process). */
export function checkIpRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (bucket.count >= limit) {
    return { allowed: false, retryAfterMs: Math.max(0, bucket.resetAt - now) };
  }
  bucket.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}

export function ipRateLimitKey(c: Context, scope: string): string {
  const ip = getTrustedClientIp(c) ?? "unknown";
  return `${scope}:${ip}`;
}

/** Prefer Cloudflare client IP in production; avoid spoofable forwarded headers. */
export function getTrustedClientIp(c: Context): string | null {
  const cf = c.req.header("CF-Connecting-IP")?.trim();
  if (cf) return cf;

  const isProduction =
    process.env.JUKEBOX_ENV === "production" ||
    process.env.NODE_ENV === "production";
  if (isProduction) return null;

  const forwarded = c.req.header("X-Forwarded-For")?.trim();
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = c.req.header("X-Real-IP")?.trim();
  return realIp ?? null;
}
