import type { ApiResponse } from "./endurance-api.ts";
import { pickRandom, weightedRandom } from "./endurance-api.ts";
import { pickSearchQuery } from "./endurance-catalog.ts";
import {
  actionDelayMs,
  getPhaseAtElapsed,
  idleDelayMs,
  type Phase,
} from "./endurance-phases.ts";

export interface SavedGuest {
  name: string;
  guestId: string;
  cookie: string;
}

export interface GuestState {
  name: string;
  token: string | null;
  guestId: string | null;
  boostUsed: boolean;
  addedSongs: string[];
  upvotedSongs: string[];
  downvotedSongs: string[];
  duplicateAddAttempts: Set<string>;
  actions: number;
  errors: number;
  joined: boolean;
}

export interface GuestLoopContext {
  slug: string;
  cacheStress: boolean;
  testStartMs: number;
  api: (
    method: string,
    path: string,
    body?: unknown,
    cookie?: string,
  ) => Promise<ApiResponse>;
  queueRef: { items: QueueItemRef[] };
  shutdown: () => boolean;
  onAction: () => void;
  onError: (status: number) => void;
  log: (entry: LogEntry) => void;
}

export interface QueueItemRef {
  id: string;
  trackName: string;
  addedByGuestId: string | null;
  status: string;
  isBoosted: boolean;
}

export interface LogEntry {
  time: string;
  guest?: string;
  action: string;
  detail: string;
  status?: number;
  error?: string;
  latencyMs?: number;
}

export function createGuestState(name: string): GuestState {
  return {
    name,
    token: null,
    guestId: null,
    boostUsed: false,
    addedSongs: [],
    upvotedSongs: [],
    downvotedSongs: [],
    duplicateAddAttempts: new Set(),
    actions: 0,
    errors: 0,
    joined: false,
  };
}

function parseGuestCookie(
  slug: string,
  joinRes: ApiResponse,
): { cookie: string; token: string | null } {
  const cookieName = `guest_session_${slug}`;
  let token: string | null = null;
  let cookie = `${cookieName}=invalid`;

  if (joinRes.setCookie) {
    const match = joinRes.setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
    if (match) {
      token = match[1]!;
      cookie = `${cookieName}=${token}`;
    }
  }
  if (!token && joinRes.json?.sessionToken) {
    token = joinRes.json.sessionToken;
    cookie = `${cookieName}=${token}`;
  }
  return { cookie, token };
}

export async function joinGuest(
  ctx: GuestLoopContext,
  guest: GuestState,
  saved?: SavedGuest,
): Promise<string | null> {
  if (saved?.cookie) {
    guest.guestId = saved.guestId;
    guest.token = saved.cookie.split("=")[1] ?? null;
    guest.joined = true;
    ctx.log({
      time: new Date().toISOString(),
      guest: guest.name,
      action: "reused",
      detail: `id=${guest.guestId?.slice(0, 8) ?? "?"}`,
    });
    return saved.cookie;
  }

  const joinRes = await ctx.api("POST", `/api/v1/parties/${ctx.slug}/join`, {
    displayName: guest.name,
  });
  if (joinRes.status !== 200) {
    guest.errors++;
    ctx.onError(joinRes.status);
    ctx.log({
      time: new Date().toISOString(),
      guest: guest.name,
      action: "join_fail",
      detail: JSON.stringify(joinRes.json),
      status: joinRes.status,
      error: "join failed",
    });
    return null;
  }

  guest.guestId = joinRes.json.id;
  guest.joined = true;
  const { cookie, token } = parseGuestCookie(ctx.slug, joinRes);
  guest.token = token;
  ctx.log({
    time: new Date().toISOString(),
    guest: guest.name,
    action: "joined",
    detail: `id=${guest.guestId}`,
  });
  return cookie;
}

function getPhase(ctx: GuestLoopContext): Phase {
  return getPhaseAtElapsed(Date.now() - ctx.testStartMs);
}

