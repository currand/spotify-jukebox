#!/usr/bin/env bun
/**
 * Jukebox Endurance Test v2 — Realistic Party Arc
 *
 * Simulates a real party with natural behavior phases:
 *   Phase 1 (0-60min):   Guests arrive gradually, search & add favorites
 *   Phase 2 (60-150min): Party in full swing — upvoting, vetoing, less adding
 *   Phase 3 (150-180min): Winding down — fewer actions, occasional adds
 *
 * Usage:
 *   bun run scripts/endurance-v2.ts --slug <party-slug> [--guests 30] [--admin-token <token>]
 */

// ── Configuration ──────────────────────────────────────────────────────────
interface TestConfig {
  baseUrl: string;
  partySlug: string;
  guestCount: number;
  adminToken: string | null;
}

// ── Song catalog ───────────────────────────────────────────────────────────
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
  { query: "hotel california", name: "Hotel California", artist: "Eagles" },
  { query: "wonderwall", name: "Wonderwall", artist: "Oasis" },
  { query: "smells like teen spirit", name: "Smells Like Teen Spirit", artist: "Nirvana" },
  { query: "hey jude", name: "Hey Jude", artist: "The Beatles" },
  { query: "respect", name: "Respect", artist: "Aretha Franklin" },
  { query: "superstition", name: "Superstition", artist: "Stevie Wonder" },
  { query: "purple rain", name: "Purple Rain", artist: "Prince" },
  { query: "watermelon sugar", name: "Watermelon Sugar", artist: "Harry Styles" },
  { query: "blinding lights", name: "Blinding Lights", artist: "The Weeknd" },
  { query: "levitating", name: "Levitating", artist: "Dua Lipa" },
  { query: "bad guy", name: "bad guy", artist: "Billie Eilish" },
  { query: "shape of you", name: "Shape of You", artist: "Ed Sheeran" },
  { query: "rolling in the deep", name: "Rolling in the Deep", artist: "Adele" },
  { query: "get lucky", name: "Get Lucky", artist: "Daft Punk" },
  { query: "locked out of heaven", name: "Locked Out of Heaven", artist: "Bruno Mars" },
  { query: "24k magic", name: "24K Magic", artist: "Bruno Mars" },
  { query: "girls just want to have fun", name: "Girls Just Want to Have Fun", artist: "Cyndi Lauper" },
  { query: "take on me", name: "Take On Me", artist: "a-ha" },
  { query: "never gonna give you up", name: "Never Gonna Give You Up", artist: "Rick Astley" },
  { query: "don't stop me now", name: "Don't Stop Me Now", artist: "Queen" },
  { query: "we will rock you", name: "We Will Rock You", artist: "Queen" },
  { query: "somebody to love", name: "Somebody to Love", artist: "Queen" },
  { query: "under pressure", name: "Under Pressure", artist: "Queen & David Bowie" },
  { query: "crazy little thing called love", name: "Crazy Little Thing Called Love", artist: "Queen" },
  { query: "i wanna dance with somebody", name: "I Wanna Dance with Somebody", artist: "Whitney Houston" },
  { query: "celebration", name: "Celebration", artist: "Kool & The Gang" },
  { query: "jump", name: "Jump", artist: "Van Halen" },
  { query: "summer of 69", name: "Summer of '69", artist: "Bryan Adams" },
  { query: "livin la vida loca", name: "Livin' La Vida Loca", artist: "Ricky Martin" },
  { query: "hey ya", name: "Hey Ya!", artist: "OutKast" },
];

const GUEST_NAMES = [
  "Alice", "Bob", "Charlie", "Diana", "Eve", "Frank", "Grace", "Hank",
  "Iris", "Jack", "Karen", "Leo", "Mona", "Nick", "Olive", "Paul",
  "Quinn", "Rita", "Sam", "Tina", "Uma", "Vince", "Wendy", "Xander",
  "Yolanda", "Zach", "Amy", "Ben", "Clara", "Dan",
];

