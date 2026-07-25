#!/usr/bin/env bun
/**
 * Spotify Rate Limit Load Tester
 * 
 * Deliberately hammers the Spotify API to observe rate limit escalation.
 * WILL block your API access — use intentionally.
 * 
 * Usage:
 *   bun run scripts/spotify-rate-limit-test.ts
 *   bun run scripts/spotify-rate-limit-test.ts --phase 2    # Start at phase 2
 *   bun run scripts/spotify-rate-limit-test.ts --rps 10     # Fixed 10 req/s
 * 
 * Phases (default):
 *   1: 2 req/s for 60s    (gentle)
 *   2: 5 req/s for 60s    (moderate)
 *   3: 15 req/s for 60s   (aggressive)
 *   4: 50 req/s for 60s   (spam)
 *   5: unlimited for 120s  (maximum overdrive)
 * 
 * Press Ctrl+C to stop early and get a summary.
 */

interface RequestResult {
  timestamp: number;
  status: number;
  retryAfter: string | null;
  retryAfterParsed: number | null;
  error: string | null;
  elapsed: number;
}

const BASE_URL = "https://api.spotify.com/v1";

// --- Token acquisition ---
async function getAccessToken(): Promise<string> {
  // Read from the container's database
  const proc = Bun.spawn(
    ["docker", "exec", "jukebox-jukebox-1", "bun", "-e", `
      import Database from "bun:sqlite";
      const db = new Database("/data/jukebox.db", { readonly: true });
      const row = db.query("SELECT access_token FROM host_credentials WHERE id = 1").get();
      if (!row) { console.error("NO_CREDS"); process.exit(1); }
      // Token is encrypted — we need the key
      console.log(row.access_token);
    `],
    { stdout: "pipe", stderr: "pipe" }
  );
  
  const encrypted = (await new Response(proc.stdout).text()).trim();
  if (!encrypted || encrypted.includes("NO_CREDS")) {
    throw new Error("No Spotify credentials found in the container");
  }
  
  // Decrypt using the container's ENCRYPTION_KEY
  const decryptProc = Bun.spawn(
    ["docker", "exec", "jukebox-jukebox-1", "bun", "-e", `
      const crypto = require("crypto");
      const key = process.env.ENCRYPTION_KEY;
      if (!key) { console.error("NO_KEY"); process.exit(1); }
      
      const parts = Buffer.from("${encrypted.replace(/"/g, '\\"')}", "base64").toString().split(":");
      const iv = Buffer.from(parts[0], "hex");
      const authTag = Buffer.from(parts[parts.length - 1], "hex");
      const data = Buffer.from(parts.slice(1, -1).join(":"), "hex");
      
      const decipher = crypto.createDecipheriv("aes-256-gcm", crypto.createHash("sha256").update(key).digest(), iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString();
      console.log(decrypted);
    `],
    { stdout: "pipe", stderr: "pipe" }
  );
  
  const token = (await new Response(decryptProc.stdout).text()).trim();
  if (!token) throw new Error("Failed to decrypt access token");
  return token;
}

// Simpler approach: hit the jukebox API through the tunnel and extract from there
async function getTokenViaJukebox(): Promise<string> {
  // Actually, let's just use the container's env to make the requests directly
  // even simpler: read the token by running spotify.getAccessToken() inside the container
  const proc = Bun.spawn(
    ["docker", "exec", "jukebox-jukebox-1", "bun", "-e", `
      import { loadConfig } from "./dist/server/config.js";
      import { bootstrapEnv } from "./dist/server/load-env.js";
      import { initDb } from "./dist/server/db/schema.js";
      import { createSpotifyClient } from "./dist/server/services/spotify.js";
      
      const env = bootstrapEnv();
      const config = loadConfig(env);
      const db = initDb(config);
      const spotify = createSpotifyClient(db, config);
      
      const token = await spotify.getAccessToken();
      if (token) {
        console.log("TOKEN:" + token);
      } else {
        console.log("NO_TOKEN");
      }
    `],
    { stdout: "pipe", stderr: "pipe" }
  );
  
  const output = await new Response(proc.stdout).text();
  const match = output.match(/TOKEN:(.+)/);
  if (!match) throw new Error("Could not get access token from Jukebox");
  return match[1].trim();
}

