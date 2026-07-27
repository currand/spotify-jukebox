#!/usr/bin/env bun
/**
 * Jukebox endurance test — phased party simulation with joins spread over an hour.
 *
 * Usage:
 *   bun run endurance --slug <party-slug> [--guests 30] [--admin-token <host_session>]
 *
 * Mock stack:
 *   JUKEBOX_BASE_URL=http://127.0.0.1:3000 bun run endurance --slug my-party --admin-token <token>
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolveJukeboxBaseUrl } from "./lib/endurance-base-url.ts";
import {
  createApiClient,
  guestDisplayName,
  randomDelay,
} from "./lib/endurance-api.ts";
import {
  ENDURANCE_PHASES,
  ENDURANCE_TOTAL_MS,
  getPhaseAtElapsed,
} from "./lib/endurance-phases.ts";
import {
  createGuestState,
  joinGuest,
  refreshQueue,
  runGuestLoop,
  type GuestState,
  type LogEntry,
  type QueueItemRef,
  type SavedGuest,
} from "./lib/endurance-guest.ts";

interface EnduranceConfig {
  baseUrl: string;
  partySlug: string;
  guestCount: number;
  joinWindowMin: number;
  adminToken: string | null;
  guestsFile: string | null;
  cacheStress: boolean;
}

interface DiagnosticsSample {
  timestamp: string;
  phase: string;
  apiTotal: number;
  rateLimitCount: number;
  cacheHitRate: number;
  searchTotal: number;
  syncRetryAfterMs: number | null;
  byCallerLast5m: Record<string, number>;
  firstRateLimit: {
    outboundCallIndex: number;
    caller: string;
    path: string;
    retryAfterMs: number;
    at: number;
  } | null;
}

interface FirstBlockReport {
  outboundCallIndex: number;
  caller: string;
  path: string;
  retryAfterMs: number;
  elapsedMs: number;
  detectedAt: string;
}

const logs: LogEntry[] = [];
const diagnosticsSeries: DiagnosticsSample[] = [];
let totalActions = 0;
let totalErrors = 0;
let total429s = 0;
let firstBlock: FirstBlockReport | null = null;

function log(entry: LogEntry): void {
  logs.push(entry);
  const ts = entry.time.slice(11, 19);
  const guest = entry.guest ? `[${entry.guest}]` : "[SYS]";
  const status = entry.status ? ` → ${entry.status}` : "";
  const err = entry.error ? ` ERR: ${entry.error}` : "";
  console.log(`${ts} ${guest} ${entry.action} ${entry.detail}${status}${err}`);
}

function parseArgs(argv: string[]): EnduranceConfig {
  const get = (flag: string) => {
    const idx = argv.indexOf(flag);
    return idx !== -1 ? argv[idx + 1] : undefined;
  };

  const slug = get("--slug");
  if (!slug) {
    console.error(`Usage: bun run endurance --slug <party-slug> [options]

Options:
  --guests N              Guest count (default 30, max 50)
  --join-window-min N     Spread joins over N minutes (default 60)
  --admin-token TOKEN     Host session cookie value for diagnostics
  --base-url URL          Jukebox base URL (or JUKEBOX_BASE_URL env)
  --guests-file PATH      Reuse saved guest cookies from join-guests.ts
  --cache-stress          Use 40% random search queries (cache miss stress)`);
    process.exit(1);
  }

  const guestCount = Math.min(50, Math.max(1, Number(get("--guests") ?? 30)));
  return {
    baseUrl: resolveJukeboxBaseUrl(get("--base-url")),
    partySlug: slug,
    guestCount,
    joinWindowMin: Math.max(1, Number(get("--join-window-min") ?? 60)),
    adminToken: get("--admin-token") ?? null,
    guestsFile: get("--guests-file") ?? null,
    cacheStress: argv.includes("--cache-stress"),
  };
}

function loadSavedGuests(path: string | null, slug: string): SavedGuest[] {
  const file = path ?? `./data/guests-${slug}.json`;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SavedGuest[];
  } catch {
    return [];
  }
}

function maybeCaptureFirstBlock(
  sample: DiagnosticsSample,
  testStartMs: number,
): void {
  if (firstBlock || !sample.firstRateLimit) return;
  firstBlock = {
    outboundCallIndex: sample.firstRateLimit.outboundCallIndex,
    caller: sample.firstRateLimit.caller,
    path: sample.firstRateLimit.path,
    retryAfterMs: sample.firstRateLimit.retryAfterMs,
    elapsedMs: sample.firstRateLimit.at - testStartMs,
    detectedAt: sample.timestamp,
  };
  log({
    time: sample.timestamp,
    action: "first_block",
    detail: `outbound call #${firstBlock.outboundCallIndex} caller=${firstBlock.caller} retryAfter=${Math.round(firstBlock.retryAfterMs / 1000)}s`,
  });
}

async function diagnosticsLoop(
  config: EnduranceConfig,
  api: ReturnType<typeof createApiClient>,
  testStartMs: number,
  shutdown: () => boolean,
): Promise<void> {
  while (!shutdown()) {
    if (config.adminToken) {
      try {
        const diagRes = await api(
          "GET",
          "/api/v1/host/diagnostics",
          undefined,
          `host_session=${config.adminToken}`,
        );
        if (diagRes.status === 200 && diagRes.json) {
          const d = diagRes.json;
          const elapsed = Date.now() - testStartMs;
          const sample: DiagnosticsSample = {
            timestamp: new Date().toISOString(),
            phase: getPhaseAtElapsed(elapsed).name,
            apiTotal: d.spotifyApi?.total ?? 0,
            rateLimitCount: d.spotifyApi?.rateLimitCount ?? 0,
            cacheHitRate: d.search?.hitRate ?? 0,
            searchTotal: d.search?.total ?? 0,
            syncRetryAfterMs: d.sync?.retryAfterMs ?? null,
            byCallerLast5m: d.spotifyApi?.byCallerLast5m ?? {},
            firstRateLimit: d.spotifyApi?.firstRateLimit ?? null,
          };
          diagnosticsSeries.push(sample);
          maybeCaptureFirstBlock(sample, testStartMs);

          const callers = Object.entries(sample.byCallerLast5m)
            .map(([name, count]) => `${name}:${count}`)
            .join(" ");
          log({
            time: sample.timestamp,
            action: "diagnostics",
            detail: `API:${sample.apiTotal} Limits:${sample.rateLimitCount} Cache:${(sample.cacheHitRate * 100).toFixed(0)}%${callers ? ` Callers[${callers}]` : ""}${sample.syncRetryAfterMs ? ` SyncBackoff:${Math.round(sample.syncRetryAfterMs / 1000)}s` : ""}`,
          });
        }
      } catch (e) {
        log({
          time: new Date().toISOString(),
          action: "diag_error",
          detail: String(e),
        });
      }
    }
    await Bun.sleep(10_000);
  }
}

async function queuePoller(
  config: EnduranceConfig,
  api: ReturnType<typeof createApiClient>,
  queueRef: { items: QueueItemRef[] },
  shutdown: () => boolean,
): Promise<void> {
  while (!shutdown()) {
    try {
      const res = await api("GET", `/api/v1/parties/${config.partySlug}/queue`);
      if (res.status === 200 && res.json) {
        queueRef.items = [...(res.json.upcomingOrder ?? [])];
      }
    } catch {
      // ignore
    }
    await Bun.sleep(30_000);
  }
}

async function fetchMetricsCrossCheck(
  config: EnduranceConfig,
  api: ReturnType<typeof createApiClient>,
): Promise<{ sessionId: string | null; firstRateLimitApiTotal: number | null }> {
  if (!config.adminToken) return { sessionId: null, firstRateLimitApiTotal: null };

  const sessionsRes = await api(
    "GET",
    "/api/v1/host/metrics/sessions",
    undefined,
    `host_session=${config.adminToken}`,
  );
  if (sessionsRes.status !== 200) {
    return { sessionId: null, firstRateLimitApiTotal: null };
  }

  const current = (sessionsRes.json.sessions as { id: string; isCurrent: boolean }[]).find(
    (s) => s.isCurrent,
  );
  if (!current) return { sessionId: null, firstRateLimitApiTotal: null };

  const snapshotsRes = await api(
    "GET",
    `/api/v1/host/metrics/sessions/${current.id}/snapshots?reason=rate_limit&limit=50`,
    undefined,
    `host_session=${config.adminToken}`,
  );
  if (snapshotsRes.status !== 200 || !snapshotsRes.json.snapshots?.length) {
    return { sessionId: current.id, firstRateLimitApiTotal: null };
  }

  const snapshots = snapshotsRes.json.snapshots as {
    recordedAt: string;
    apiCallsTotal: number;
  }[];
  snapshots.sort(
    (a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime(),
  );
  return {
    sessionId: current.id,
    firstRateLimitApiTotal: snapshots[0]?.apiCallsTotal ?? null,
  };
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const api = createApiClient(config.baseUrl);
  const testStartMs = Date.now();
  let shutdown = false;

  const savedGuests = loadSavedGuests(config.guestsFile, config.partySlug);
  if (savedGuests.length > 0) {
    console.log(`Loaded ${savedGuests.length} saved guest sessions`);
  }

  console.log("═".repeat(70));
  console.log("  JUKEBOX ENDURANCE TEST");
  console.log("═".repeat(70));
  console.log(`  Base URL:     ${config.baseUrl}`);
  console.log(`  Party:        ${config.partySlug}`);
  console.log(`  Guests:       ${config.guestCount}`);
  console.log(`  Join window:  ${config.joinWindowMin} min`);
  console.log(`  Duration:     ${(ENDURANCE_TOTAL_MS / 60_000).toFixed(0)} min (phased)`);
  console.log(`  Cache stress: ${config.cacheStress ? "yes" : "no"}`);
  console.log(`  Diagnostics:  ${config.adminToken ? "yes" : "no (--admin-token required)"}`);
  console.log("═".repeat(70));
  console.log();

  const partyRes = await api("GET", `/api/v1/parties/${config.partySlug}`);
  if (partyRes.status !== 200) {
    console.error(`Party not found: ${partyRes.status}`);
    process.exit(1);
  }
  if (partyRes.json.status !== "on") {
    console.error(`Party must be "on" (current: ${partyRes.json.status})`);
    process.exit(1);
  }
  console.log(`Party "${partyRes.json.name}" is on\n`);

  const queueRef: { items: QueueItemRef[] } = { items: [] };
  const guests: GuestState[] = Array.from({ length: config.guestCount }, (_, i) =>
    createGuestState(guestDisplayName(i)),
  );

  const guestCtxBase = {
    slug: config.partySlug,
    cacheStress: config.cacheStress,
    testStartMs,
    api,
    queueRef,
    shutdown: () => shutdown,
    onAction: () => {
      totalActions++;
    },
    onError: (status: number) => {
      totalErrors++;
      if (status === 429) total429s++;
    },
    log,
  };

  const diagPromise = diagnosticsLoop(config, api, testStartMs, () => shutdown);
  const queuePromise = queuePoller(config, api, queueRef, () => shutdown);

  const joinWindowMs = config.joinWindowMin * 60_000;
  const arrivalInterval = joinWindowMs / config.guestCount;
  const guestPromises: Promise<void>[] = [];

  let currentPhaseIdx = 0;
  const phaseTimer = setInterval(() => {
    const elapsed = Date.now() - testStartMs;
    const phase = getPhaseAtElapsed(elapsed);
    const idx = ENDURANCE_PHASES.findIndex((p) => p.name === phase.name);
    if (idx !== currentPhaseIdx) {
      currentPhaseIdx = idx;
      console.log(`\nPHASE → ${phase.name}\n`);
    }
  }, 30_000);

  const statusTimer = setInterval(() => {
    const elapsedMin = ((Date.now() - testStartMs) / 60_000).toFixed(1);
    const joined = guests.filter((g) => g.joined).length;
    const phase = getPhaseAtElapsed(Date.now() - testStartMs).name;
    console.log(
      `\n[${elapsedMin}min] Phase: ${phase} | Joined: ${joined}/${guests.length} | Actions: ${totalActions} | 429s: ${total429s}\n`,
    );
  }, 10 * 60_000);

  for (let i = 0; i < guests.length; i++) {
    if (i > 0) {
      await Bun.sleep(randomDelay(arrivalInterval * 0.75, arrivalInterval * 1.25));
    }
    if (shutdown) break;

    const guest = guests[i]!;
    const saved = savedGuests.find((s) => s.name === guest.name);
    guestPromises.push(
      (async () => {
        const cookie = await joinGuest(guestCtxBase, guest, saved);
        if (!cookie) return;
        await refreshQueue(guestCtxBase, cookie);
        await runGuestLoop(guestCtxBase, guest, cookie);
      })(),
    );
  }

  console.log(`\nLaunched ${guests.length} guests over ~${config.joinWindowMin} min\n`);
  console.log(
    `Phases: ${ENDURANCE_PHASES.map((p) => `${p.name} (${p.durationMs / 60_000}min)`).join(" → ")}\n`,
  );

  await Bun.sleep(ENDURANCE_TOTAL_MS);
  shutdown = true;

  clearInterval(phaseTimer);
  clearInterval(statusTimer);

  await Promise.allSettled(guestPromises);
  await Promise.allSettled([diagPromise, queuePromise]);

  const metricsCrossCheck = await fetchMetricsCrossCheck(config, api);
  const finalDiag =
    diagnosticsSeries.length > 0
      ? diagnosticsSeries[diagnosticsSeries.length - 1]
      : null;

  const report = {
    config,
    startTime: new Date(testStartMs).toISOString(),
    endTime: new Date().toISOString(),
    phases: ENDURANCE_PHASES.map((p) => ({
      name: p.name,
      durationMin: p.durationMs / 60_000,
    })),
    summary: {
      totalActions,
      totalErrors,
      total429s,
      guestsJoined: guests.filter((g) => g.joined).length,
    },
    firstBlock,
    metricsCrossCheck,
    finalDiagnostics: finalDiag,
    diagnosticsSeries,
    guests: guests.map((g) => ({
      name: g.name,
      joined: g.joined,
      actions: g.actions,
      errors: g.errors,
      added: g.addedSongs.length,
      upvoted: g.upvotedSongs.length,
      boosted: g.boostUsed,
    })),
    logs: logs.slice(-300),
  };

  mkdirSync("./data", { recursive: true });
  const reportPath = `./data/endurance-${Date.now()}.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("\n" + "═".repeat(70));
  console.log("  ENDURANCE SUMMARY");
  console.log("═".repeat(70));
  console.log(`  Actions: ${totalActions} | Errors: ${totalErrors} | Guest 429s: ${total429s}`);
  if (firstBlock) {
    const elapsedMin = (firstBlock.elapsedMs / 60_000).toFixed(1);
    console.log(
      `  FIRST_RATE_LIMIT at outbound call #${firstBlock.outboundCallIndex} (caller=${firstBlock.caller}, retryAfter=${Math.round(firstBlock.retryAfterMs / 1000)}s, elapsed=${elapsedMin}min)`,
    );
    if (metricsCrossCheck.firstRateLimitApiTotal != null) {
      console.log(
        `  Metrics cross-check: first rate_limit snapshot apiCallsTotal=${metricsCrossCheck.firstRateLimitApiTotal}`,
      );
    }
  } else {
    console.log("  No outbound Spotify 429 observed during this run.");
  }
  console.log(`  Report: ${reportPath}`);
  console.log("═".repeat(70));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