// ── Phase definitions ──────────────────────────────────────────────────────
interface Phase {
  name: string;
  durationMs: number;
  /** Chance per tick that a guest performs an action (0-1) */
  activityRate: number;
  /** Weighted action distribution [search, add, upvote, veto, boost, idle] */
  actionWeights: number[];
}

const PHASES: Phase[] = [
  {
    name: "Arrival & Setup",
    durationMs: 60 * 60 * 1000,   // 60 min
    activityRate: 0.3,
    actionWeights: [30, 25, 15, 5, 5, 20], // heavy search + add
  },
  {
    name: "Party in Full Swing",
    durationMs: 90 * 60 * 1000,   // 90 min
    activityRate: 0.15,
    actionWeights: [15, 10, 30, 15, 5, 25], // heavy upvote + veto
  },
  {
    name: "Winding Down",
    durationMs: 30 * 60 * 1000,   // 30 min
    activityRate: 0.08,
    actionWeights: [10, 8, 20, 10, 2, 50], // mostly idle
  },
];

// ── Logging ────────────────────────────────────────────────────────────────
interface LogEntry {
  time: string;
  guest?: string;
  action: string;
  detail: string;
  status?: number;
  error?: string;
}

const logs: LogEntry[] = [];
const metricsHistory: any[] = [];
let totalActions = 0;
let totalErrors = 0;
let total429s = 0;

function log(entry: LogEntry): void {
  logs.push(entry);
  const ts = entry.time.slice(11, 19);
  const guest = entry.guest ? ("[" + (entry.guest) + "]") : "[SYS]";
  const status = entry.status ? (" → " + (entry.status)) : "";
  const err = entry.error ? (" ERR: " + (entry.error)) : "";
  console.log(((ts) + " " + (guest) + " " + (entry.action) + " " + (entry.detail) + (status) + (err)));
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

  const res = await fetch(("https://jukebox.REDACTED.example.com" + (path)), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const latencyMs = Date.now() - start;
  let json: any = null;
  try { json = await res.json(); } catch {}
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, json, latencyMs, setCookie };
}