// --- Phase definitions ---
interface Phase {
  name: string;
  rps: number;       // requests per second (0 = unlimited)
  duration: number;   // seconds
  endpoints: string[];
}

const PHASES: Phase[] = [
  {
    name: "Gentle",
    rps: 2,
    duration: 60,
    endpoints: ["/me/player", "/me/player/currently-playing"],
  },
  {
    name: "Moderate",
    rps: 5,
    duration: 60,
    endpoints: ["/me/player", "/me/player/currently-playing", "/me/player/queue"],
  },
  {
    name: "Aggressive",
    rps: 15,
    duration: 60,
    endpoints: ["/me/player", "/me/player/currently-playing", "/me/player/queue", "/search?q=test&type=track"],
  },
  {
    name: "Spam",
    rps: 50,
    duration: 60,
    endpoints: ["/me/player", "/search?q=test&type=track", "/me/player/queue"],
  },
  {
    name: "Maximum Overdrive",
    rps: 0,  // unlimited
    duration: 120,
    endpoints: ["/me/player", "/search?q=test&type=track"],
  },
];

// --- Core load tester ---
class RateLimitTester {
  private token: string;
  private results: RequestResult[] = [];
  private abort = false;
  private activeRequests = 0;
  private maxConcurrent = 0;

  constructor(token: string) {
    this.token = token;
  }

  async makeRequest(endpoint: string): Promise<RequestResult> {
    const start = performance.now();
    this.activeRequests++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.activeRequests);

