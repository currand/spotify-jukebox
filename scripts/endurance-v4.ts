#!/usr/bin/env bun
/**
 * Jukebox Endurance Test Harness
 *
 * Simulates N guests over HOURS, performing realistic party behaviors:
 * - Join, set display name
 * - Search for tracks (realistic queries)
 * - Add songs to queue
 * - Upvote songs
 * - Veto songs
 * - Boost songs (once per guest)
 *
 * Meanwhile, monitors:
 * - /host/diagnostics every 30s (API calls, cache hit rate, rate limits)
 * - Sync worker status
 * - All HTTP responses (especially 429s)
 *
 * Usage:
 *   bun run scripts/endurance-test.ts --slug <party-slug> [--guests 15] [--hours 2] [--admin-token <token>]
 *
 * Requirements:
 *   - Party must already exist and be "on"
 *   - Server running at https://jukebox.REDACTED.example.com
 *   - Admin host session token for diagnostics
 */

// ── Configuration ──────────────────────────────────────────────────────────
interface TestConfig {
  baseUrl: string;
  partySlug: string;
  guestCount: number;
  durationHours: number;
  adminToken: string | null;
}

// ── Song catalog for realistic searches ────────────────────────────────────
const SONG_CATALOG = [
  { query: "bohemian rhapsody", name: "Bohemian Rhapsody", artist: "Queen" },
  { query: "uptown funk", name: "Uptown Funk", artist: "Mark Ronson ft. Bruno Mars" },
  { query: "shake it off", name: "Shake It Off", artist: "Taylor Swift" },
  { query: "sweet caroline", name: "Sweet Caroline", artist: "Neil Diamond" },
  { query: "don't stop believin", name: "Don't Stop Believin'", artist: "Journey" },
  { query: "living on a prayer", name: "Livin' on a Prayer", artist: "Bon Jovi" },
  { query: "dancing queen", name: "Dancing Queen", artist: "ABBA" },
  { query: "mr brightside", name: "Mr. Brightside", artist: "The Killers" },
  { query: "dreams", name: "Dreams", artist: "Fleetwood Mac" },
  { query: "billie jean", name: "Billie Jean", artist: "Michael Jackson" },
  { query: "stairway to heaven", name: "Stairway to Heaven", artist: "Led Zeppelin" },
  { query: "hotel california", name: "Hotel California", artist: "Eagles" },
  { query: "wonderwall", name: "Wonderwall", artist: "Oasis" },
  { query: "smells like teen spirit", name: "Smells Like Teen Spirit", artist: "Nirvana" },
  { query: "hey jude", name: "Hey Jude", artist: "The Beatles" },
  { query: "respect", name: "Respect", artist: "Aretha Franklin" },
  { query: "superstition", name: "Superstition", artist: "Stevie Wonder" },
  { query: "good vibrations", name: "Good Vibrations", artist: "The Beach Boys" },
  { query: "purple rain", name: "Purple Rain", artist: "Prince" },
  { query: "watermelon sugar", name: "Watermelon Sugar", artist: "Harry Styles" },
  { query: "blinding lights", name: "Blinding Lights", artist: "The Weeknd" },
  { query: "levitating", name: "Levitating", artist: "Dua Lipa" },
  { query: "bad guy", name: "bad guy", artist: "Billie Eilish" },
  { query: "dance monkey", name: "Dance Monkey", artist: "Tones and I" },
  { query: "old town road", name: "Old Town Road", artist: "Lil Nas X" },
  { query: "shape of you", name: "Shape of You", artist: "Ed Sheeran" },
  { query: "thinking out loud", name: "Thinking Out Loud", artist: "Ed Sheeran" },
  { query: "all of me", name: "All of Me", artist: "John Legend" },
  { query: "rolling in the deep", name: "Rolling in the Deep", artist: "Adele" },
  { query: "someone like you", name: "Someone Like You", artist: "Adele" },
  { query: "get lucky", name: "Get Lucky", artist: "Daft Punk" },
  { query: "locked out of heaven", name: "Locked Out of Heaven", artist: "Bruno Mars" },
  { query: "uptown funk", name: "Uptown Funk", artist: "Bruno Mars" },
  { query: "24k magic", name: "24K Magic", artist: "Bruno Mars" },
  { query: "that's what i like", name: "That's What I Like", artist: "Bruno Mars" },
  { query: "girls just want to have fun", name: "Girls Just Want to Have Fun", artist: "Cyndi Lauper" },
  { query: "take on me", name: "Take On Me", artist: "a-ha" },
  { query: "never gonna give you up", name: "Never Gonna Give You Up", artist: "Rick Astley" },
  { query: "wake me up before you go go", name: "Wake Me Up Before You Go-Go", artist: "Wham!" },
  { query: "i wanna dance with somebody", name: "I Wanna Dance with Somebody", artist: "Whitney Houston" },
  { query: "don't stop me now", name: "Don't Stop Me Now", artist: "Queen" },
  { query: "we will rock you", name: "We Will Rock You", artist: "Queen" },
  { query: "another one bites the dust", name: "Another One Bites the Dust", artist: "Queen" },
  { query: "somebody to love", name: "Somebody to Love", artist: "Queen" },
  { query: "under pressure", name: "Under Pressure", artist: "Queen & David Bowie" },
  { query: "radio ga ga", name: "Radio Ga Ga", artist: "Queen" },
  { query: "i want to break free", name: "I Want to Break Free", artist: "Queen" },
  { query: "the show must go on", name: "The Show Must Go On", artist: "Queen" },
  { query: "crazy little thing called love", name: "Crazy Little Thing Called Love", artist: "Queen" },
  { query: "bohemian rhapsody live", name: "Bohemian Rhapsody (Live)", artist: "Queen" },
];

