import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Config } from "../config";
import { newId } from "../crypto";
import type { Db } from "../db/schema";
import {
  guestSessionMiddleware,
  setGuestCookie,
} from "../middleware/session";
import {
  findConflictingNamedGuest,
  reclaimGuestSession,
  touchGuestLastSeen,
  countGuestActiveSongs,
  getGuestMySongs,
  getGuestProfileStats,
} from "../services/guests";
import { getClientIp } from "../client-ip";
import {
  computeQueueEtag,
  DuplicateQueueItemError,
  getBoostLane,
  getDedupTracks,
  getNormalUpcoming,
  getNextUpcomingItem,
  getQueueItems,
  getUpcomingPlayOrder,
  insertQueueItem,
  isGuestBoostBlocked,
  isGuestUpvoteBlocked,
  isGuestVetoBlocked,
  markFinished,
  nextBoostPosition,
  toQueueItemView,
} from "../services/queue";
import {
  checkRateLimit,
  recordAction,
  remainingQuota,
} from "../services/rate-limit";
import {
  trackFromSpotify,
  type SpotifyClient,
} from "../services/spotify";
import { requestPartySync } from "../services/sync";
import {
  getCachedTrackMetadata,
  getPartyArtistTracks,
  normalizeRateLimits,
  searchPartyCatalog,
  SpotifySearchRateLimitedError,
  type ArtistTrackFilter,
} from "../services/spotify-search";
import {
  type PartyRateLimits,
  type QueueItemStatus,
} from "@/shared/types";

const MAX_DISPLAY_NAME_LENGTH = 48;

type GuestVars = {
  Variables: {
    guest?: {
      id: string;
      partyId: string;
      displayName: string | null;
      boostUsed: boolean;
      tutorialSeen: boolean;
      disabled: boolean;
    };
  };
};

function getGuest(c: import("hono").Context<GuestVars>) {
  return c.get("guest");
}

function requireGuest(c: import("hono").Context<GuestVars>) {
  const guest = getGuest(c);
  if (!guest) throw new Error("NO_SESSION");
  if (guest.disabled) throw new Error("BANNED");
  return guest;
}

function parseRateLimits(json: string): PartyRateLimits {
  return normalizeRateLimits(JSON.parse(json) as PartyRateLimits);
}

function parseArtistTrackFilter(value: string | undefined): ArtistTrackFilter {
  return value === "credited" ? "credited" : "all";
}

import {
  formatPartyView,
  getBoostCapStats,
  getPartyBySlug,
  isPartyOn,
  PARTY_OFF_RESPONSE,
} from "../services/party";

