import { Hono } from "hono";
import QRCode from "qrcode";
import type { Config } from "../config";
import { newId, randomToken } from "../crypto";
import type { Db } from "../db/schema";
import {
  createHostSession,
  hostAuthMiddleware,
  setHostCookie,
} from "../middleware/session";
import {
  bumpSyncGeneration,
  deletePartyCascade,
  getBoostLane,
  getDedupTitles,
  getNormalUpcoming,
  getPartyExportTracks,
  getPlayOrder,
  getQueueItems,
  getUpcomingPlayOrder,
  isDuplicateError,
  markFinished,
  nextBoostPosition,
  resetQueuedToPending,
  toQueueItemView,
} from "../services/queue";
import {
  extractPlaylistId,
  storeHostTokens,
  trackFromSpotify,
  type SpotifyClient,
} from "../services/spotify";
import { getSyncState, requestPartySync } from "../services/sync";
import {
  getPartyArtistTopTracks,
  normalizeRateLimits,
  searchPartyCatalog,
  SpotifySearchRateLimitedError,
} from "../services/spotify-search";
import { addTrackToParty } from "./guest";
import { clearPartyGuests, countNamedPartyGuests, getPartyGuestAdminViews, resetGuestRateLimits } from "../services/guests";
import { DEFAULT_RATE_LIMITS, type PartyRateLimits } from "@/shared/types";
import { deleteCookie, getCookie } from "hono/cookie";
import { SPOTIFY_SCOPES } from "../config";

function parseRateLimits(json: string): PartyRateLimits {
  return normalizeRateLimits(JSON.parse(json) as PartyRateLimits);
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "party"
  );
}

function afterQueueChange(db: Db, partyId: string): void {
  requestPartySync(db, partyId);
}