// ── Guest names ────────────────────────────────────────────────────────────
const BASE_GUEST_NAMES = [
  "Alice", "Bob", "Charlie", "Diana", "Eve", "Frank", "Grace", "Hank",
  "Iris", "Jack", "Karen", "Leo", "Mona", "Nick", "Olive", "Paul",
  "Quinn", "Rita", "Sam", "Tina", "Uma", "Vince", "Wendy", "Xander",
  "Yolanda", "Zach", "Amy", "Ben", "Clara", "Dan",
];

// ── Rate limit defaults ────────────────────────────────────────────────────
const LIMITS = {
  add:    { count: 3,  windowMs: 20 * 60 * 1000 },
  upvote: { count: 10, windowMs: 60 * 60 * 1000 },
  veto:   { count: 3,  windowMs: 30 * 60 * 1000 },
  search: { count: 6,  windowMs: 60 * 1000 },
};

// ── Logging ────────────────────────────────────────────────────────────────
interface LogEntry {
  time: string;
  guest?: string;
  action: string;
  detail: string;
  status?: number;
  error?: string;
  latencyMs?: number;
}

const logs: LogEntry[] = [];
const metrics: {
  timestamp: string;
  apiTotal: number;
  apiLast5m: number;
  rateLimitCount: number;
  cacheHitRate: number;
  searchTotal: number;
  searchCacheHits: number;
  syncDeviceActive: boolean;
  syncRateLimited: boolean;
  syncLastError: string | null;
  queueSize: number;
  guestCount: number;
}[] = [];

let totalActions = 0;
let totalErrors = 0;
let total429s = 0;

function log(entry: LogEntry): void {
  logs.push(entry);
  const ts = entry.time.slice(11, 19);
  const guest = entry.guest ? `[${entry.guest}]` : "[SYS]";
  const status = entry.status ? ` → ${entry.status}` : "";
  const err = entry.error ? ` ERR: ${entry.error}` : "";
  const ms = entry.latencyMs ? ` (${entry.latencyMs}ms)` : "";
  console.log(`${ts} ${guest} ${entry.action} ${entry.detail}${status}${err}${ms}`);
}