export function createGuestRoutes(db: Db, config: Config, spotify: SpotifyClient) {
  const app = new Hono<GuestVars>();

  app.use("/parties/:slug", guestSessionMiddleware(db));
  app.use("/parties/:slug/*", guestSessionMiddleware(db));

  app.post("/parties/:slug/join", async (c) => {
    const slug = c.req.param("slug");
    const party = getPartyBySlug(db, slug);
    if (!party) return c.json({ error: "Party not found", code: "NOT_FOUND" }, 404);
    const clientIp = getClientIp(c);

    const cookieName = `guest_session_${slug}`;
    const existingToken = getCookie(c, cookieName);
    if (existingToken) {
      const existing = db
        .query(
          `SELECT id, display_name, boost_used, tutorial_seen FROM guests
           WHERE session_token = ? AND party_id = ?`,
        )
        .get(existingToken, party.id) as
        | {
            id: string;
            display_name: string | null;
            boost_used: number;
            tutorial_seen: number;
          }
        | null;
      if (existing) {
        touchGuestLastSeen(db, existing.id, clientIp);
        return c.json({
          id: existing.id,
          displayName: existing.display_name,
          boostUsed: existing.boost_used === 1,
          tutorialSeen: existing.tutorial_seen === 1,
          sessionToken: config.isProduction ? undefined : existingToken,
        });
      }
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      displayName?: string;
      sessionToken?: string;
    };
    const displayName = body.displayName?.trim().slice(0, MAX_DISPLAY_NAME_LENGTH) || null;

    const resumeToken = body.sessionToken?.trim();
    if (resumeToken) {
      const resumed = db
        .query(
          `SELECT id, display_name, boost_used, tutorial_seen, session_token FROM guests
           WHERE session_token = ? AND party_id = ?`,
        )
        .get(resumeToken, party.id) as
        | {
            id: string;
            display_name: string | null;
            boost_used: number;
            tutorial_seen: number;
            session_token: string;
          }
        | null;
      if (resumed) {
        touchGuestLastSeen(db, resumed.id, clientIp);
        setGuestCookie(c, slug, resumed.session_token, config.secureCookies);
        return c.json({
          id: resumed.id,
          displayName: resumed.display_name,
          boostUsed: resumed.boost_used === 1,
          tutorialSeen: resumed.tutorial_seen === 1,
          sessionToken: config.isProduction ? undefined : resumed.session_token,
        });
      }
    }

    const token = crypto.randomUUID();
    const guestId = newId();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO guests (id, party_id, session_token, display_name, boost_used, disabled, created_at, last_seen_at, last_ip)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      [
        guestId,
        party.id,
        token,
        displayName,
        now,
        now,
        clientIp,
      ],
    );
    setGuestCookie(c, slug, token, config.secureCookies);
    return c.json({
      id: guestId,
      displayName,
      boostUsed: false,
      tutorialSeen: false,
      sessionToken: config.isProduction ? undefined : token,
    });
  });

  app.patch("/parties/:slug/me", async (c) => {
    const slug = c.req.param("slug");
    let guest;
    try {
      guest = requireGuest(c);
    } catch {
      return c.json({ error: "No session", code: "NO_SESSION" }, 401);
    }
    const party = getPartyBySlug(db, slug);
    if (!party) return c.json({ error: "Party not found", code: "NOT_FOUND" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      displayName?: string;
      confirmReclaim?: boolean;
      confirmDistinctName?: boolean;
      tutorialSeen?: boolean;
    };

    if (body.tutorialSeen === true) {
      db.run(`UPDATE guests SET tutorial_seen = 1 WHERE id = ?`, [guest.id]);
    }

    if (body.displayName === undefined) {
      if (body.tutorialSeen === true) {
        return c.json({ tutorialSeen: true });
      }
      return c.json({ error: "Nothing to update", code: "BAD_REQUEST" }, 400);
    }

    const name = body.displayName.trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
    if (!name) {
      return c.json(
        { error: "Display name required", code: "DISPLAY_NAME_REQUIRED" },
        400,
      );
    }

    const conflict = findConflictingNamedGuest(db, party.id, name, guest.id);
    if (conflict && body.confirmDistinctName) {
      if (conflict.matchKind === "exact") {
        return c.json(
          {
            error: `Someone named "${conflict.display_name}" is already here`,
            code: "NAME_TAKEN",
            displayName: conflict.display_name,
            matchKind: conflict.matchKind,
          },
          409,
        );
      }
    } else if (conflict) {
      if (!body.confirmReclaim) {
        return c.json(
          {
            error: `Someone named "${conflict.display_name}" is already here`,
            code: "NAME_TAKEN",
            displayName: conflict.display_name,
            matchKind: conflict.matchKind,
          },
          409,
        );
      }
      const reclaimed = reclaimGuestSession(db, guest.id, conflict.id);
      touchGuestLastSeen(db, reclaimed.id, getClientIp(c));
      setGuestCookie(c, slug, reclaimed.sessionToken, config.secureCookies);
      return c.json({
        id: reclaimed.id,
        displayName: reclaimed.displayName,
        boostUsed: reclaimed.boostUsed,
        tutorialSeen: reclaimed.tutorialSeen,
        sessionToken: config.isProduction ? undefined : reclaimed.sessionToken,
      });
    }

    db.run(`UPDATE guests SET display_name = ? WHERE id = ?`, [name, guest.id]);
    return c.json({ displayName: name });
  });

  app.get("/parties/:slug", (c) => {
    const party = getPartyBySlug(db, c.req.param("slug"));
    if (!party) return c.json({ error: "Party not found", code: "NOT_FOUND" }, 404);
    return c.json({
      id: party.id,
      slug: party.slug,
      name: party.name,
      status: party.status,
      vetoThreshold: party.veto_threshold,
      boostCap: party.boost_cap ?? null,
      rateLimits: parseRateLimits(party.rate_limits),
    });
  });

  app.get("/parties/:slug/queue", (c) => {
    const party = getPartyBySlug(db, c.req.param("slug"));
    if (!party) return c.json({ error: "Party not found", code: "NOT_FOUND" }, 404);

    const items = getQueueItems(db, party.id, [
      "pending",
      "queued",
      "playing",
    ]);
    const etag = computeQueueEtag(items, party.updated_at);
    if (c.req.header("If-None-Match") === etag) {
      return c.body(null, 304);
    }

    const nowPlaying = items.find((i) => i.status === "playing");
    const nextItem = getNextUpcomingItem(items);
    const guest = getGuest(c);
    const upvotedItemIds = new Set<string>();
    const downvotedItemIds = new Set<string>();
    if (guest && items.length > 0) {
      const placeholders = items.map(() => "?").join(", ");
      const itemIds = items.map((i) => i.id);
      const votes = db
        .query(
          `SELECT queue_item_id FROM votes
           WHERE guest_id = ? AND queue_item_id IN (${placeholders})`,
        )
        .all(guest.id, ...itemIds) as { queue_item_id: string }[];
      for (const vote of votes) {
        upvotedItemIds.add(vote.queue_item_id);
      }
      const vetoes = db
        .query(
          `SELECT queue_item_id FROM vetoes
           WHERE guest_id = ? AND queue_item_id IN (${placeholders})`,
        )
        .all(guest.id, ...itemIds) as { queue_item_id: string }[];
      for (const veto of vetoes) {
        downvotedItemIds.add(veto.queue_item_id);
      }
    }
    const toGuestQueueItemView = (row: (typeof items)[number]) => ({
      ...toQueueItemView(row),
      guestUpvoteBlocked: isGuestUpvoteBlocked(items, row.id),
      guestBoostBlocked: isGuestBoostBlocked(items, row.id),
      guestVetoBlocked: isGuestVetoBlocked(items, row.id),
      guestHasUpvoted: upvotedItemIds.has(row.id),
      guestHasDownvoted: downvotedItemIds.has(row.id),
    });
    const boostLane = getBoostLane(items).map(toGuestQueueItemView);
    const upcoming = getNormalUpcoming(items).map(toGuestQueueItemView);
    const upcomingOrder = getUpcomingPlayOrder(items).map(toGuestQueueItemView);

    const rateLimits = parseRateLimits(party.rate_limits);
    const boostStats = getBoostCapStats(db, party.id, party.boost_cap ?? null);

    c.header("ETag", etag);
    return c.json({
      nowPlaying: nowPlaying ? toGuestQueueItemView(nowPlaying) : null,
      upcomingOrder,
      upcoming,
      boostLane,
      nextItemId: nextItem?.id ?? null,
      dedupTracks: getDedupTracks(db, party.id),
      party: formatPartyView(party, rateLimits),
      ...boostStats,
      etag,
    });
  });

  app.get("/parties/:slug/search", async (c) => {
    const party = getPartyBySlug(db, c.req.param("slug"));
    if (!party) return c.json({ error: "Party not found", code: "NOT_FOUND" }, 404);
    if (!isPartyOn(party)) {
      return c.json(PARTY_OFF_RESPONSE, 403);
    }
    const q = c.req.query("q")?.trim();
    if (!q) return c.json({ tracks: [], artists: [] });

    const guest = getGuest(c);
    try {
      const data = await searchPartyCatalog(
        spotify,
        db,
        party.id,
        q,
        guest?.id ?? null,
        parseRateLimits(party.rate_limits),
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

  app.get("/parties/:slug/artists/:artistId/tracks", async (c) => {
    const party = getPartyBySlug(db, c.req.param("slug"));
    if (!party) return c.json({ error: "Party not found", code: "NOT_FOUND" }, 404);
    if (!isPartyOn(party)) {
      return c.json(PARTY_OFF_RESPONSE, 403);
    }
    const guest = getGuest(c);
    const filter = parseArtistTrackFilter(c.req.query("filter"));
    try {
      const tracks = await getPartyArtistTracks(
        spotify,
        db,
        party.id,
        c.req.param("artistId"),
        c.req.query("name"),
        filter,
        guest?.id ?? null,
        parseRateLimits(party.rate_limits),
      );
      return c.json({ tracks, filter });
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

  app.post("/parties/:slug/queue", async (c) => {
    return handleAdd(c, db, spotify, false);
  });

  app.post("/parties/:slug/queue/:itemId/upvote", async (c) => {
    const slug = c.req.param("slug");
    const itemId = c.req.param("itemId");
    let guest;
    try {
      guest = requireGuest(c);
    } catch (e) {
      const msg = String(e);
      return c.json(
        { error: msg === "BANNED" ? "Banned" : "No session", code: msg },
        403,
      );
    }
    if (!guest.displayName) {
      return c.json(
        { error: "Display name required", code: "DISPLAY_NAME_REQUIRED" },
        403,
      );
    }

    const party = getPartyBySlug(db, slug);
    if (!party || party.status !== "on") {
      return c.json({ error: "Party is off", code: "PARTY_OFF" }, 403);
    }

    const queueItems = getQueueItems(db, party.id, ["pending", "queued", "playing"]);
    if (isGuestUpvoteBlocked(queueItems, itemId)) {
      const item = queueItems.find((i) => i.id === itemId);
      const nextLocked =
        item?.status === "pending" &&
        getNextUpcomingItem(queueItems)?.id === itemId;
      return c.json(
        {
          error: nextLocked
            ? "This song is up next — upvotes are locked"
            : "This song is already queued in Spotify",
          code: "NEXT_LOCKED",
        },
        400,
      );
    }

    const item = db
      .query(`SELECT * FROM queue_items WHERE id = ? AND party_id = ?`)
      .get(itemId, party.id) as { added_by_guest_id: string | null; status: string } | null;
    if (!item || !["pending", "queued"].includes(item.status)) {
      return c.json({ error: "Invalid item", code: "INVALID_ITEM" }, 400);
    }
    if (item.added_by_guest_id === guest.id) {
      return c.json({ error: "Cannot upvote own song", code: "OWN_SONG" }, 400);
    }

    const limits = parseRateLimits(party.rate_limits);
    const rl = checkRateLimit(db, guest.id, "upvote", limits);
    if (!rl.allowed) {
      return c.json(
        {
          error: "Rate limited",
          code: "RATE_LIMITED",
          retryAfterMs: rl.retryAfterMs,
        },
        429,
      );
    }

    try {
      db.run(
        `INSERT INTO votes (guest_id, queue_item_id, created_at) VALUES (?, ?, ?)`,
        [guest.id, itemId, new Date().toISOString()],
      );
      db.run(
        `UPDATE queue_items SET upvote_count = upvote_count + 1 WHERE id = ?`,
        [itemId],
      );
      recordAction(db, guest.id, "upvote");
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Already upvoted", code: "ALREADY_VOTED" }, 400);
    }
  });

  app.post("/parties/:slug/queue/:itemId/veto", async (c) => {
    const slug = c.req.param("slug");
    const itemId = c.req.param("itemId");
    let guest;
    try {
      guest = requireGuest(c);
    } catch (e) {
      return c.json(
        { error: String(e) === "BANNED" ? "Banned" : "No session", code: "BANNED" },
        403,
      );
    }
    if (!guest.displayName) {
      return c.json(
        { error: "Display name required", code: "DISPLAY_NAME_REQUIRED" },
        403,
      );
    }

    const party = getPartyBySlug(db, slug);
    if (!party || party.status !== "on") {
      return c.json({ error: "Party is off", code: "PARTY_OFF" }, 403);
    }

    const queueItems = getQueueItems(db, party.id, ["pending", "queued", "playing"]);
    if (isGuestVetoBlocked(queueItems, itemId)) {
      return c.json(
        {
          error: "This song is already queued in Spotify",
          code: "NEXT_LOCKED",
        },
        400,
      );
    }

    const item = db
      .query(`SELECT * FROM queue_items WHERE id = ? AND party_id = ?`)
      .get(itemId, party.id) as {
      status: QueueItemStatus;
      veto_count: number;
    } | null;
    if (!item) return c.json({ error: "Invalid item", code: "INVALID_ITEM" }, 400);
    if (item.status === "playing") {
      return c.json(
        { error: "Cannot veto now playing", code: "NOW_PLAYING" },
        400,
      );
    }
    if (!["pending", "queued"].includes(item.status)) {
      return c.json({ error: "Invalid item", code: "INVALID_ITEM" }, 400);
    }

    const limits = parseRateLimits(party.rate_limits);
    const rl = checkRateLimit(db, guest.id, "veto", limits);
    if (!rl.allowed) {
      return c.json(
        {
          error: "Rate limited",
          code: "RATE_LIMITED",
          retryAfterMs: rl.retryAfterMs,
        },
        429,
      );
    }

    try {
      db.run(
        `INSERT INTO vetoes (guest_id, queue_item_id, created_at) VALUES (?, ?, ?)`,
        [guest.id, itemId, new Date().toISOString()],
      );
      const newCount = item.veto_count + 1;
      db.run(`UPDATE queue_items SET veto_count = ? WHERE id = ?`, [
        newCount,
        itemId,
      ]);
      recordAction(db, guest.id, "veto");
      if (newCount >= party.veto_threshold) {
        markFinished(db, itemId, "vetoed");
        requestPartySync(db, party.id);
      }
      return c.json({ ok: true, vetoCount: newCount });
    } catch {
      return c.json({ error: "Already vetoed", code: "ALREADY_VETOED" }, 400);
    }
  });

  app.post("/parties/:slug/queue/:itemId/boost", async (c) => {
    const slug = c.req.param("slug");
    const itemId = c.req.param("itemId");
    let guest;
    try {
      guest = requireGuest(c);
    } catch {
      return c.json({ error: "No session", code: "NO_SESSION" }, 403);
    }
    if (!guest.displayName) {
      return c.json(
        { error: "Display name required", code: "DISPLAY_NAME_REQUIRED" },
        403,
      );
    }

    const party = getPartyBySlug(db, slug);
    if (!party || party.status !== "on") {
      return c.json({ error: "Party is off", code: "PARTY_OFF" }, 403);
    }

    const limits = parseRateLimits(party.rate_limits);
    const rl = checkRateLimit(db, guest.id, "boost", limits);
    if (!rl.allowed) {
      return c.json(
        {
          error: "Rate limited",
          code: "RATE_LIMITED",
          retryAfterMs: rl.retryAfterMs,
        },
        429,
      );
    }

    const items = getQueueItems(db, party.id, ["pending", "queued", "playing"]);
    if (isGuestBoostBlocked(items, itemId)) {
      const item = items.find((i) => i.id === itemId);
      const nextLocked =
        item?.status === "pending" &&
        getNextUpcomingItem(items)?.id === itemId;
      return c.json(
        {
          error: nextLocked
            ? "This song is up next — boost is locked"
            : "This song is already queued in Spotify",
          code: "NEXT_LOCKED",
        },
        400,
      );
    }

    const item = db
      .query(`SELECT * FROM queue_items WHERE id = ? AND party_id = ?`)
      .get(itemId, party.id) as {
      status: string;
      is_boosted: number;
    } | null;
    if (!item || !["pending", "queued"].includes(item.status)) {
      return c.json({ error: "Invalid item", code: "INVALID_ITEM" }, 400);
    }
    if (item.is_boosted === 1) {
      return c.json({ error: "Already boosted", code: "ALREADY_BOOSTED" }, 400);
    }

    const boostCap = party.boost_cap;
    const boostStats = getBoostCapStats(db, party.id, boostCap);
    if (boostCap != null && boostStats.boostsUsed >= boostCap) {
      return c.json(
        {
          error: `Boost limit reached (${boostStats.boostsUsed}/${boostCap}). Wait for boosted tracks to play.`,
          code: "BOOST_CAP",
          boostsUsed: boostStats.boostsUsed,
          boostCap: boostStats.boostCap,
          boostsRemaining: boostStats.boostsRemaining,
        },
        400,
      );
    }

    const pos = nextBoostPosition(db, party.id);
    db.run(
      `UPDATE queue_items SET is_boosted = 1, boost_position = ?, boosted_by_guest_id = ?, status = 'pending' WHERE id = ?`,
      [pos, guest.id, itemId],
    );
    recordAction(db, guest.id, "boost");
    requestPartySync(db, party.id);
    return c.json({ ok: true });
  });

  app.get("/parties/:slug/me/info", (c) => {
    let guest;
    try {
      guest = requireGuest(c);
    } catch {
      return c.json({ error: "No session", code: "NO_SESSION" }, 401);
    }
    const party = getPartyBySlug(db, c.req.param("slug"));
    if (!party) return c.json({ error: "Party not found", code: "NOT_FOUND" }, 404);

    const limits = parseRateLimits(party.rate_limits);
    const quota = remainingQuota(db, guest.id, limits);
    const boostsLeft = quota.boost;
    const { active, history } = getGuestMySongs(
      db,
      party.id,
      guest.id,
      boostsLeft,
    );
    return c.json({
      displayName: guest.displayName,
      quota: {
        add: quota.add,
        upvote: quota.upvote,
        veto: quota.veto,
        boost: quota.boost,
      },
      rateLimits: limits,
      stats: getGuestProfileStats(db, party.id, guest.id),
      active,
      history,
      boostUsed: boostsLeft === 0,
      boostsLeft,
    });
  });

  app.get("/parties/:slug/me/songs", (c) => {
    let guest;
    try {
      guest = requireGuest(c);
    } catch {
      return c.json({ error: "No session", code: "NO_SESSION" }, 401);
    }
    const party = getPartyBySlug(db, c.req.param("slug"));
    if (!party) return c.json({ error: "Party not found", code: "NOT_FOUND" }, 404);

    const limits = parseRateLimits(party.rate_limits);
    const boostsLeft = remainingQuota(db, guest.id, limits).boost;
    const { active, history } = getGuestMySongs(
      db,
      party.id,
      guest.id,
      boostsLeft,
    );
    return c.json({
      active,
      history,
      boostUsed: boostsLeft === 0,
      boostsLeft,
    });
  });

  app.delete("/parties/:slug/me/songs/:itemId", async (c) => {
    const slug = c.req.param("slug");
    const itemId = c.req.param("itemId");
    let guest;
    try {
      guest = requireGuest(c);
    } catch {
      return c.json({ error: "No session", code: "NO_SESSION" }, 403);
    }
    if (!guest.displayName) {
      return c.json(
        { error: "Display name required", code: "DISPLAY_NAME_REQUIRED" },
        403,
      );
    }

    const party = getPartyBySlug(db, slug);
    if (!party || party.status !== "on") {
      return c.json({ error: "Party is off", code: "PARTY_OFF" }, 403);
    }

    const item = db
      .query(
        `SELECT id, status, is_boosted, added_by_guest_id FROM queue_items WHERE id = ? AND party_id = ?`,
      )
      .get(itemId, party.id) as {
      id: string;
      status: string;
      is_boosted: number;
      added_by_guest_id: string | null;
    } | null;
    if (!item || item.added_by_guest_id !== guest.id) {
      return c.json({ error: "Not your song", code: "NOT_OWNER" }, 403);
    }
    if (item.status === "playing") {
      return c.json({ error: "Cannot remove now playing", code: "NOW_PLAYING" }, 400);
    }
    if (!["pending", "queued"].includes(item.status)) {
      return c.json({ error: "Song already finished", code: "INVALID_ITEM" }, 400);
    }

    markFinished(db, itemId, "skipped");
    requestPartySync(db, party.id);
    return c.json({ ok: true });
  });

  app.post("/parties/:slug/me/songs/:itemId/unboost", async (c) => {
    const slug = c.req.param("slug");
    const itemId = c.req.param("itemId");
    let guest;
    try {
      guest = requireGuest(c);
    } catch {
      return c.json({ error: "No session", code: "NO_SESSION" }, 403);
    }
    if (!guest.displayName) {
      return c.json(
        { error: "Display name required", code: "DISPLAY_NAME_REQUIRED" },
        403,
      );
    }

    const party = getPartyBySlug(db, slug);
    if (!party || party.status !== "on") {
      return c.json({ error: "Party is off", code: "PARTY_OFF" }, 403);
    }

    const item = db
      .query(
        `SELECT id, status, is_boosted, added_by_guest_id FROM queue_items WHERE id = ? AND party_id = ?`,
      )
      .get(itemId, party.id) as {
      id: string;
      status: string;
      is_boosted: number;
      added_by_guest_id: string | null;
    } | null;
    if (!item || item.added_by_guest_id !== guest.id) {
      return c.json({ error: "Not your song", code: "NOT_OWNER" }, 403);
    }
    if (item.is_boosted !== 1) {
      return c.json({ error: "Song is not boosted", code: "NOT_BOOSTED" }, 400);
    }
    if (item.status === "playing") {
      return c.json({ error: "Cannot unboost now playing", code: "NOW_PLAYING" }, 400);
    }
    if (!["pending", "queued"].includes(item.status)) {
      return c.json({ error: "Song already finished", code: "INVALID_ITEM" }, 400);
    }

    db.run(
      `UPDATE queue_items SET is_boosted = 0, boost_position = NULL, boosted_by_guest_id = NULL, status = 'pending' WHERE id = ?`,
      [itemId],
    );
    requestPartySync(db, party.id);
    return c.json({ ok: true });
  });

  app.get("/parties/:slug/me", (c) => {
    const guest = getGuest(c);
    if (!guest) return c.json({ error: "No session", code: "NO_SESSION" }, 401);
    const party = getPartyBySlug(db, c.req.param("slug"));
    if (!party) return c.json({ error: "Party not found", code: "NOT_FOUND" }, 404);
    const limits = parseRateLimits(party.rate_limits);
    const quota = remainingQuota(db, guest.id, limits);
    return c.json({
      id: guest.id,
      displayName: guest.displayName,
      boostUsed: quota.boost === 0,
      tutorialSeen: guest.tutorialSeen,
      activeSongCount: countGuestActiveSongs(db, party.id, guest.id),
      quota,
    });
  });

  async function handleAdd(
    c: import("hono").Context<GuestVars>,
    db: Db,
    spotifyClient: SpotifyClient,
    isHost: boolean,
  ) {
    const slug = c.req.param("slug")!;
    let guest = getGuest(c);
    if (!isHost) {
      try {
        guest = requireGuest(c);
      } catch {
        return c.json({ error: "No session", code: "NO_SESSION" }, 401);
      }
      if (!guest?.displayName) {
        return c.json(
          { error: "Display name required", code: "DISPLAY_NAME_REQUIRED" },
          403,
        );
      }
    }

    const party = getPartyBySlug(db, slug);
    if (!party || party.status !== "on") {
      return c.json({ error: "Party is off", code: "PARTY_OFF" }, 403);
    }

    const body = (await c.req.json()) as {
      uri: string;
      name?: string;
      artistName?: string;
      albumArtUrl?: string | null;
    };
    if (!body.uri?.startsWith("spotify:track:")) {
      return c.json({ error: "Invalid URI", code: "INVALID_URI" }, 400);
    }

    if (guest && !isHost) {
      const limits = parseRateLimits(party.rate_limits);
      const rl = checkRateLimit(db, guest.id, "add", limits);
      if (!rl.allowed) {
        return c.json(
          {
            error: "Rate limited",
            code: "RATE_LIMITED",
            retryAfterMs: rl.retryAfterMs,
          },
          429,
        );
      }
    }

    let trackInfo;
    if (body.name && body.artistName) {
      trackInfo = {
        uri: body.uri,
        name: body.name,
        artistName: body.artistName,
        albumArtUrl: body.albumArtUrl ?? null,
        durationMs: body.durationMs ?? null,
      };
    } else {
      const cached = getCachedTrackMetadata(body.uri);
      if (cached) {
        trackInfo = cached;
      } else {
        try {
          const trackId = body.uri.replace("spotify:track:", "");
          const tracks = await spotifyClient.searchTracks(`track:${trackId}`, 1);
          trackInfo = tracks[0]
            ? trackFromSpotify(tracks[0])
            : {
                uri: body.uri,
                name: "Unknown",
                artistName: "Unknown",
                albumArtUrl: null,
              };
        } catch {
          trackInfo = {
            uri: body.uri,
            name: "Unknown",
            artistName: "Unknown",
            albumArtUrl: null,
          };
        }
      }
    }

    try {
      const id = insertQueueItem(db, {
        partyId: party.id,
        uri: trackInfo.uri,
        name: trackInfo.name,
        artistName: trackInfo.artistName,
        albumArtUrl: trackInfo.albumArtUrl,
        durationMs: trackInfo.durationMs ?? null,
        guestId: isHost ? null : guest!.id,
      });
      if (guest && !isHost) recordAction(db, guest.id, "add");
      requestPartySync(db, party.id);
      return c.json({ id }, 201);
    } catch (e) {
      if (e instanceof DuplicateQueueItemError) {
        return c.json(
          { error: "This song is already in the queue", code: "DUPLICATE" },
          409,
        );
      }
      throw e;
    }
  }

  return app;
}

export async function addTrackToParty(
  db: Db,
  partyId: string,
  track: {
    uri: string;
    name: string;
    artistName: string;
    albumArtUrl: string | null;
    durationMs?: number | null;
  },
  guestId: string | null,
  fromSeed = false,
): Promise<string> {
  try {
    return insertQueueItem(db, {
      partyId,
      uri: track.uri,
      name: track.name,
      artistName: track.artistName,
      albumArtUrl: track.albumArtUrl,
      durationMs: track.durationMs ?? null,
      guestId,
      fromSeed,
    });
  } catch (e) {
    if (e instanceof DuplicateQueueItemError) {
      throw new Error("DUPLICATE");
    }
    throw e;
  }
}
