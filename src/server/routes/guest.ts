import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Config } from "../config";
import { newId } from "../crypto";
import type { Db } from "../db/schema";
import {
  guestSessionMiddleware,
  setGuestCookie,
} from "../middleware/session";
import { isDuplicateTitle } from "@/shared/dedup";
import { touchGuestLastSeen, countGuestActiveSongs, getGuestMySongs } from "../services/guests";
import { getClientIp } from "../client-ip";
import {
  bumpSyncGeneration,
  computeQueueEtag,
  getBoostLane,
  getDedupTitles,
  getNormalUpcoming,
  getNextUpcomingItem,
  getQueueItems,
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
  createSpotifyClient,
  trackFromSpotify,
} from "../services/spotify";
import { syncPartyQueue } from "../services/sync";
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
  return JSON.parse(json) as PartyRateLimits;
}

function getPartyBySlug(db: Db, slug: string) {
  return db
    .query(`SELECT * FROM parties WHERE slug = ? AND status != 'archived'`)
    .get(slug) as
    | {
        id: string;
        slug: string;
        name: string;
        status: string;
        veto_threshold: number;
        rate_limits: string;
        updated_at: string;
      }
    | null;
}

export function createGuestRoutes(db: Db, config: Config) {
  const spotify = createSpotifyClient(db, config);
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
          `SELECT id, display_name, boost_used FROM guests
           WHERE session_token = ? AND party_id = ?`,
        )
        .get(existingToken, party.id) as
        | { id: string; display_name: string | null; boost_used: number }
        | null;
      if (existing) {
        touchGuestLastSeen(db, existing.id, clientIp);
        return c.json({
          id: existing.id,
          displayName: existing.display_name,
          boostUsed: existing.boost_used === 1,
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
          `SELECT id, display_name, boost_used, session_token FROM guests
           WHERE session_token = ? AND party_id = ?`,
        )
        .get(resumeToken, party.id) as
        | {
            id: string;
            display_name: string | null;
            boost_used: number;
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

    const body = (await c.req.json()) as { displayName: string };
    const name = body.displayName?.trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
    if (!name) {
      return c.json(
        { error: "Display name required", code: "DISPLAY_NAME_REQUIRED" },
        400,
      );
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
    const toGuestQueueItemView = (row: (typeof items)[number]) => ({
      ...toQueueItemView(row),
      guestUpvoteBlocked: isGuestUpvoteBlocked(items, row.id),
      guestBoostBlocked: isGuestBoostBlocked(items, row.id),
      guestVetoBlocked: isGuestVetoBlocked(items, row.id),
    });
    const boostLane = getBoostLane(items).map(toGuestQueueItemView);
    const upcoming = getNormalUpcoming(items).map(toGuestQueueItemView);

    c.header("ETag", etag);
    return c.json({
      nowPlaying: nowPlaying ? toGuestQueueItemView(nowPlaying) : null,
      upcoming,
      boostLane,
      nextItemId: nextItem?.id ?? null,
      dedupTitles: getDedupTitles(db, party.id),
      party: {
        id: party.id,
        slug: party.slug,
        name: party.name,
        status: party.status,
        vetoThreshold: party.veto_threshold,
        rateLimits: parseRateLimits(party.rate_limits),
      },
      etag,
    });
  });

  app.get("/parties/:slug/search", async (c) => {
    const party = getPartyBySlug(db, c.req.param("slug"));
    if (!party) return c.json({ error: "Party not found", code: "NOT_FOUND" }, 404);
    const q = c.req.query("q")?.trim();
    if (!q) return c.json({ tracks: [], artists: [] });

    try {
      const [tracks, artists] = await Promise.all([
        spotify.searchTracks(q, 10),
        spotify.searchArtists(q, 5),
      ]);
      return c.json({
        tracks: tracks.map((t) => {
          const info = trackFromSpotify(t);
          return {
            uri: info.uri,
            id: t.id,
            name: info.name,
            artistName: info.artistName,
            albumArtUrl: info.albumArtUrl,
          };
        }),
        artists,
      });
    } catch {
      return c.json({ error: "Search unavailable", code: "SPOTIFY_ERROR" }, 503);
    }
  });

  app.get("/parties/:slug/artists/:artistId/top-tracks", async (c) => {
    const party = getPartyBySlug(db, c.req.param("slug"));
    if (!party) return c.json({ error: "Party not found", code: "NOT_FOUND" }, 404);
    try {
      const tracks = await spotify.getArtistTopTracks(
        c.req.param("artistId"),
        c.req.query("name"),
      );
      return c.json({
        tracks: tracks.map((t) => {
          const info = trackFromSpotify(t);
          return {
            uri: info.uri,
            id: t.id,
            name: info.name,
            artistName: info.artistName,
            albumArtUrl: info.albumArtUrl,
          };
        }),
      });
    } catch {
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
        bumpSyncGeneration(db, party.id);
        await syncPartyQueue(db, spotify, party.id);
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
    if (guest.boostUsed) {
      return c.json({ error: "Boost already used", code: "BOOST_USED" }, 400);
    }

    const party = getPartyBySlug(db, slug);
    if (!party || party.status !== "on") {
      return c.json({ error: "Party is off", code: "PARTY_OFF" }, 403);
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

    const pos = nextBoostPosition(db, party.id);
    db.run(
      `UPDATE queue_items SET is_boosted = 1, boost_position = ?, status = 'pending' WHERE id = ?`,
      [pos, itemId],
    );
    db.run(`UPDATE guests SET boost_used = 1 WHERE id = ?`, [guest.id]);
    bumpSyncGeneration(db, party.id);
    await syncPartyQueue(db, spotify, party.id);
    return c.json({ ok: true });
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

    const { active, history } = getGuestMySongs(
      db,
      party.id,
      guest.id,
      guest.boostUsed,
    );
    return c.json({
      active,
      history,
      boostUsed: guest.boostUsed,
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
    if (item.is_boosted === 1 && guest.boostUsed) {
      db.run(`UPDATE guests SET boost_used = 0 WHERE id = ?`, [guest.id]);
    }
    bumpSyncGeneration(db, party.id);
    await syncPartyQueue(db, spotify, party.id);
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
      `UPDATE queue_items SET is_boosted = 0, boost_position = NULL, status = 'pending' WHERE id = ?`,
      [itemId],
    );
    if (guest.boostUsed) {
      db.run(`UPDATE guests SET boost_used = 0 WHERE id = ?`, [guest.id]);
    }
    bumpSyncGeneration(db, party.id);
    await syncPartyQueue(db, spotify, party.id);
    return c.json({ ok: true });
  });

  app.get("/parties/:slug/me", (c) => {
    const guest = getGuest(c);
    if (!guest) return c.json({ error: "No session", code: "NO_SESSION" }, 401);
    const party = getPartyBySlug(db, c.req.param("slug"));
    if (!party) return c.json({ error: "Party not found", code: "NOT_FOUND" }, 404);
    const quota = remainingQuota(
      db,
      guest.id,
      parseRateLimits(party.rate_limits),
    );
    return c.json({
      id: guest.id,
      displayName: guest.displayName,
      boostUsed: guest.boostUsed,
      activeSongCount: countGuestActiveSongs(db, party.id, guest.id),
      quota,
    });
  });

  async function handleAdd(
    c: import("hono").Context<GuestVars>,
    db: Db,
    spotifyClient: ReturnType<typeof createSpotifyClient>,
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
      };
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

    const titles = getDedupTitles(db, party.id);
    if (isDuplicateTitle(trackInfo.name, titles)) {
      return c.json(
        { error: "This song is already in the queue", code: "DUPLICATE" },
        409,
      );
    }

    const id = newId();
    db.run(
      `INSERT INTO queue_items (
        id, party_id, spotify_uri, track_name, artist_name, album_art_url,
        upvote_count, veto_count, status, is_boosted, boost_position,
        manual_order, added_by_guest_id, from_seed, added_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'pending', 0, NULL, NULL, ?, 0, ?)`,
      [
        id,
        party.id,
        trackInfo.uri,
        trackInfo.name,
        trackInfo.artistName,
        trackInfo.albumArtUrl,
        isHost ? null : guest!.id,
        new Date().toISOString(),
      ],
    );
    if (guest && !isHost) recordAction(db, guest.id, "add");
    await syncPartyQueue(db, spotifyClient, party.id);
    return c.json({ id }, 201);
  }

  return app;
}

export async function addTrackToParty(
  db: Db,
  partyId: string,
  track: { uri: string; name: string; artistName: string; albumArtUrl: string | null },
  guestId: string | null,
  fromSeed = false,
): Promise<string> {
  const titles = getDedupTitles(db, partyId);
  if (isDuplicateTitle(track.name, titles)) {
    throw new Error("DUPLICATE");
  }
  const id = newId();
  db.run(
    `INSERT INTO queue_items (
      id, party_id, spotify_uri, track_name, artist_name, album_art_url,
      upvote_count, veto_count, status, is_boosted, boost_position,
      manual_order, added_by_guest_id, from_seed, added_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'pending', 0, NULL, NULL, ?, ?, ?)`,
    [
      id,
      partyId,
      track.uri,
      track.name,
      track.artistName,
      track.albumArtUrl,
      guestId,
      fromSeed ? 1 : 0,
      new Date().toISOString(),
    ],
  );
  return id;
}
