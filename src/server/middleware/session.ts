import type { Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Db } from "../db/schema";
import { randomToken } from "../crypto";
import { touchGuestLastSeen } from "../services/guests";
import { getClientIp } from "../client-ip";

type GuestEnv = {
  Variables: {
    guest?: {
      id: string;
      partyId: string;
      displayName: string | null;
      boostUsed: boolean;
      disabled: boolean;
    };
  };
};

export function guestSessionMiddleware(db: Db) {
  return async (c: Context<GuestEnv>, next: Next) => {
    const slug = c.req.param("slug");
    if (!slug) return next();

    const cookieName = `guest_session_${slug}`;
    let token =
      getCookie(c, cookieName) ?? c.req.header("X-Guest-Session") ?? undefined;
    if (!token) {
      await next();
      return;
    }

    const guest = db
      .query(
        `SELECT g.* FROM guests g
         JOIN parties p ON p.id = g.party_id
         WHERE g.session_token = ? AND p.slug = ?`,
      )
      .get(token, slug) as
      | {
          id: string;
          party_id: string;
          display_name: string | null;
          boost_used: number;
          disabled: number;
        }
      | null;

    if (guest) {
      touchGuestLastSeen(db, guest.id, getClientIp(c));
      c.set("guest", {
        id: guest.id,
        partyId: guest.party_id,
        displayName: guest.display_name,
        boostUsed: guest.boost_used === 1,
        disabled: guest.disabled === 1,
      });
    }
    await next();
  };
}

export function hostAuthMiddleware(db: Db) {
  return async (c: Context, next: Next) => {
    const token = getCookie(c, "host_session");
    if (!token) {
      return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
    }
    const session = db
      .query(`SELECT * FROM host_sessions WHERE id = ?`)
      .get(token) as { expires_at: string } | null;
    if (!session || new Date(session.expires_at) < new Date()) {
      return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
    }
    await next();
  };
}

export function setGuestCookie(
  c: Context,
  slug: string,
  token: string,
  secure: boolean,
): void {
  setCookie(c, `guest_session_${slug}`, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: "/",
    maxAge: 60 * 60 * 24,
  });
}

export function setHostCookie(
  c: Context,
  token: string,
  secure: boolean,
): void {
  setCookie(c, "host_session", token, {
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export function createHostSession(db: Db): string {
  const token = randomToken();
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.run(
    `INSERT INTO host_sessions (id, created_at, expires_at) VALUES (?, ?, ?)`,
    [token, new Date().toISOString(), expires],
  );
  return token;
}