function randomDelay(minMs: number, maxMs: number): number {
  return Math.floor(Math.random() * (maxMs - minMs)) + minMs;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function weightedRandom(items: string[], weights: number[]): string {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

// ── Guest simulator ────────────────────────────────────────────────────────
interface GuestState {
  name: string;
  token: string | null;
  guestId: string | null;
  boostUsed: boolean;
  addedSongs: string[];
  upvotedSongs: string[];
  vetoedSongs: string[];
  actions: number;
  joined: boolean;
}

async function guestLoop(
  config: TestConfig,
  guest: GuestState,
  queueRef: { items: any[] },
  getPhase: () => Phase,
  shutdown: () => boolean,
): Promise<void> {
  const slug = config.partySlug;
  const cookieName = ("guest_session_" + (slug));

  // ── Join ──────────────────────────────────────────────────────────────
  const joinRes = await api("POST", ("/api/v1/parties/" + (slug) + "/join", {
    displayName: guest.name,
  });

  if (joinRes.status !== 200) {
    logError(guest.name, "join", "Failed", joinRes.status, JSON.stringify(joinRes.json));
    return;
  }

  guest.guestId = joinRes.json.id;
  guest.joined = true;

  let cookie = ")${cookieName}=invalid";
  if (joinRes.setCookie) {
    const match = joinRes.setCookie.match(new RegExp(cookieName + "=([^;]+)"));
    if (match) {
      cookie = ((cookieName) + "=" + (match[1]));
      guest.token = match[1];
    }
  }
  if (!guest.token && joinRes.json.sessionToken) {
    guest.token = joinRes.json.sessionToken;
    cookie = ((cookieName) + "=" + (guest.token));
  }

  log({ time: new Date().toISOString(), guest: guest.name, action: "joined", detail: ("id=" + (guest.guestId)) });

  // ── Behavior loop ─────────────────────────────────────────────────────
  while (!shutdown()) {
    const phase = getPhase();

    // Check activity rate — many ticks are idle
    if (Math.random() > phase.activityRate) {
      await Bun.sleep(randomDelay(5000, 15000));
      continue;
    }

    // Pick action based on phase weights
    const action = weightedRandom(
      ["search", "add", "upvote", "veto", "boost", "idle"],
      phase.actionWeights,
    );

    try {
      switch (action) {
        case "search": {
          const song = pickRandom(SONG_CATALOG);
          const res = await api("GET", ("/api/v1/parties/" + (slug) + "/search?q=" + (encodeURIComponent(song.query))), undefined, cookie);
          if (res.status === 200) {
            log({ time: new Date().toISOString(), guest: guest.name, action: "search", detail: (""" + (song.query) + "" → " + (res.json.tracks?.length ?? 0) + " tracks"), status: 200, latencyMs: res.latencyMs });
          } else if (res.status === 429) {
            logError(guest.name, "search", (""" + (song.query) + """), 429, "rate limited");
          } else if (res.status === 503) {
            log({ time: new Date().toISOString(), guest: guest.name, action: "search_fail", detail: (""" + (song.query) + "" → Spotify unavailable"), status: 503 });
          } else {
            logError(guest.name, "search", (""" + (song.query) + """), res.status, res.json?.error ?? "unknown");
          }
          guest.actions++;
          totalActions++;
          break;
        }

        case "add": {
          const song = pickRandom(SONG_CATALOG);
          const fakeUri = ("spotify:track:" + (crypto.randomUUID().slice(0, 22)));
          const res = await api("POST", ("/api/v1/parties/" + (slug) + "/queue"), {
            uri: fakeUri, name: song.name, artistName: song.artist,
          }, cookie);

          if (res.status === 201) {
            guest.addedSongs.push(res.json.id);
            log({ time: new Date().toISOString(), guest: guest.name, action: "add", detail: (""" + (song.name) + """), status: 201 });
          } else if (res.status === 409) {
            log({ time: new Date().toISOString(), guest: guest.name, action: "add_dup", detail: (""" + (song.name) + "" already in queue"), status: 409 });
          } else if (res.status === 429) {
            logError(guest.name, "add", (""" + (song.name) + """), 429, "rate limited");
          } else {
            logError(guest.name, "add", (""" + (song.name) + """), res.status, res.json?.error ?? "unknown");
          }
          guest.actions++;
          totalActions++;
          break;
        }

        case "upvote": {
          const candidates = queueRef.items.filter(
            (i) => i.addedByGuestId !== guest.guestId && !guest.upvotedSongs.includes(i.id),
          );
          if (candidates.length === 0) break;
          const target = pickRandom(candidates);
          const res = await api("POST", ("/api/v1/parties/" + (slug) + "/queue/" + (target.id) + "/upvote"), undefined, cookie);
          if (res.status === 200) {
            guest.upvotedSongs.push(target.id);
            log({ time: new Date().toISOString(), guest: guest.name, action: "upvote", detail: (""" + (target.trackName) + """), status: 200 });
          } else if (res.status === 429) {
            logError(guest.name, "upvote", (""" + (target.trackName) + """), 429, "rate limited");
          } else {
            log({ time: new Date().toISOString(), guest: guest.name, action: "upvote_fail", detail: (""" + (target.trackName) + "" → " + (res.json?.code)), status: res.status });
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
          const res = await api("POST", ("/api/v1/parties/" + (slug) + "/queue/" + (target.id) + "/veto"), undefined, cookie);
          if (res.status === 200) {
            guest.vetoedSongs.push(target.id);
            log({ time: new Date().toISOString(), guest: guest.name, action: "veto", detail: (""" + (target.trackName) + """), status: 200 });
          } else if (res.status === 429) {
            logError(guest.name, "veto", (""" + (target.trackName) + """), 429, "rate limited");
          } else {
            log({ time: new Date().toISOString(), guest: guest.name, action: "veto_fail", detail: (""" + (target.trackName) + "" → " + (res.json?.code)), status: res.status });
          }
          guest.actions++;
          totalActions++;
          break;
        }

        case "boost": {
          if (guest.boostUsed) break;
          const candidates = queueRef.items.filter((i) => i.status === "pending" && !i.isBoosted);
          if (candidates.length === 0) break;
          const target = pickRandom(candidates);
          const res = await api("POST", ("/api/v1/parties/" + (slug) + "/queue/" + (target.id) + "/boost"), undefined, cookie);
          if (res.status === 200) {
            guest.boostUsed = true;
            log({ time: new Date().toISOString(), guest: guest.name, action: "boost", detail: (""" + (target.trackName) + """), status: 200 });
          } else {
            log({ time: new Date().toISOString(), guest: guest.name, action: "boost_fail", detail: (""" + (target.trackName) + "" → " + (res.json?.code)), status: res.status });
          }
          guest.actions++;
          totalActions++;
          break;
        }
      }
    } catch (e) {
      logError(guest.name, "exception", String(e), 0, String(e));
    }

    // Realistic delay between actions (30s-2min depending on phase)
    const baseDelay = phase.name === "Arrival & Setup" ? 15000 : 30000;
    const maxDelay = phase.name === "Arrival & Setup" ? 60000 : 120000;
    await Bun.sleep(randomDelay(baseDelay, maxDelay));
  }
}

// ── Queue poller (keeps shared state fresh) ────────────────────────────────
async function queuePoller(
  config: TestConfig,
  queueRef: { items: any[] },
  shutdown: () => boolean,
): Promise<void> {
  while (!shutdown()) {
    try {
      const res = await api("GET", ("/api/v1/parties/" + (config.partySlug) + "/queue"));
      if (res.status === 200 && res.json) {
        queueRef.items = [...(res.json.upcomingOrder ?? [])];
      }
    } catch {}
    await Bun.sleep(30000); // Poll every 30s
  }
}

// ── Diagnostics monitor ────────────────────────────────────────────────────
async function diagnosticsMonitor(
  config: TestConfig,
  getPhase: () => Phase,
  shutdown: () => boolean,
): Promise<void> {
  while (!shutdown()) {
    try {
      if (config.adminToken) {
        const diagRes = await api("GET", "/api/v1/host/diagnostics", undefined, ("host_session=" + (config.adminToken)));
        if (diagRes.status === 200 && diagRes.json) {
          const d = diagRes.json;
          const entry = {
            timestamp: new Date().toISOString(),
            phase: getPhase().name,
            apiTotal: d.spotifyApi?.total ?? 0,
            apiLast1m: d.spotifyApi?.last1m ?? 0,
            rateLimitCount: d.spotifyApi?.rateLimitCount ?? 0,
            cacheHitRate: d.search?.hitRate ?? 0,
            searchTotal: d.search?.total ?? 0,
            syncActive: d.sync?.deviceActive ?? false,
            syncRateLimited: (d.sync?.retryAfterMs ?? 0) > 0,
          };
          metricsHistory.push(entry);

          log({
            time: entry.timestamp,
            action: "diagnostics",
            detail: ("Phase:" + (entry.phase) + " API:" + (entry.apiTotal) + " (" + (entry.apiLast1m) + "/min) Limits:" + (entry.rateLimitCount) + " Cache:" + ((entry.cacheHitRate * 100).toFixed(0)) + "% Searches:" + (entry.searchTotal) + " Sync:" + (entry.syncActive ? "✓" : "✗")),
          });
        }
      }
    } catch {}
    await Bun.sleep(60000); // Every 60s
  }
}

// ── Summary ────────────────────────────────────────────────────────────────
function printSummary(guests: GuestState[], startTime: number): void {
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log("\n" + "═".repeat(70));
  console.log(("  ENDURANCE TEST v2 SUMMARY — " + (elapsed) + " minutes"));
  console.log("═".repeat(70));
  console.log(("  Total actions: " + (totalActions)));
  console.log(("  Total errors: " + (totalErrors)));
  console.log(("  Total 429s: " + (total429s)));
  console.log(("  Guests: " + (guests.length) + " (" + (guests.filter(g => g.joined).length) + " joined)"));
  console.log();

  console.log("  Per-guest breakdown:");
  for (const g of guests) {
    const status = g.joined ? "✓" : "✗";
    console.log(("    " + (status) + " " + (g.name.padEnd(12)) + " actions=" + (String(g.actions).padStart(4)) + "  added=" + (String(g.addedSongs.length).padStart(3)) + "  upvoted=" + (String(g.upvotedSongs.length).padStart(3)) + "  boosted=" + (g.boostUsed ? "yes" : "no")));
  }

  if (metricsHistory.length > 0) {
    console.log();
    console.log("  API metrics timeline (last 10):");
    for (const m of metricsHistory.slice(-10)) {
      console.log(("    " + (m.timestamp.slice(11, 19)) + " [" + (m.phase.slice(0, 8).padEnd(8)) + "] API=" + (String(m.apiTotal).padStart(5)) + " (" + (String(m.apiLast1m).padStart(2)) + "/min) Limits=" + (String(m.rateLimitCount).padStart(3)) + " Cache=" + ((m.cacheHitRate * 100).toFixed(0).padStart(3)) + "%"));
    }
  }

  const errs429 = logs.filter((l) => l.status === 429);
  if (errs429.length > 0) {
    console.log();
    console.log(("  429 breakdown (" + (errs429.length) + " total):"));
    const byAction = new Map<string, number>();
    for (const e of errs429) byAction.set(e.action, (byAction.get(e.action) ?? 0) + 1);
    for (const [action, count] of byAction) console.log(("    " + (action) + ": " + (count)));
  }

  console.log("═".repeat(70));
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const slugIdx = args.indexOf("--slug");
  const guestsIdx = args.indexOf("--guests");
  const adminIdx = args.indexOf("--admin-token");

  if (slugIdx === -1 || !args[slugIdx + 1]) {
    console.error("Usage: bun run scripts/endurance-v2.ts --slug <party-slug> [--guests 30] [--admin-token <token>]");
    process.exit(1);
  }

  const config: TestConfig = {
    baseUrl: "https://jukebox.REDACTED.example.com",
    partySlug: args[slugIdx + 1]!,
    guestCount: guestsIdx !== -1 ? parseInt(args[guestsIdx + 1]!) : 30,
    adminToken: adminIdx !== -1 ? args[adminIdx + 1]! : null,
  };

  const startTime = Date.now();
  let shutdown = false;
  let currentPhaseIdx = 0;

  const totalDuration = PHASES.reduce((s, p) => s + p.durationMs, 0);

  console.log("═".repeat(70));
  console.log("  JUKEBOX ENDURANCE TEST v2 — Realistic Party Arc");
  console.log("═".repeat(70));
  console.log(("  Party: " + (config.partySlug)));
  console.log(("  Guests: " + (config.guestCount)));
  console.log(("  Duration: " + (totalDuration / 60000) + " min (" + ((totalDuration / 3600000).toFixed(1)) + "h)"));
  console.log(("  Phases: " + (PHASES.map((p) => "${p.name) + " (" + (p.durationMs / 60000) + "min)")).join(" → ")}`);
  console.log("═".repeat(70));
  console.log();

  // Verify party
  const partyRes = await api("GET", ("/api/v1/parties/" + (config.partySlug)));
  if (partyRes.status !== 200 || partyRes.json.status !== "on") {
    console.error(("Party not ready: " + (JSON.stringify(partyRes.json))));
    process.exit(1);
  }
  console.log(("✓ Party "" + (partyRes.json.name) + "" is on\n"));

  const queueRef: { items: any[] } = { items: [] };
  const guestNames = GUEST_NAMES.slice(0, config.guestCount);
  const guests: GuestState[] = guestNames.map((name) => ({
    name, token: null, guestId: null, boostUsed: false,
    addedSongs: [], upvotedSongs: [], vetoedSongs: [],
    actions: 0, joined: false,
  }));

  // Stagger guest arrivals: 1 every ~2min over first hour
  const arrivalInterval = (60 * 60 * 1000) / config.guestCount;

  const getPhase = () => PHASES[currentPhaseIdx]!;

  // Start monitors
  const queuePromise = queuePoller(config, queueRef, () => shutdown);
  const diagPromise = diagnosticsMonitor(config, getPhase, () => shutdown);

  // Launch guests with staggered arrivals
  const guestPromises: Promise<void>[] = [];
  for (let i = 0; i < guests.length; i++) {
    if (i > 0) {
      const delay = randomDelay(arrivalInterval * 0.5, arrivalInterval * 1.5);
      await Bun.sleep(delay);
    }
    if (shutdown) break;
    guestPromises.push(guestLoop(config, guests[i], queueRef, getPhase, () => shutdown));
  }

  console.log(("🚀 All " + (guests.length) + " guests launched with staggered arrivals.\n"));

  // Phase transition timer
  let phaseElapsed = 0;
  const phaseTimer = setInterval(() => {
    phaseElapsed += 30000; // Check every 30s
    const totalElapsed = Date.now() - startTime;
    let accumulated = 0;
    for (let i = 0; i < PHASES.length; i++) {
      accumulated += PHASES[i]!.durationMs;
      if (totalElapsed < accumulated) {
        if (currentPhaseIdx !== i) {
          currentPhaseIdx = i;
          console.log(("\n🔄 PHASE CHANGE: → " + (PHASES[i]!.name) + " (" + (PHASES[i]!.durationMs / 60000) + "min)\n"));
        }
        break;
      }
    }
  }, 30000);

  // Status reports every 10 min
  const statusTimer = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    const joined = guests.filter((g) => g.joined).length;
    console.log(("\n⏱️  [" + (elapsed) + "min] Phase: " + (getPhase().name) + " | Joined: " + (joined) + "/" + (guests.length) + " | Actions: " + (totalActions) + " | Errors: " + (totalErrors) + " | 429s: " + (total429s) + "\n"));
  }, 10 * 60 * 1000);

  // Wait for total duration
  await Bun.sleep(totalDuration);
  shutdown = true;

  clearInterval(phaseTimer);
  clearInterval(statusTimer);

  await Promise.allSettled(guestPromises);
  await Promise.allSettled([queuePromise, diagPromise]);

  printSummary(guests, startTime);

  // Save report
  const { writeFileSync, mkdirSync } = await import("fs");
  mkdirSync("./data", { recursive: true });
  const logPath = ("./data/endurance-v2-" + (Date.now()) + ".json");
  writeFileSync(logPath, JSON.stringify({
    config, startTime: new Date(startTime).toISOString(), endTime: new Date().toISOString(),
    summary: { totalActions, totalErrors, total429s, guests: guests.map((g) => ({
      name: g.name, actions: g.actions, added: g.addedSongs.length, upvoted: g.upvotedSongs.length, boosted: g.boostUsed,
    }))},
    metrics: metricsHistory,
    phases: PHASES.map((p) => ({ name: p.name, durationMin: p.durationMs / 60000 })),
    logs: logs.slice(-300),
  }, null, 2));
  console.log(("\n📄 Report saved to " + (logPath)));
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