export function createHostRoutes(db: Db, config: Config, spotify: SpotifyClient) {
  const app = new Hono();

  const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

  function assertHostSetupToken(c: import("hono").Context): boolean {
    if (!config.hostSetupToken) return true;
    const token =
      c.req.query("token")?.trim() ?? c.req.header("X-Host-Setup-Token")?.trim();
    return token === config.hostSetupToken;
  }

  app.get("/host/spotify/login", (c) => {
    if (!assertHostSetupToken(c)) {
      return c.text("Forbidden", 403);
    }
    const state = randomToken();
    db.run(`INSERT INTO oauth_states (state, created_at) VALUES (?, ?)`, [
      state,
      new Date().toISOString(),
    ]);
    const params = new URLSearchParams({
      client_id: config.spotifyClientId,
      response_type: "code",
      redirect_uri: config.spotifyRedirectUri,
      scope: SPOTIFY_SCOPES,
      state,
    });
    return c.redirect(`https://accounts.spotify.com/authorize?${params}`);
  });

  app.get("/host/spotify/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) {
      return c.text("Missing code or state", 400);
    }
    const stored = db
      .query(`SELECT state, created_at FROM oauth_states WHERE state = ?`)
      .get(state) as { state: string; created_at: string } | null;
    if (!stored) return c.text("Invalid state", 400);
    const ageMs = Date.now() - new Date(stored.created_at).getTime();
    if (ageMs > OAUTH_STATE_TTL_MS) {
      db.run(`DELETE FROM oauth_states WHERE state = ?`, [state]);
      return c.text("OAuth state expired", 400);
    }
    db.run(`DELETE FROM oauth_states WHERE state = ?`, [state]);

    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(
            `${config.spotifyClientId}:${config.spotifyClientSecret}`,
          ).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.spotifyRedirectUri,
      }),
    });
    if (!res.ok) return c.text("Token exchange failed", 500);
    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    storeHostTokens(
      db,
      config,
      data.access_token,
      data.refresh_token,
      data.expires_in,
    );
    const session = createHostSession(db);
    setHostCookie(c, session, config.secureCookies);
    return c.redirect(`${config.baseUrl}/admin`);
  });

  app.get("/host/spotify/status", async (c) => {
    const creds = db
      .query(`SELECT expires_at FROM host_credentials WHERE id = 1`)
      .get() as { expires_at: string } | null;
    const sessionToken = getCookie(c, "host_session");
    const session = sessionToken
      ? (db
          .query(`SELECT expires_at FROM host_sessions WHERE id = ?`)
          .get(sessionToken) as { expires_at: string } | null)
      : null;
    const authenticated = Boolean(
      session && new Date(session.expires_at) >= new Date(),
    );

    let sync = getSyncState();
    const retryAfterMs =
      sync.rateLimitedUntil != null
        ? Math.max(0, sync.rateLimitedUntil - Date.now())
        : null;
    return c.json({
      connected: Boolean(creds),
      authenticated,
      expiresAt: creds?.expires_at ?? null,
      deviceActive: sync.deviceActive,
      spotifyReachable: sync.spotifyReachable,
      deviceRestricted: sync.deviceRestricted,
      deviceName: sync.deviceName,
      lastError: sync.lastError,
      retryAfterMs,
      lastSyncedAt: sync.lastSyncedAt,
    });
  });

  app.post("/host/logout", hostAuthMiddleware(db), (c) => {
    const token = getCookie(c, "host_session");
    if (token) db.run(`DELETE FROM host_sessions WHERE id = ?`, [token]);
    deleteCookie(c, "host_session");
    return c.json({ ok: true });
  });

  const authed = new Hono();
  authed.use("*", hostAuthMiddleware(db));

  authed.post("/parties", async (c) => {
    const body = (await c.req.json()) as {
      name: string;
      seedPlaylistId?: string;
      importFromPartyId?: string;
      slug?: string;
      vetoThreshold?: number;
      rateLimits?: PartyRateLimits;
    };

    const seedInput = body.seedPlaylistId?.trim() ?? "";
    const importFrom = body.importFromPartyId?.trim();
    if (!seedInput && !importFrom) {
      return c.json(
        {
          error: "Provide a seed playlist or import from an ended party",
          code: "NO_SEED",
        },
        400,
      );
    }

    const slug =
      body.slug?.trim() ||
      slugify(body.name) + "-" + Date.now().toString(36).slice(-4);

    db.run(
      `UPDATE parties SET status = 'archived', updated_at = ? WHERE status IN ('on', 'off')`,
      [new Date().toISOString()],
    );

    const partyId = newId();
    const now = new Date().toISOString();
    const playlistId = seedInput
      ? extractPlaylistId(seedInput)
      : importFrom
        ? `history:${importFrom}`
        : "none";

    db.run(
      `INSERT INTO parties (id, slug, name, status, veto_threshold, seed_playlist_id, rate_limits, sync_generation, created_at, updated_at)
       VALUES (?, ?, ?, 'off', ?, ?, ?, 0, ?, ?)`,
      [
        partyId,
        slug,
        body.name,
        body.vetoThreshold ?? 3,
        playlistId,
        JSON.stringify(body.rateLimits ?? DEFAULT_RATE_LIMITS),
        now,
        now,
      ],
    );

    try {
      if (importFrom) {
        const archived = db
          .query(`SELECT id, name FROM parties WHERE id = ? AND status = 'archived'`)
          .get(importFrom) as { id: string; name: string } | null;
        if (!archived) {
          deletePartyCascade(db, partyId);
          return c.json(
            { error: "Ended party not found", code: "IMPORT_NOT_FOUND" },
            404,
          );
        }
        for (const track of getPartyExportTracks(db, importFrom)) {
          try {
            await addTrackToParty(db, partyId, track, null, false);
          } catch (e) {
            if (!isDuplicateError(e)) throw e;
          }
        }
      } else if (seedInput) {
        const tracks = await spotify.getPlaylistTracks(playlistId);
        for (const track of tracks) {
          try {
            await addTrackToParty(db, partyId, trackFromSpotify(track), null, true);
          } catch (e) {
            if (!isDuplicateError(e)) throw e;
          }
        }
      }
    } catch (e) {
      deletePartyCascade(db, partyId);
      console.error("Party create import failed:", e);
      return c.json(
        {
          error: importFrom
            ? "Failed to import party history"
            : "Failed to import playlist",
          code: importFrom ? "HISTORY_IMPORT_FAILED" : "PLAYLIST_IMPORT_FAILED",
        },
        502,
      );
    }

    return c.json({ id: partyId, slug }, 201);
  });

  authed.get("/parties/last-ended", (c) => {
    const party = db
      .query(
        `SELECT id, name, updated_at FROM parties WHERE status = 'archived' ORDER BY updated_at DESC LIMIT 1`,
      )
      .get() as { id: string; name: string } | null;
    if (!party) return c.json(null, 200);
    const tracks = getPartyExportTracks(db, party.id);
    return c.json({
      partyId: party.id,
      partyName: party.name,
      tracks,
      trackCount: tracks.length,
    });
  });

  authed.get("/parties/current", (c) => {
    const party = db
      .query(`SELECT * FROM parties WHERE status IN ('on', 'off') ORDER BY created_at DESC LIMIT 1`)
      .get() as Record<string, unknown> | null;
    if (!party) return c.json(null, 200);
    const guestCount = countNamedPartyGuests(db, party.id as string);
    return c.json({ ...formatParty(party), guestCount });
  });

  authed.post("/parties/:id/end", async (c) => {
    const partyId = c.req.param("id");
    const party = db
      .query(`SELECT * FROM parties WHERE id = ? AND status IN ('on', 'off')`)
      .get(partyId) as { id: string; name: string } | null;
    if (!party) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }

    const now = new Date().toISOString();
    db.run(
      `UPDATE queue_items SET status = 'played', finished_at = ?
       WHERE party_id = ? AND status = 'playing'`,
      [now, partyId],
    );
    db.run(
      `UPDATE queue_items SET status = 'skipped', finished_at = ?
       WHERE party_id = ? AND status IN ('pending', 'queued')`,
      [now, partyId],
    );
    db.run(
      `UPDATE parties SET status = 'archived', updated_at = ? WHERE id = ?`,
      [now, partyId],
    );

    const tracks = getPartyExportTracks(db, partyId);
    return c.json({
      partyId,
      partyName: party.name,
      tracks,
      trackCount: tracks.length,
    });
  });

  authed.patch("/parties/:id", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as {
      status?: "on" | "off";
      vetoThreshold?: number;
      rateLimits?: PartyRateLimits;
      name?: string;
    };
    const party = db.query(`SELECT * FROM parties WHERE id = ?`).get(id);
    if (!party) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);

    const updates: string[] = [];
    const values: unknown[] = [];
    if (body.status) {
      updates.push("status = ?");
      values.push(body.status);
    }
    if (body.vetoThreshold != null) {
      updates.push("veto_threshold = ?");
      values.push(body.vetoThreshold);
    }
    if (body.rateLimits) {
      updates.push("rate_limits = ?");
      values.push(JSON.stringify(body.rateLimits));
    }
    if (body.name) {
      updates.push("name = ?");
      values.push(body.name);
    }
    updates.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);
    db.run(
      `UPDATE parties SET ${updates.join(", ")} WHERE id = ?`,
      values as (string | number)[],
    );
    if (body.status === "on") {
      requestPartySync(db, id);
    }
    return c.json({ ok: true });
  });

  authed.get("/parties/:id/qr", async (c) => {
    const party = db
      .query(`SELECT slug FROM parties WHERE id = ?`)
      .get(c.req.param("id")) as { slug: string } | null;
    if (!party) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    const url = `${config.baseUrl}/p/${party.slug}`;
    const svg = await QRCode.toString(url, { type: "svg", margin: 1 });
    c.header("Content-Type", "image/svg+xml");
    return c.body(svg);
  });

  authed.get("/parties/:id/queue", (c) => {
    const partyId = c.req.param("id");
    const items = getQueueItems(db, partyId, ["pending", "queued", "playing"]);
    const nowPlaying = items.find((i) => i.status === "playing");
    return c.json({
      nowPlaying: nowPlaying ? toQueueItemView(nowPlaying) : null,
      upcomingOrder: getUpcomingPlayOrder(items).map(toQueueItemView),
      boostLane: getBoostLane(items).map(toQueueItemView),
      upcoming: getNormalUpcoming(items).map(toQueueItemView),
      dedupTitles: getDedupTitles(db, partyId),
    });
  });

  authed.post("/parties/:id/queue", async (c) => {
    const partyId = c.req.param("id");
    const body = (await c.req.json()) as {
      uri: string;
      name?: string;
      artistName?: string;
      albumArtUrl?: string | null;
    };
    let info: {
      uri: string;
      name: string;
      artistName: string;
      albumArtUrl: string | null;
    };
    if (body.name && body.artistName) {
      info = {
        uri: body.uri,
        name: body.name,
        artistName: body.artistName,
        albumArtUrl: body.albumArtUrl ?? null,
      };
    } else {
      const tracks = await spotify.searchTracks(body.uri, 1);
      const track = tracks[0];
      if (!track && !body.uri.startsWith("spotify:track:")) {
        return c.json({ error: "Invalid track", code: "INVALID_URI" }, 400);
      }
      info = track
        ? trackFromSpotify(track)
        : {
            uri: body.uri,
            name: "Unknown",
            artistName: "Unknown",
            albumArtUrl: null,
          };
    }
    try {
      const id = await addTrackToParty(db, partyId, info, null, false);
      requestPartySync(db, partyId);
      return c.json({ id }, 201);
    } catch (e) {
      if (isDuplicateError(e)) {
        return c.json(
          { error: "Duplicate song", code: "DUPLICATE" },
          409,
        );
      }
      throw e;
    }
  });

  authed.post("/parties/:id/queue/shuffle", async (c) => {
    const partyId = c.req.param("id");
    const items = getNormalUpcoming(getQueueItems(db, partyId));
    const shuffled = [...items].sort(() => Math.random() - 0.5);
    shuffled.forEach((item, index) => {
      db.run(
        `UPDATE queue_items SET manual_order = ?, status = 'pending' WHERE id = ?`,
        [index, item.id],
      );
    });
    resetQueuedToPending(db, partyId);
    bumpSyncGeneration(db, partyId);
    afterQueueChange(db, partyId);
    return c.json({ ok: true });
  });

  authed.post("/parties/:id/queue/clear", async (c) => {
    const partyId = c.req.param("id");
    const now = new Date().toISOString();
    db.run(
      `UPDATE queue_items SET status = 'skipped', finished_at = ?
       WHERE party_id = ? AND status IN ('pending', 'queued')`,
      [now, partyId],
    );
    bumpSyncGeneration(db, partyId);
    afterQueueChange(db, partyId);
    return c.json({ ok: true });
  });

  authed.post("/parties/:id/queue/start-from/:itemId", async (c) => {
    const partyId = c.req.param("id");
    const itemId = c.req.param("itemId");
    const items = getQueueItems(db, partyId, ["pending", "queued", "playing"]);
    const upcoming = getUpcomingPlayOrder(items);
    const idx = upcoming.findIndex((i) => i.id === itemId);
    if (idx < 0) {
      return c.json({ error: "Item not found in upcoming", code: "NOT_FOUND" }, 404);
    }
    const toSkip = upcoming.slice(0, idx);
    const now = new Date().toISOString();
    for (const item of toSkip) {
      db.run(
        `UPDATE queue_items SET status = 'skipped', finished_at = ? WHERE id = ?`,
        [now, item.id],
      );
    }
    resetQueuedToPending(db, partyId);
    bumpSyncGeneration(db, partyId);
    afterQueueChange(db, partyId);
    return c.json({ ok: true, skipped: toSkip.length });
  });

  authed.patch("/parties/:id/queue/:itemId", async (c) => {
    const partyId = c.req.param("id");
    const itemId = c.req.param("itemId");
    const body = (await c.req.json()) as { action: string };
    const item = db
      .query(`SELECT * FROM queue_items WHERE id = ? AND party_id = ?`)
      .get(itemId, partyId) as {
      status: string;
      is_boosted: number;
    } | null;
    if (!item) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);

    switch (body.action) {
      case "force_next": {
        if (item.status === "playing") {
          return c.json({ error: "Cannot force now playing", code: "NOW_PLAYING" }, 400);
        }
        const pos = nextBoostPosition(db, partyId);
        db.run(
          `UPDATE queue_items SET is_boosted = 1, boost_position = ?, status = 'pending' WHERE id = ?`,
          [pos, itemId],
        );
        resetQueuedToPending(db, partyId);
        bumpSyncGeneration(db, partyId);
        break;
      }
      case "move_up":
      case "move_down": {
        const normal = getNormalUpcoming(getQueueItems(db, partyId));
        const index = normal.findIndex((i) => i.id === itemId);
        if (index < 0) {
          return c.json({ error: "Not in normal queue", code: "INVALID" }, 400);
        }
        const swapIdx = body.action === "move_up" ? index - 1 : index + 1;
        if (swapIdx < 0 || swapIdx >= normal.length) {
          return c.json({ ok: true });
        }
        const a = normal[index]!;
        const b = normal[swapIdx]!;
        const orderA = a.manual_order ?? index;
        const orderB = b.manual_order ?? swapIdx;
        db.run(`UPDATE queue_items SET manual_order = ?, status = 'pending' WHERE id = ?`, [
          orderB,
          a.id,
        ]);
        db.run(`UPDATE queue_items SET manual_order = ?, status = 'pending' WHERE id = ?`, [
          orderA,
          b.id,
        ]);
        resetQueuedToPending(db, partyId);
        bumpSyncGeneration(db, partyId);
        break;
      }
      case "reset_votes": {
        db.run(`DELETE FROM votes WHERE queue_item_id = ?`, [itemId]);
        db.run(`UPDATE queue_items SET upvote_count = 0 WHERE id = ?`, [itemId]);
        bumpSyncGeneration(db, partyId);
        break;
      }
      default:
        return c.json({ error: "Unknown action", code: "INVALID_ACTION" }, 400);
    }
    afterQueueChange(db, partyId);
    return c.json({ ok: true });
  });

  authed.delete("/parties/:id/queue/:itemId", async (c) => {
    const item = db
      .query(`SELECT status FROM queue_items WHERE id = ? AND party_id = ?`)
      .get(c.req.param("itemId"), c.req.param("id")) as { status: string } | null;
    if (!item) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    if (item.status === "playing") {
      return c.json({ error: "Cannot remove now playing", code: "NOW_PLAYING" }, 400);
    }
    markFinished(db, c.req.param("itemId"), "skipped");
    bumpSyncGeneration(db, c.req.param("id"));
    afterQueueChange(db, c.req.param("id"));
    return c.json({ ok: true });
  });

  authed.post("/parties/:id/skip", async (c) => {
    const partyId = c.req.param("id");
    const playing = db
      .query(
        `SELECT id FROM queue_items WHERE party_id = ? AND status = 'playing' LIMIT 1`,
      )
      .get(partyId) as { id: string } | null;
    if (playing) markFinished(db, playing.id, "skipped");
    try {
      await spotify.skipNext();
    } catch {
      return c.json({ error: "Skip failed", code: "SPOTIFY_ERROR" }, 502);
    }
    bumpSyncGeneration(db, partyId);
    afterQueueChange(db, partyId);
    return c.json({ ok: true });
  });

  authed.patch("/parties/:id/guests/:guestId", async (c) => {
    const body = (await c.req.json()) as { disabled: boolean };
    db.run(`UPDATE guests SET disabled = ? WHERE id = ? AND party_id = ?`, [
      body.disabled ? 1 : 0,
      c.req.param("guestId"),
      c.req.param("id"),
    ]);
    return c.json({ ok: true });
  });

  authed.post("/parties/:id/guests/:guestId/reset-limits", async (c) => {
    const partyId = c.req.param("id");
    const guestId = c.req.param("guestId");
    try {
      const result = resetGuestRateLimits(db, partyId, guestId);
      if (result.boostsCleared > 0) {
        requestPartySync(db, partyId);
      }
      return c.json({ ok: true, ...result });
    } catch (e) {
      if (e instanceof Error && e.message === "NOT_FOUND") {
        return c.json({ error: "Guest not found", code: "NOT_FOUND" }, 404);
      }
      throw e;
    }
  });

  authed.get("/parties/:id/guests", (c) => {
    const partyId = c.req.param("id");
    const guests = getPartyGuestAdminViews(db, partyId);
    return c.json({ guests });
  });

  authed.delete("/parties/:id/guests", (c) => {
    const partyId = c.req.param("id");
    const removed = clearPartyGuests(db, partyId);
    return c.json({ ok: true, removed });
  });

  authed.get("/parties/:id/history", (c) => {
    const items = getQueueItems(db, c.req.param("id"), [
      "played",
      "skipped",
      "vetoed",
    ]);
    return c.json({
      history: items
        .sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""))
        .map(toQueueItemView),
    });
  });

  authed.get("/parties/:id/search", async (c) => {
    const q = c.req.query("q")?.trim();
    if (!q) return c.json({ tracks: [], artists: [] });
    const partyId = c.req.param("id");
    try {
      const data = await searchPartyCatalog(
        spotify,
        db,
        partyId,
        q,
        null,
        parseRateLimits(
          (
            db.query(`SELECT rate_limits FROM parties WHERE id = ?`).get(partyId) as
              | { rate_limits: string }
              | null
          )?.rate_limits ?? JSON.stringify(DEFAULT_RATE_LIMITS),
        ),
      );
      return c.json(data);
    } catch (e) {
      if (e instanceof SpotifySearchRateLimitedError) {
        return c.json(
          {
            error: "Search rate limited",
            code: "RATE_LIMITED",
            retryAfterMs: e.retryAfterMs,
          },
          429,
        );
      }
      return c.json({ error: "Search unavailable", code: "SPOTIFY_ERROR" }, 503);
    }
  });

  authed.get("/parties/:id/artists/:artistId/top-tracks", async (c) => {
    const partyId = c.req.param("id");
    try {
      const tracks = await getPartyArtistTopTracks(
        spotify,
        db,
        partyId,
        c.req.param("artistId"),
        c.req.query("name"),
        null,
        parseRateLimits(
          (
            db.query(`SELECT rate_limits FROM parties WHERE id = ?`).get(partyId) as
              | { rate_limits: string }
              | null
          )?.rate_limits ?? JSON.stringify(DEFAULT_RATE_LIMITS),
        ),
      );
      return c.json({ tracks });
    } catch (e) {
      if (e instanceof SpotifySearchRateLimitedError) {
        return c.json(
          {
            error: "Search rate limited",
            code: "RATE_LIMITED",
            retryAfterMs: e.retryAfterMs,
          },
          429,
        );
      }
      return c.json({ error: "Search unavailable", code: "SPOTIFY_ERROR" }, 503);
    }
  });

  app.route("/host", authed);
  return app;
}

function formatParty(row: Record<string, unknown>) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    vetoThreshold: row.veto_threshold,
    seedPlaylistId: row.seed_playlist_id,
    rateLimits: parseRateLimits(row.rate_limits as string),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