function logError(guest: string, action: string, detail: string, status: number, error: string): void {
  totalErrors++;
  if (status === 429) total429s++;
  log({ time: new Date().toISOString(), guest, action, detail, status, error });
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
async function api(
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
): Promise<{ status: number; json: any; latencyMs: number; setCookie: string | null }> {
  const start = Date.now();
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(`https://jukebox.REDACTED.example.com${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const latencyMs = Date.now() - start;
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON response
  }
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, json, latencyMs, setCookie };
}

// ── Guest simulator ────────────────────────────────────────────────────────
interface GuestState {
  name: string;
  token: string | null;
  guestId: string | null;
  boostUsed: boolean;
  addedSongs: string[];       // IDs of songs this guest added
  upvotedSongs: string[];     // IDs of songs this guest upvoted
  vetoedSongs: string[];      // IDs of songs this guest vetoed
  actions: number;
  errors: number;
}

function randomDelay(minMs: number, maxMs: number): number {
  return Math.floor(Math.random() * (maxMs - minMs)) + minMs;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

async function guestLoop(
  config: TestConfig,
  guest: GuestState,
  queueRef: { items: any[] },
  shutdown: () => boolean,
  savedGuest?: { name: string; guestId: string; cookie: string },
): Promise<void> {
  const slug = config.partySlug;
  const cookieName = `guest_session_${slug}`;


  // ── Join or reuse saved session ─────────────────────────────────
  let cookie: string;
  if (savedGuest && savedGuest.cookie) {
    cookie = savedGuest.cookie;
    guest.guestId = savedGuest.guestId;
    guest.token = savedGuest.cookie.split("=")[1];
  } else {
  // ── Step 1: Join ──────────────────────────────────────────────────────
  const joinRes = await api("POST", `/api/v1/parties/${slug}/join`, {
    displayName: guest.name,
  });

  if (joinRes.status !== 200) {
    logError(guest.name, "join", `Failed to join`, joinRes.status, JSON.stringify(joinRes.json));
    return;
  }

  guest.guestId = joinRes.json.id;

  // Extract cookie from Set-Cookie header (production doesn't return sessionToken in body)
  if (joinRes.setCookie) {
    const match = joinRes.setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
    if (match) {
      cookie = `${cookieName}=${match[1]}`;
      guest.token = match[1];
    }
  }
  // Fallback: try body sessionToken (dev mode)
  if (!guest.token && joinRes.json.sessionToken) {
    guest.token = joinRes.json.sessionToken;
    cookie = `${cookieName}=${guest.token}`;
  }
  } // end else

  log({ time: new Date().toISOString(), guest: guest.name, action: savedGuest ? "reused" : "joined", detail: "id=" + (guest.guestId || "").slice(0, 8) });

  // ── Step 2: Behavior loop ─────────────────────────────────────────────
  while (!shutdown()) {
    const action = pickRandom(["search", "search", "add", "upvote", "veto", "boost", "view_queue", "view_my_songs"]);

    try {
      switch (action) {
        case "search": {
          // Mix: 60% known songs, 40% random/obscure queries (to stress cache differently)
          const useRandom = Math.random() < 0.4;
          const song = useRandom
            ? { query: `party ${Math.floor(Math.random() * 1000)} ${pickRandom(["remix", "live", "acoustic", "cover", "version"])}`, name: "Unknown", artist: "Unknown" }
            : pickRandom(SONG_CATALOG);
          const start = Date.now();
          const res = await api("GET", `/api/v1/parties/${slug}/search?q=${encodeURIComponent(song.query)}`, undefined, cookie);
          const latency = Date.now() - start;

          if (res.status === 200) {
            const trackCount = res.json.tracks?.length ?? 0;
            log({ time: new Date().toISOString(), guest: guest.name, action: "search", detail: `"${song.query}" → ${trackCount} tracks`, status: 200, latencyMs: latency });
          } else if (res.status === 429) {
            logError(guest.name, "search", `"${song.query}"`, 429, res.json?.error ?? "rate limited");
          } else {
            logError(guest.name, "search", `"${song.query}"`, res.status, res.json?.error ?? "unknown");
          }
          guest.actions++;
          totalActions++;
          break;
        }

        case "add": {
          const song = pickRandom(SONG_CATALOG);
          // Search first, then add a real track from results
          const searchRes = await api("GET", `/api/v1/parties/${slug}/search?q=` + encodeURIComponent(song.query), undefined, cookie);
          if (searchRes.status !== 200 || !searchRes.json.tracks || !searchRes.json.tracks.length) break;
          const track = searchRes.json.tracks[Math.floor(Math.random() * searchRes.json.tracks.length)];
          const res = await api("POST", `/api/v1/parties/${slug}/queue`, {
            uri: track.uri,
            name: track.name,
            artistName: (track.artists || []).map((a) => a.name).join(", ") || "Unknown",
          }, cookie);

          if (res.status === 201) {
            guest.addedSongs.push(res.json.id);
            log({ time: new Date().toISOString(), guest: guest.name, action: "add", detail: `"${song.name}" → ${res.json.id}`, status: 201 });
          } else if (res.status === 429) {
            logError(guest.name, "add", `"${song.name}"`, 429, res.json?.error ?? "rate limited");
          } else if (res.status === 409) {
            log({ time: new Date().toISOString(), guest: guest.name, action: "add_dup", detail: `"${song.name}" already in queue`, status: 409 });
          } else {
            logError(guest.name, "add", `"${song.name}"`, res.status, res.json?.error ?? "unknown");
          }
          guest.actions++;
          totalActions++;
          break;
        }

        case "upvote": {
          // Pick a random song from the queue that isn't this guest's
          const candidates = queueRef.items.filter(
            (i) => i.addedByGuestId !== guest.guestId && !guest.upvotedSongs.includes(i.id),
          );
          if (candidates.length === 0) break;

          const target = pickRandom(candidates);
          const res = await api("POST", `/api/v1/parties/${slug}/queue/${target.id}/upvote`, undefined, cookie);

          if (res.status === 200) {
            guest.upvotedSongs.push(target.id);
            log({ time: new Date().toISOString(), guest: guest.name, action: "upvote", detail: `"${target.trackName}"`, status: 200 });
          } else if (res.status === 429) {
            logError(guest.name, "upvote", `"${target.trackName}"`, 429, res.json?.error ?? "rate limited");
          } else {
            log({ time: new Date().toISOString(), guest: guest.name, action: "upvote_fail", detail: `"${target.trackName}" → ${res.json?.code}`, status: res.status });
          }
          guest.actions++;
          totalActions++;
          break;
        }

        case "veto": {
          const candidates = queueRef.items.filter(
            (i) => i.status === "pending" && !guest.vetoedSongs.includes(i.id),
          );
          if (candidates.length === 0) break;

          const target = pickRandom(candidates);
          const res = await api("POST", `/api/v1/parties/${slug}/queue/${target.id}/veto`, undefined, cookie);

          if (res.status === 200) {
            guest.vetoedSongs.push(target.id);
            log({ time: new Date().toISOString(), guest: guest.name, action: "veto", detail: `"${target.trackName}"`, status: 200 });
          } else if (res.status === 429) {
            logError(guest.name, "veto", `"${target.trackName}"`, 429, res.json?.error ?? "rate limited");
          } else {
            log({ time: new Date().toISOString(), guest: guest.name, action: "veto_fail", detail: `"${target.trackName}" → ${res.json?.code}`, status: res.status });
          }
          guest.actions++;
          totalActions++;
          break;
        }

        case "boost": {
          if (guest.boostUsed) break;
          const candidates = queueRef.items.filter(
            (i) => i.status === "pending" && !i.isBoosted,
          );
          if (candidates.length === 0) break;

          const target = pickRandom(candidates);
          const res = await api("POST", `/api/v1/parties/${slug}/queue/${target.id}/boost`, undefined, cookie);

          if (res.status === 200) {
            guest.boostUsed = true;
            log({ time: new Date().toISOString(), guest: guest.name, action: "boost", detail: `"${target.trackName}"`, status: 200 });
          } else {
            log({ time: new Date().toISOString(), guest: guest.name, action: "boost_fail", detail: `"${target.trackName}" → ${res.json?.code}`, status: res.status });
          }
          guest.actions++;
          totalActions++;
          break;
        }

        case "view_queue": {
          const res = await api("GET", `/api/v1/parties/${slug}/queue`, undefined, cookie);
          if (res.status === 200) {
            queueRef.items = [
              ...(res.json.upcomingOrder ?? []),
            ];
          }
          guest.actions++;
          totalActions++;
          break;
        }

        case "view_my_songs": {
          await api("GET", `/api/v1/parties/${slug}/me/songs`, undefined, cookie);
          guest.actions++;
          totalActions++;
          break;
        }
      }
    } catch (e) {
      logError(guest.name, "exception", String(e), 0, String(e));
    }

    // Random delay between actions (5-30 seconds — realistic party pace)
    await Bun.sleep(randomDelay(5000, 30000));
  }

  log({ time: new Date().toISOString(), guest: guest.name, action: "finished", detail: `${guest.actions} actions, ${guest.errors} errors` });
}

// ── Diagnostics monitor ────────────────────────────────────────────────────
async function diagnosticsLoop(
  config: TestConfig,
  shutdown: () => boolean,
): Promise<void> {
  const slug = config.partySlug;

  while (!shutdown()) {
    try {
      // Poll diagnostics (needs host session)
      if (config.adminToken) {
        const diagRes = await api("GET", "/api/v1/host/diagnostics", undefined, `host_session=${config.adminToken}`);
        if (diagRes.status === 200 && diagRes.json) {
          const d = diagRes.json;
          metrics.push({
            timestamp: new Date().toISOString(),
            apiTotal: d.spotifyApi?.total ?? 0,
            apiLast5m: d.spotifyApi?.last1m ?? 0,
            rateLimitCount: d.spotifyApi?.rateLimitCount ?? 0,
            cacheHitRate: d.search?.hitRate ?? 0,
            searchTotal: d.search?.total ?? 0,
            searchCacheHits: d.search?.cacheHits ?? 0,
            syncDeviceActive: d.sync?.deviceActive ?? false,
            syncRateLimited: (d.sync?.retryAfterMs ?? 0) > 0,
            syncLastError: d.sync?.lastError ?? null,
            queueSize: 0,
            guestCount: 0,
          });

          const m = metrics[metrics.length - 1]!;
          log({
            time: m.timestamp,
            action: "diagnostics",
            detail: `API:${m.apiTotal} RateLimits:${m.rateLimitCount} Cache:${(m.cacheHitRate * 100).toFixed(0)}% Searches:${m.searchTotal} Sync:${m.syncDeviceActive ? "active" : "inactive"}${m.syncRateLimited ? " ⚠️ RATE LIMITED" : ""}`,
          });
        }
      }

      // Poll queue state
      const queueRes = await api("GET", `/api/v1/parties/${slug}/queue`);
      if (queueRes.status === 200 && queueRes.json) {
        const q = queueRes.json;
        const nowPlaying = q.nowPlaying?.trackName ?? "none";
        const upcoming = (q.upcomingOrder ?? []).length;
        const boostLane = (q.boostLane ?? []).length;
        log({
          time: new Date().toISOString(),
          action: "queue_state",
          detail: `Now: "${nowPlaying}" | Upcoming: ${upcoming} | Boost: ${boostLane}`,
        });
      }
    } catch (e) {
      log({ time: new Date().toISOString(), action: "diag_error", detail: String(e) });
    }

    // Poll every 30 seconds
    await Bun.sleep(30000);
  }
}

// ── Summary reporter ───────────────────────────────────────────────────────
function printSummary(guests: GuestState[], startTime: number): void {
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log("\n" + "═".repeat(70));
  console.log(`  ENDURANCE TEST SUMMARY — ${elapsed} minutes`);
  console.log("═".repeat(70));
  console.log(`  Total guest actions: ${totalActions}`);
  console.log(`  Total errors: ${totalErrors}`);
  console.log(`  Total 429s: ${total429s}`);
  console.log(`  Guests: ${guests.length}`);
  console.log();

  // Per-guest breakdown
  console.log("  Guest breakdown:");
  for (const g of guests) {
    console.log(`    ${g.name.padEnd(12)} actions=${String(g.actions).padStart(4)}  errors=${String(g.errors).padStart(3)}  added=${String(g.addedSongs.length).padStart(3)}  upvoted=${String(g.upvotedSongs.length).padStart(3)}  boosted=${g.boostUsed ? "yes" : "no"}`);
  }

  // Diagnostics timeline
  if (metrics.length > 0) {
    console.log();
    console.log("  API metrics timeline (last 10 readings):");
    const recent = metrics.slice(-10);
    for (const m of recent) {
      console.log(`    ${m.timestamp.slice(11, 19)}  API=${String(m.apiTotal).padStart(5)}  Limits=${String(m.rateLimitCount).padStart(3)}  Cache=${(m.cacheHitRate * 100).toFixed(0).padStart(3)}%  Searches=${String(m.searchTotal).padStart(4)}  Sync=${m.syncDeviceActive ? "✓" : "✗"}`);
    }
  }

  // 429 analysis
  const errors429 = logs.filter((l) => l.status === 429);
  if (errors429.length > 0) {
    console.log();
    console.log(`  429 errors (${errors429.length} total):`);
    const byAction = new Map<string, number>();
    for (const e of errors429) {
      byAction.set(e.action, (byAction.get(e.action) ?? 0) + 1);
    }
    for (const [action, count] of byAction) {
      console.log(`    ${action}: ${count}`);
    }
  }

  console.log("═".repeat(70));
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const slugIdx = args.indexOf("--slug");
  const guestsIdx = args.indexOf("--guests");
  const hoursIdx = args.indexOf("--hours");
  const adminIdx = args.indexOf("--admin-token");

  if (slugIdx === -1 || !args[slugIdx + 1]) {
    console.error("Usage: bun run scripts/endurance-test.ts --slug <party-slug> [--guests 15] [--hours 2] [--admin-token <token>]");
    process.exit(1);
  }

  const config: TestConfig = {
    baseUrl: "https://jukebox.REDACTED.example.com",
    partySlug: args[slugIdx + 1]!,
    guestCount: guestsIdx !== -1 ? parseInt(args[guestsIdx + 1]!) : 15,
    durationHours: hoursIdx !== -1 ? parseFloat(args[hoursIdx + 1]!) : 2,
    adminToken: adminIdx !== -1 ? args[adminIdx + 1]! : null,
  };

  const durationMs = config.durationHours * 60 * 60 * 1000;
  const startTime = Date.now();
  let shutdown = false;

  // Load pre-joined guests from file
  let savedGuests: { name: string; guestId: string; cookie: string }[] = [];
  try {
    const { readFileSync } = await import("fs");
    savedGuests = JSON.parse(readFileSync("./data/guests-" + config.partySlug + ".json", "utf8"));
    console.log("Loaded " + savedGuests.length + " pre-joined guests");
  } catch {
    console.log("No saved guests — will join fresh");
  }

  console.log("═".repeat(70));
  console.log("  JUKEBOX ENDURANCE TEST");
  console.log("═".repeat(70));
  console.log(`  Party: ${config.partySlug}`);
  console.log(`  Guests: ${config.guestCount}`);
  console.log(`  Duration: ${config.durationHours} hours`);
  console.log(`  Admin: ${config.adminToken ? "yes" : "no (no diagnostics)"}`);
  console.log("═".repeat(70));
  console.log();

  // Verify party exists and is on
  const partyRes = await api("GET", `/api/v1/parties/${config.partySlug}`);
  if (partyRes.status !== 200) {
    console.error(`Party not found or error: ${partyRes.status}`);
    process.exit(1);
  }
  if (partyRes.json.status !== "on") {
    console.error(`Party status is "${partyRes.json.status}" — must be "on"`);
    process.exit(1);
  }
  console.log(`✓ Party "${partyRes.json.name}" is on (${partyRes.json.slug})\n`);

  // Shared queue reference (updated by view_queue actions)
  const queueRef: { items: any[] } = { items: [] };

  // Create guest states
  const guestNames = BASE_GUEST_NAMES.slice(0, config.guestCount);
  const guests: GuestState[] = guestNames.map((name) => ({
    name,
    token: null,
    guestId: null,
    boostUsed: false,
    addedSongs: [],
    upvotedSongs: [],
    vetoedSongs: [],
    actions: 0,
    errors: 0,
  }));

  // Start diagnostics monitor
  const diagPromise = diagnosticsLoop(config, () => shutdown);

  // Stagger guest joins (2-5 seconds apart)
  const guestPromises: Promise<void>[] = [];
  for (let i = 0; i < guests.length; i++) {
    await Bun.sleep(randomDelay(2000, 5000));
    const saved = savedGuests.find((s) => s.name === guests[i]!.name);
    guestPromises.push(guestLoop(config, guests[i], queueRef, () => shutdown, saved));
  }

  console.log(`\n🚀 ${guests.length} guests launched. Running for ${config.durationHours} hours...\n`);

  // Set duration timer
  const deadline = startTime + durationMs;
  const statusInterval = setInterval(() => {
    const remaining = Math.max(0, deadline - Date.now());
    const elapsed = Date.now() - startTime;
    const pct = ((elapsed / durationMs) * 100).toFixed(1);
    console.log(`\n⏱️  [${pct}%] ${(remaining / 60000).toFixed(0)}min remaining | Actions: ${totalActions} | Errors: ${totalErrors} | 429s: ${total429s}\n`);
  }, 5 * 60 * 1000); // Status every 5 minutes

  // Wait for duration
  await Bun.sleep(durationMs);
  shutdown = true;

  clearInterval(statusInterval);

  // Wait for all guests to finish
  await Promise.allSettled(guestPromises);
  await Promise.allSettled([diagPromise]);

  // Print summary
  printSummary(guests, startTime);

  // Save logs to file
  const logPath = `./data/endurance-test-${Date.now()}.json`;
  const report = {
    config,
    startTime: new Date(startTime).toISOString(),
    endTime: new Date().toISOString(),
    summary: {
      totalActions,
      totalErrors,
      total429s,
      guests: guests.map((g) => ({
        name: g.name,
        actions: g.actions,
        errors: g.errors,
        added: g.addedSongs.length,
        upvoted: g.upvotedSongs.length,
        boosted: g.boostUsed,
      })),
    },
    metrics,
    logs: logs.slice(-200), // Last 200 log entries
  };

  const { writeFileSync, mkdirSync } = await import("fs");
  mkdirSync("./data", { recursive: true });
  writeFileSync(logPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 Full report saved to ${logPath}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