export async function runGuestLoop(
  ctx: GuestLoopContext,
  guest: GuestState,
  cookie: string,
): Promise<void> {
  while (!ctx.shutdown()) {
    const phase = getPhase(ctx);

    if (Math.random() > phase.activityRate) {
      await Bun.sleep(idleDelayMs());
      continue;
    }

    const action = weightedRandom(
      ["search", "add", "upvote", "downvote", "boost", "idle"],
      phase.actionWeights,
    );

    if (action === "idle") {
      await Bun.sleep(idleDelayMs());
      continue;
    }

    try {
      switch (action) {
        case "search":
          await doSearch(ctx, guest, cookie);
          break;
        case "add":
          await doAdd(ctx, guest, cookie);
          break;
        case "upvote":
          await doUpvote(ctx, guest, cookie);
          break;
        case "downvote":
          await doDownvote(ctx, guest, cookie);
          break;
        case "boost":
          await doBoost(ctx, guest, cookie);
          break;
      }
    } catch (e) {
      guest.errors++;
      ctx.onError(0);
      ctx.log({
        time: new Date().toISOString(),
        guest: guest.name,
        action: "exception",
        detail: String(e),
        error: String(e),
      });
    }

    await Bun.sleep(actionDelayMs(phase));
  }
}

async function doSearch(
  ctx: GuestLoopContext,
  guest: GuestState,
  cookie: string,
): Promise<void> {
  const song = pickSearchQuery(ctx.cacheStress);
  const res = await ctx.api(
    "GET",
    `/api/v1/parties/${ctx.slug}/search?q=${encodeURIComponent(song.query)}`,
    undefined,
    cookie,
  );

  if (res.status === 200) {
    ctx.log({
      time: new Date().toISOString(),
      guest: guest.name,
      action: "search",
      detail: `"${song.query}" → ${res.json.tracks?.length ?? 0} tracks`,
      status: 200,
      latencyMs: res.latencyMs,
    });
  } else if (res.status === 429) {
    guest.errors++;
    ctx.onError(429);
    ctx.log({
      time: new Date().toISOString(),
      guest: guest.name,
      action: "search",
      detail: `"${song.query}"`,
      status: 429,
      error: res.json?.error ?? "rate limited",
    });
  } else if (res.status === 503) {
    ctx.log({
      time: new Date().toISOString(),
      guest: guest.name,
      action: "search_fail",
      detail: `"${song.query}" → unavailable`,
      status: 503,
    });
  } else {
    guest.errors++;
    ctx.onError(res.status);
    ctx.log({
      time: new Date().toISOString(),
      guest: guest.name,
      action: "search",
      detail: `"${song.query}"`,
      status: res.status,
      error: res.json?.error ?? "unknown",
    });
  }
  guest.actions++;
  ctx.onAction();
}

async function doAdd(
  ctx: GuestLoopContext,
  guest: GuestState,
  cookie: string,
): Promise<void> {
  const song = pickSearchQuery(ctx.cacheStress);
  if (guest.duplicateAddAttempts.has(song.name)) return;

  const searchRes = await ctx.api(
    "GET",
    `/api/v1/parties/${ctx.slug}/search?q=${encodeURIComponent(song.query)}`,
    undefined,
    cookie,
  );
  if (searchRes.status !== 200 || !searchRes.json.tracks?.length) return;

  const track = pickRandom(searchRes.json.tracks as { uri: string; name: string; artists?: { name: string }[] }[]);
  const res = await ctx.api(
    "POST",
    `/api/v1/parties/${ctx.slug}/queue`,
    {
      uri: track.uri,
      name: track.name,
      artistName: track.artists?.map((a) => a.name).join(", ") ?? song.artist,
    },
    cookie,
  );

  if (res.status === 201) {
    guest.addedSongs.push(res.json.id);
    ctx.log({
      time: new Date().toISOString(),
      guest: guest.name,
      action: "add",
      detail: `"${track.name}" → ${res.json.id}`,
      status: 201,
    });
  } else if (res.status === 409) {
    guest.duplicateAddAttempts.add(song.name);
    ctx.log({
      time: new Date().toISOString(),
      guest: guest.name,
      action: "add_dup",
      detail: `"${track.name}" already in queue`,
      status: 409,
    });
  } else if (res.status === 429) {
    guest.errors++;
    ctx.onError(429);
    ctx.log({
      time: new Date().toISOString(),
      guest: guest.name,
      action: "add",
      detail: `"${track.name}"`,
      status: 429,
      error: res.json?.error ?? "rate limited",
    });
  } else {
    guest.errors++;
    ctx.onError(res.status);
    ctx.log({
      time: new Date().toISOString(),
      guest: guest.name,
      action: "add",
      detail: `"${track.name}"`,
      status: res.status,
      error: res.json?.error ?? "unknown",
    });
  }
  guest.actions++;
  ctx.onAction();
}

