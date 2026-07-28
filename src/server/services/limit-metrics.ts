export type LimitHitKind =
  | "guest_add"
  | "guest_upvote"
  | "guest_downvote"
  | "guest_boost"
  | "guest_search"
  | "party_search";

interface LimitHit {
  at: number;
  kind: LimitHitKind;
}

const LIMIT_HIT_LOG_LIMIT = 500;
const limitHitLog: LimitHit[] = [];
const limitHitTotals = new Map<LimitHitKind, number>();

export function recordLimitHit(kind: LimitHitKind): void {
  limitHitTotals.set(kind, (limitHitTotals.get(kind) ?? 0) + 1);
  limitHitLog.push({ at: Date.now(), kind });
  if (limitHitLog.length > LIMIT_HIT_LOG_LIMIT) {
    limitHitLog.splice(0, limitHitLog.length - LIMIT_HIT_LOG_LIMIT);
  }
}

function countHitsSince(sinceMs: number): number {
  const cutoff = Date.now() - sinceMs;
  return limitHitLog.filter((hit) => hit.at >= cutoff).length;
}

function countHitsByKindSince(sinceMs: number): Record<string, number> {
  const cutoff = Date.now() - sinceMs;
  const counts: Record<string, number> = {};
  for (const hit of limitHitLog) {
    if (hit.at < cutoff) continue;
    counts[hit.kind] = (counts[hit.kind] ?? 0) + 1;
  }
  return counts;
}

export function getLimitHitMetricsSnapshot() {
  const total = [...limitHitTotals.values()].reduce((sum, n) => sum + n, 0);
  return {
    total,
    last5m: countHitsSince(5 * 60_000),
    byKindLast5m: countHitsByKindSince(5 * 60_000),
    byKindTotal: Object.fromEntries(limitHitTotals.entries()),
  };
}

/** @internal test helper */
export function clearLimitHitMetricsForTests(): void {
  limitHitLog.length = 0;
  limitHitTotals.clear();
}
