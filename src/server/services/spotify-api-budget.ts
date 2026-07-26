/** Conservative global outbound Spotify API budget — below ~200-call burst ceiling. */
export const SPOTIFY_API_BUDGET = { count: 90, windowMs: 30_000 };

let bucket = { count: 0, resetAt: 0 };
let nowMs = () => Date.now();

export function resetSpotifyApiBudgetForTests(): void {
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
      bucket = { count: 0, resetAt: now + SPOTIFY_API_BUDGET.windowMs };
    }
    if (bucket.count < SPOTIFY_API_BUDGET.count) {
      bucket.count += 1;
      return;
    }
    const waitMs = Math.max(1, bucket.resetAt - now);
    options?.onWait?.(waitMs);
    await sleep(waitMs);
  }
}

/** @internal test helper */
export function getSpotifyApiBudgetSnapshotForTests(): {
  count: number;
  resetAt: number;
} {
  return { ...bucket };
}