    try {
      const res = await fetch(`${BASE_URL}${endpoint}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });

      const elapsed = performance.now() - start;
      const retryAfter = res.headers.get("retry-after");
      let retryAfterParsed: number | null = null;
      if (retryAfter) {
        retryAfterParsed = Number(retryAfter);
        if (Number.isNaN(retryAfterParsed)) retryAfterParsed = null;
      }

      let error: string | null = null;
      if (!res.ok && res.status !== 204) {
        try {
          const body = await res.text();
          error = body.slice(0, 200);
        } catch {}
      }

      return {
        timestamp: Date.now(),
        status: res.status,
        retryAfter,
        retryAfterParsed,
        error,
        elapsed,
      };
    } catch (e) {
      return {
        timestamp: Date.now(),
        status: 0,
        retryAfter: null,
        retryAfterParsed: null,
        error: e instanceof Error ? e.message : String(e),
        elapsed: performance.now() - start,
      };
    } finally {
      this.activeRequests--;
    }
  }

  async runPhase(phase: Phase, phaseNum: number): Promise<void> {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`PHASE ${phaseNum}: ${phase.name}`);
    console.log(`  RPS: ${phase.rps || "unlimited"} | Duration: ${phase.duration}s`);
    console.log(`  Endpoints: ${phase.endpoints.join(", ")}`);
    console.log(`${"=".repeat(60)}`);

    const deadline = Date.now() + phase.duration * 1000;
    const interval = phase.rps > 0 ? 1000 / phase.rps : 0;
    let lastLog = 0;

    if (interval > 0) {
      // Fixed rate
      while (Date.now() < deadline && !this.abort) {
        const endpoint = phase.endpoints[Math.floor(Math.random() * phase.endpoints.length)];
        this.makeRequest(endpoint).then((r) => {
          this.results.push(r);
          this.printResult(r);
        });
        await Bun.sleep(interval);
      }
    } else {
      // Unlimited — fire as fast as possible
      while (Date.now() < deadline && !this.abort) {
        const endpoint = phase.endpoints[Math.floor(Math.random() * phase.endpoints.length)];
        this.makeRequest(endpoint).then((r) => {
          this.results.push(r);
          this.printResult(r);
        });
        // Don't wait
      }
    }

    // Wait for in-flight requests
    while (this.activeRequests > 0) {
      await Bun.sleep(100);
    }
  }

  printResult(r: RequestResult) {
    const time = new Date(r.timestamp).toISOString().slice(11, 23);
    const status = r.status === 0 ? "ERR" : String(r.status);
    const color = r.status === 429 ? "\x1b[31m" : r.status >= 200 && r.status < 300 ? "\x1b[32m" : "\x1b[33m";
    const reset = "\x1b[0m";
    
    let suffix = "";
    if (r.retryAfterParsed != null) {
      const mins = Math.floor(r.retryAfterParsed / 60);
      const secs = r.retryAfterParsed % 60;
      suffix = ` ⏰ Retry-After: ${r.retryAfterParsed}s (${mins}m${secs}s)`;
    }
    if (r.error) {
      const brief = r.error.includes("QUOTA_EXCEEDED") ? "QUOTA_EXCEEDED" 
        : r.error.includes("Too many requests") ? "Too many requests"
        : r.error.slice(0, 80);
      suffix += ` | ${brief}`;
    }
    
    process.stdout.write(`${color}${time} [${status}] ${r.elapsed.toFixed(0)}ms${reset}${suffix}\n`);
  }

  printSummary() {
    const total = this.results.length;
    const byStatus = new Map<number, number>();
    let maxRetryAfter = 0;

    for (const r of this.results) {
      byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1);
      if (r.retryAfterParsed && r.retryAfterParsed > maxRetryAfter) {
        maxRetryAfter = r.retryAfterParsed;
      }
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log("SUMMARY");
    console.log(`${"=".repeat(60)}`);
    console.log(`Total requests: ${total}`);
    console.log(`Max concurrent: ${this.maxConcurrent}`);
    console.log(`Status codes:`);
    for (const [status, count] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
      const pct = ((count / total) * 100).toFixed(1);
      const bar = "█".repeat(Math.min(40, Math.round(count / total * 40)));
      const label = status === 429 ? " (RATE LIMITED)" : status === 0 ? " (ERROR)" : "";
      console.log(`  ${String(status).padStart(4)}: ${String(count).padStart(6)} (${pct.padStart(5)}%) ${bar}${label}`);
    }
    console.log(`Max Retry-After seen: ${maxRetryAfter}s (${(maxRetryAfter / 60).toFixed(1)} min)`);
    console.log(`${"=".repeat(60)}\n`);
  }

  stop() {
    this.abort = true;
  }
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  const phaseArg = args.indexOf("--phase");
  const startPhase = phaseArg >= 0 ? parseInt(args[phaseArg + 1]) : 1;
  const rpsArg = args.indexOf("--rps");
  const fixedRps = rpsArg >= 0 ? parseInt(args[rpsArg + 1]) : null;

  console.log("🎵 Spotify Rate Limit Load Tester");
  console.log("⚠️  This will deliberately rate-limit your Spotify API access.\n");

  console.log("Fetching access token from Jukebox container...");
  const token = await getTokenViaJukebox();
  console.log(`✅ Got token (${token.slice(0, 10)}...)\n`);

  const tester = new RateLimitTester(token);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n\n🛑 Stopping test...");
    tester.stop();
  });

  // Run phases
  if (fixedRps !== null) {
    const endpoints = ["/me/player", "/me/player/currently-playing", "/search?q=test&type=track"];
    const customPhase: Phase = {
      name: `Fixed ${fixedRps} RPS`,
      rps: fixedRps,
      duration: 120,
      endpoints,
    };
    await tester.runPhase(customPhase, 0);
  } else {
    for (let i = startPhase - 1; i < PHASES.length; i++) {
      if (tester["abort"]) break;
      await tester.runPhase(PHASES[i], i + 1);
    }
  }

  tester.printSummary();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
