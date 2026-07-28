import * as React from "react";
import type { HostDiagnostics } from "@/shared/types";
import { DEFAULT_PARTY_SEARCH_LIMIT } from "@/shared/types";

export function formatRateLimitWindow(windowMs: number): string {
  const minutes = windowMs / (60 * 1000);
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "per hour" : `per ${hours} hours`;
  }
  if (minutes >= 1) {
    return minutes === 1 ? "per minute" : `per ${minutes} minutes`;
  }
  const seconds = Math.round(windowMs / 1000);
  return seconds === 1 ? "per second" : `per ${seconds} seconds`;
}

export function StatTile({
  label,
  value,
  meta,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  meta?: React.ReactNode;
  tone?: "default" | "warn" | "ok";
}) {
  return (
    <div className={`stat-tile stat-tile--${tone}`}>
      <span className="stat-tile-label">{label}</span>
      <span className="stat-tile-value">{value}</span>
      {meta ? <span className="stat-tile-meta">{meta}</span> : null}
    </div>
  );
}

export function StatGrid({
  children,
  columns = 2,
}: {
  children: React.ReactNode;
  columns?: 2 | 3 | 4;
}) {
  return (
    <div className={`stat-grid stat-grid--cols-${columns}`}>{children}</div>
  );
}

export function QuotaTile({
  label,
  remaining,
  limit,
  windowMs,
  tone = "default",
}: {
  label: string;
  remaining: number;
  limit: number;
  windowMs: number;
  tone?: "default" | "warn" | "ok";
}) {
  const pct = limit > 0 ? Math.round((remaining / limit) * 100) : 0;

  return (
    <div className={`stat-tile stat-tile--quota stat-tile--${tone}`}>
      <span className="stat-tile-label">{label}</span>
      <span className="stat-tile-value">{remaining}</span>
      <span className="stat-tile-meta">
        {remaining} of {limit} left · {formatRateLimitWindow(windowMs)}
      </span>
      <div
        className="stat-tile-bar"
        role="progressbar"
        aria-valuenow={remaining}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-label={`${label}: ${remaining} of ${limit} remaining`}
      >
        <div className="stat-tile-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function BudgetTile({
  label,
  used,
  limit,
  windowMs,
  resetsInMs,
}: {
  label: string;
  used: number;
  limit: number;
  windowMs: number;
  resetsInMs?: number;
}) {
  const remaining = Math.max(0, limit - used);
  const pct = limit > 0 ? Math.round((remaining / limit) * 100) : 0;
  const tone = remaining <= limit * 0.2 ? "warn" : "default";

  return (
    <div className={`stat-tile stat-tile--quota stat-tile--${tone}`}>
      <span className="stat-tile-label">{label}</span>
      <span className="stat-tile-value">{used}</span>
      <span className="stat-tile-meta">
        {used} of {limit} used · {formatRateLimitWindow(windowMs)}
        {resetsInMs != null && resetsInMs > 0
          ? ` · resets in ${Math.ceil(resetsInMs / 1000)}s`
          : ""}
      </span>
      <div
        className="stat-tile-bar"
        role="progressbar"
        aria-valuenow={remaining}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-label={`${label}: ${remaining} of ${limit} remaining`}
      >
        <div className="stat-tile-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function StatPanel({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="stat-panel card">
      <h2>{title}</h2>
      {intro ? <p className="stat-panel-intro">{intro}</p> : null}
      {children}
    </section>
  );
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatTime(at: number | null): string {
  if (at == null) return "—";
  return new Date(at).toLocaleTimeString();
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function limitKindLabel(kind: string): string {
  switch (kind) {
    case "guest_add":
      return "Adds blocked";
    case "guest_upvote":
      return "Upvotes blocked";
    case "guest_downvote":
      return "Downvotes blocked";
    case "guest_boost":
      return "Boosts blocked";
    case "guest_search":
      return "Guest searches blocked";
    case "party_search":
      return "Party searches blocked";
    default:
      return kind;
  }
}

function countRecent429s(diagnostics: HostDiagnostics): number {
  const cutoff = Date.now() - 5 * 60_000;
  return diagnostics.spotifyApi.rateLimitTimeline.filter((entry) => entry.at >= cutoff)
    .length;
}

function countRecentSearches(diagnostics: HostDiagnostics): number {
  const cutoff = Date.now() - 5 * 60_000;
  return diagnostics.search.recent.filter((entry) => entry.at >= cutoff).length;
}

export function DiagnosticsSummaryPanels({
  diagnostics,
}: {
  diagnostics: HostDiagnostics;
}) {
  const guestLimits = diagnostics.guestLimits ?? {
    total: 0,
    last5m: 0,
    byKindLast5m: {},
    byKindTotal: {},
  };
  const spotify429Last5m = countRecent429s(diagnostics);
  const searchesLast5m = countRecentSearches(diagnostics);
  const callsPerMin = Math.round(diagnostics.spotifyApi.last5m / 5);
  const guestLimitKinds = Object.entries(guestLimits.byKindLast5m).sort(
    (a, b) => b[1] - a[1],
  );
  const syncRateLimited =
    diagnostics.sync.retryAfterMs != null && diagnostics.sync.retryAfterMs > 0;

  return (
    <>
      <StatPanel
        title="API activity"
        intro="Spotify call volume and rate-limit pressure over recent windows."
      >
        <StatGrid columns={4}>
          <StatTile
            label="Spotify calls (5m)"
            value={diagnostics.spotifyApi.last5m}
            meta={`~${callsPerMin}/min · ${diagnostics.spotifyApi.last1m} in last 1m`}
          />
          <StatTile
            label="Spotify 429s"
            value={diagnostics.spotifyApi.rateLimitCount}
            meta={
              syncRateLimited
                ? `Backing off ${formatDuration(diagnostics.sync.retryAfterMs ?? 0)} · ${spotify429Last5m} in last 5m`
                : spotify429Last5m > 0
                  ? `${spotify429Last5m} in last 5m · last at ${formatTime(diagnostics.spotifyApi.last429At)}`
                  : diagnostics.spotifyApi.last429At != null
                    ? `Last at ${formatTime(diagnostics.spotifyApi.last429At)}`
                    : "None this session"
            }
            tone={
              syncRateLimited || spotify429Last5m > 0
                ? "warn"
                : "default"
            }
          />
          <StatTile
            label="Search queries (5m)"
            value={searchesLast5m}
            meta={`${diagnostics.search.total} total · ${formatPercent(diagnostics.search.hitRate)} cache hit`}
            tone={diagnostics.search.cacheMisses > diagnostics.search.cacheHits ? "warn" : "default"}
          />
          <StatTile
            label="Uptime"
            value={formatDuration(diagnostics.uptimeMs)}
            meta={`${diagnostics.spotifyApi.last24h} Spotify calls in 24h`}
          />
        </StatGrid>
      </StatPanel>

      <StatPanel
        title="Budgets & limits"
        intro="Shared API budget, party search allowance, and guest action blocks."
      >
        <StatGrid columns={4}>
          <BudgetTile
            label="Global Spotify budget"
            used={diagnostics.globalApiBudget.used}
            limit={diagnostics.globalApiBudget.limit}
            windowMs={diagnostics.globalApiBudget.windowMs}
            resetsInMs={diagnostics.globalApiBudget.resetsInMs}
          />
          {diagnostics.partySearchBudget ? (
            <BudgetTile
              label="Party search budget"
              used={diagnostics.partySearchBudget.used}
              limit={diagnostics.partySearchBudget.limit}
              windowMs={DEFAULT_PARTY_SEARCH_LIMIT.windowMs}
              resetsInMs={diagnostics.partySearchBudget.resetsInMs}
            />
          ) : (
            <StatTile
              label="Party search budget"
              value="—"
              meta="No active party"
            />
          )}
          <StatTile
            label="Guest limits hit (5m)"
            value={guestLimits.last5m}
            meta={
              guestLimits.total > 0
                ? `${guestLimits.total} total this session`
                : "No guest blocks recently"
            }
            tone={guestLimits.last5m > 0 ? "warn" : "default"}
          />
          <StatTile
            label="Sync"
            value={diagnostics.sync.deviceActive ? "Active" : "Idle"}
            meta={
              syncRateLimited
                ? `Rate limited · ${diagnostics.sync.lastError ?? "backing off"}`
                : diagnostics.sync.deviceRestricted
                  ? diagnostics.sync.lastError ?? "Restricted device"
                  : diagnostics.sync.lastError ?? "Spotify reachable"
            }
            tone={
              syncRateLimited || diagnostics.sync.deviceRestricted
                ? "warn"
                : diagnostics.sync.deviceActive
                  ? "ok"
                  : "default"
            }
          />
        </StatGrid>
        {guestLimitKinds.length > 0 && (
          <div className="stat-breakdown">
            {guestLimitKinds.map(([kind, count]) => (
              <span key={kind} className="stat-breakdown-item">
                {limitKindLabel(kind)} · {count}
              </span>
            ))}
          </div>
        )}
        {diagnostics.spotifyApi.dailyWarnExceeded && (
          <p className="stat-panel-warn">
            24h Spotify call count exceeds soft threshold (
            {diagnostics.spotifyApi.dailyWarnCalls?.toLocaleString()}). Expect
            longer Retry-After values.
          </p>
        )}
      </StatPanel>
    </>
  );
}

export function GuestQuotaPanel({
  quota,
  rateLimits,
}: {
  quota: { add: number; upvote: number; downvote: number; boost: number };
  rateLimits: {
    add: { count: number; windowMs: number };
    upvote: { count: number; windowMs: number };
    downvote: { count: number; windowMs: number };
    boost: { count: number; windowMs: number };
  };
}) {
  return (
    <StatPanel
      title="Actions left"
      intro="Your remaining adds, upvotes, downvotes, and boosts for this party."
    >
      <StatGrid columns={4}>
        <QuotaTile
          label="Adds"
          remaining={quota.add}
          limit={rateLimits.add.count}
          windowMs={rateLimits.add.windowMs}
        />
        <QuotaTile
          label="Upvotes"
          remaining={quota.upvote}
          limit={rateLimits.upvote.count}
          windowMs={rateLimits.upvote.windowMs}
        />
        <QuotaTile
          label="Downvotes"
          remaining={quota.downvote}
          limit={rateLimits.downvote.count}
          windowMs={rateLimits.downvote.windowMs}
        />
        <QuotaTile
          label="Boosts"
          remaining={quota.boost}
          limit={rateLimits.boost.count}
          windowMs={rateLimits.boost.windowMs}
        />
      </StatGrid>
    </StatPanel>
  );
}

export function GuestActivityPanel({
  stats,
}: {
  stats: {
    upvotesGiven: number;
    downvotesGiven: number;
    boostsGiven: number;
    songsInQueue: number;
    songsPlayed: number;
    songsAdded: number;
  };
}) {
  return (
    <StatPanel title="Your activity">
      <StatGrid columns={3}>
        <StatTile label="Upvotes given" value={stats.upvotesGiven} />
        <StatTile label="Downvotes given" value={stats.downvotesGiven} />
        <StatTile label="Boosts used" value={stats.boostsGiven} />
        <StatTile label="Songs in queue" value={stats.songsInQueue} />
        <StatTile label="Songs played" value={stats.songsPlayed} />
        <StatTile label="Songs added" value={stats.songsAdded} />
      </StatGrid>
    </StatPanel>
  );
}
