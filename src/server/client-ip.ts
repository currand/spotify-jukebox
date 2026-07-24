import type { Context } from "hono";
import { getTrustedClientIp } from "./services/ip-rate-limit";

/** Best-effort client IP (Cloudflare Tunnel, reverse proxy, or direct). */
export function getClientIp(c: Context): string | null {
  return getTrustedClientIp(c);
}
