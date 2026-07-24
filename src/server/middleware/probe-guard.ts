import type { Context, Next } from "hono";
import {
  checkIpRateLimit,
  ipRateLimitKey,
} from "../services/ip-rate-limit";

/** Common vulnerability-scan paths — not used by Jukebox. */
const SCANNER_PATH =
  /\.(env|git|sql|bak|php|asp|aspx|config)$/i;

const SCANNER_PREFIX =
  /^\/(?:wp-admin|wp-login|phpmyadmin|administrator|\.git|\.env|actuator|api\/jsonws)/;

/** Limit automated host/admin probing. Party guest APIs are not limited by IP. */
const HOST_PROBE_LIMIT = { count: 120, windowMs: 60_000 };
const SCANNER_LIMIT = { count: 30, windowMs: 60_000 };

function isScannerPath(pathname: string): boolean {
  return SCANNER_PATH.test(pathname) || SCANNER_PREFIX.test(pathname);
}

function isHostProbePath(pathname: string): boolean {
  if (!pathname.startsWith("/api/v1/host/")) return false;
  // Public read-only status — allow normal admin polling
  if (pathname === "/api/v1/host/spotify/status") return false;
  return true;
}

export function probeGuardMiddleware() {
  return async (c: Context, next: Next) => {
    const pathname = new URL(c.req.url).pathname;

    if (isScannerPath(pathname)) {
      const limit = checkIpRateLimit(
        ipRateLimitKey(c, "scanner"),
        SCANNER_LIMIT.count,
        SCANNER_LIMIT.windowMs,
      );
      if (!limit.allowed) {
        return c.body(null, 404);
      }
      return c.body(null, 404);
    }

    if (isHostProbePath(pathname)) {
      const limit = checkIpRateLimit(
        ipRateLimitKey(c, "host-probe"),
        HOST_PROBE_LIMIT.count,
        HOST_PROBE_LIMIT.windowMs,
      );
      if (!limit.allowed) {
        return c.json(
          { error: "Too many requests", code: "RATE_LIMITED" },
          429,
        );
      }
    }

    await next();
  };
}
