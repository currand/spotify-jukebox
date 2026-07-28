export interface Phase {
  name: string;
  durationMs: number;
  /** Chance per tick that a guest performs an action (0-1) */
  activityRate: number;
  /** Weighted action distribution search, add, upvote, downvote, boost, idle] */
  actionWeights: number[];
}

export const ENDURANCE_PHASES: Phase[] = [
  {
    name: "Arrival",
    durationMs: 60 * 60 * 1000,
    activityRate: 0.3,
    actionWeights: [30, 25, 15, 5, 5, 20],
  },
  {
    name: "Peak",
    durationMs: 90 * 60 * 1000,
    activityRate: 0.15,
    actionWeights: [15, 10, 30, 15, 5, 25],
  },
  {
    name: "Wind down",
    durationMs: 30 * 60 * 1000,
    activityRate: 0.08,
    actionWeights: [10, 8, 20, 10, 2, 50],
  },
];

export const ENDURANCE_TOTAL_MS = ENDURANCE_PHASES.reduce(
  (sum, phase) => sum + phase.durationMs,
  0,
);

export function getPhaseAtElapsed(elapsedMs: number): Phase {
  let accumulated = 0;
  for (const phase of ENDURANCE_PHASES) {
    accumulated += phase.durationMs;
    if (elapsedMs < accumulated) return phase;
  }
  return ENDURANCE_PHASES[ENDURANCE_PHASES.length - 1]!;
}

export function actionDelayMs(phase: Phase): number {
  const baseDelay = phase.name === "Arrival" ? 15_000 : 30_000;
  const maxDelay = phase.name === "Arrival" ? 60_000 : 120_000;
  return baseDelay + Math.floor(Math.random() * (maxDelay - baseDelay));
}

export function idleDelayMs(): number {
  return 5_000 + Math.floor(Math.random() * 10_000);
}