async function doUpvote(
  ctx: GuestLoopContext,
  guest: GuestState,
  cookie: string,
): Promise<void> {
  const candidates = ctx.queueRef.items.filter(
    (i) => i.addedByGuestId !== guest.guestId && !guest.upvotedSongs.includes(i.id),
  );
  if (candidates.length === 0) return;

  const target = pickRandom(candidates);
  const res = await ctx.api(
    "POST",
    `/api/v1/parties/${ctx.slug}/queue/${target.id}/upvote`,
    undefined,
    cookie,
  );

  if (res.status === 200) {
    guest.upvotedSongs.push(target.id);
    ctx.log({
      time: new Date().toISOString(),
      guest: guest.name,
      action: "upvote",
      detail: `"${target.trackName}"`,
      status: 200,
    });
  } else if (res.status === 429) {
    guest.errors++;
    ctx.onError(429);
  } else {
    ctx.log({
      time: new Date().toISOString(),
      guest: guest.name,
      action: "upvote_fail",
      detail: `"${target.trackName}" → ${res.json?.code}`,
      status: res.status,
    });
  }
  guest.actions++;
  ctx.onAction();
}

async function doDownvote(
  ctx: GuestLoopContext,
  guest: GuestState,
  cookie: string,
): Promise<void> {
  const candidates = ctx.queueRef.items.filter(
    (i) => i.status === "pending" && !guest.downvotedSongs.includes(i.id),
  );
  if (candidates.length === 0) return;

  const target = pickRandom(candidates);
  const res = await ctx.api(
    "POST",
    `/api/v1/parties/${ctx.slug}/queue/${target.id}/downvote`,
    undefined,
    cookie,
  );

  if (res.status === 200) {
    guest.downvotedSongs.push(target.id);
    ctx.log({
      time: new Date().toISOString(),
      guest: guest.name,
      action: "downvote",
      detail: `"${target.trackName}"`,
      status: 200,
    });
  } else if (res.status === 429) {
    guest.errors++;
    ctx.onError(429);
  } else {
    ctx.log({
      time: new Date().toISOString(),
      guest: guest.name,
      action: "downvote_fail",
      detail: `"${target.trackName}" → ${res.json?.code}`,
      status: res.status,
    });
  }
  guest.actions++;
  ctx.onAction();
}

async function doBoost(
  ctx: GuestLoopContext,
  guest: GuestState,
  cookie: string,
): Promise<void> {
  if (guest.boostUsed) return;
  const candidates = ctx.queueRef.items.filter(
    (i) => i.status === "pending" && !i.isBoosted,
  );
  if (candidates.length === 0) return;

  const target = pickRandom(candidates);
  const res = await ctx.api(
    "POST",
    `/api/v1/parties/${ctx.slug}/queue/${target.id}/boost`,
    undefined,
    cookie,
  );

  if (res.status === 200) {
    guest.boostUsed = true;
    ctx.log({
      time: new Date().toISOString(),
      guest: guest.name,
      action: "boost",
      detail: `"${target.trackName}"`,
      status: 200,
    });
  } else {
    ctx.log({
      time: new Date().toISOString(),
      guest: guest.name,
      action: "boost_fail",
      detail: `"${target.trackName}" → ${res.json?.code}`,
      status: res.status,
    });
  }
  guest.actions++;
  ctx.onAction();
}

export async function refreshQueue(
  ctx: GuestLoopContext,
  cookie?: string,
): Promise<void> {
  const res = await ctx.api(
    "GET",
    `/api/v1/parties/${ctx.slug}/queue`,
    undefined,
    cookie,
  );
  if (res.status === 200 && res.json) {
    ctx.queueRef.items = [...(res.json.upcomingOrder ?? [])];
  }
}
