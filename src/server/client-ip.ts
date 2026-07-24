import type { Context } from "hono";

/** Best-effort client IP (Cloudflare Tunnel, reverse proxy, or direct). */
export function getClientIp(c: Context): string | null {
  const cf = c.req.header("CF-Connecting-IP")?.trim();
  if (cf) return cf;

  const forwarded = c.req.header("X-Forwarded-For")?.trim();
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = c.req.header("X-Real-IP")?.trim();
  if (realIp) return realIp;

  return null;
}
