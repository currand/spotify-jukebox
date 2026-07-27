/** Conservative global outbound Spotify API budget — below ~200-call burst ceiling. */
export const DEFAULT_SPOTIFY_API_BUDGET = { count: 90, windowMs: 30_000 };

let budget = { ...DEFAULT_SPOTIFY_API_BUDGET };
let bucket = { count: 0, resetAt: 0 };
let nowMs = () => Date.now();

export function initSpotifyApiBudget(options: {
  count: number;
  windowMs: number;
}): void {
  budget = {
    count: Math.max(1, options.count),
    windowMs: Math.max(1000, options.windowMs),
  };
  bucket = { count: 0, resetAt: 0 };
}

/** @deprecated use initSpotifyApiBudget — kept for tests importing the constant */
export const SPOTIFY_API_BUDGET = DEFAULT_SPOTIFY_API_BUDGET;

export function resetSpotifyApiBudgetForTests(): void {
  budget = { ...DEFAULT_SPOTIFY_API_BUDGET };
  bucket = { count: 0, resetAt: 0 };
  nowMs = () => Date.now();
}

/** @internal test helper */
export function setSpotifyApiBudgetClockForTests(clock: () => number): void {
  nowMs = clock;
}

/** Wait until a slot is available, then consume one call from the budget. */
export async function acquireSpotifyApiBudgetSlot(options?: {
  sleep?: (ms: number) => Promise<void>;
  onWait?: (waitMs: number) => void;
}): Promise<void> {
  const sleep =
    options?.sleep ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  while (true) {
    const now = nowMs();
    if (now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + budget.windowMs };
    }
    if (bucket.count < budget.count) {
      bucket.count += 1;
      return;
    }
    const waitMs = Math.max(1, bucket.resetAt - now);
    options?.onWait?.(waitMs);
    await sleep(waitMs);
  }
}

export function getSpotifyApiBudgetSnapshot(): {
  used: number;
  limit: number;
  windowMs: number;
  resetsInMs: number;
} {
  const now = nowMs();
  if (now >= bucket.resetAt) {
    return {
      used: 0,
      limit: budget.count,
      windowMs: budget.windowMs,
      resetsInMs: budget.windowMs,
    };
  }
  return {
    used: bucket.count,
    limit: budget.count,
    windowMs: budget.windowMs,
    resetsInMs: Math.max(0, bucket.resetAt - now),
  };
}

/** @internal test helper */
export function getSpotifyApiBudgetSnapshotForTests(): {
  count: number;
  resetAt: number;
} {
  return { ...bucket };
}
