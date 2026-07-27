import * as React from "react";
import { Link } from "react-router-dom";
import type {
  HostDiagnostics,
  MetricsSessionSummary,
  MetricsSnapshotSummary,
  PartyView,
} from "@/shared/types";
import { AdminNav } from "../components/AdminNav";
import { formatApiError } from "../components/QueueUi";
import { api, apiOptional } from "../http";

interface PartyFull extends PartyView {
  id: string;
  slug: string;
  guestCount?: number;
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

function formatMinuteTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function sourceLabel(
  source: HostDiagnostics["search"]["recent"][number]["source"],
): string {
  if (source === "prefetch") return "prefetch";
  if (source === "host") return "host";
  return "guest";
}

function reasonLabel(reason: MetricsSnapshotSummary["reason"]): string {
  if (reason === "rate_limit") return "429";
  if (reason === "startup") return "start";
  return "tick";
}

function DiagnosticsPanels({ diagnostics }: { diagnostics: HostDiagnostics }) {
  const endpointRows = Object.entries(diagnostics.spotifyApi.byEndpointLast5m).sort(
    (a, b) => b[1] - a[1],
  );
  const callerRows = Object.entries(diagnostics.spotifyApi.byCallerLast5m).sort(
    (a, b) => b[1] - a[1],
  );
  const budget = diagnostics.globalApiBudget;
  const recentCalls = diagnostics.spotifyApi.recentApiCalls.slice(-20).reverse();
  const rateLimits = diagnostics.spotifyApi.rateLimitTimeline.slice(-10).reverse();

  return (
    <div className="diagnostics-grid">
      <section className="card diagnostics-card">
        <h2>Spotify API</h2>
        <p className="diagnostics-stat-line">
          <strong>{diagnostics.spotifyApi.last5m}</strong> calls in last 5m ·{" "}
          <strong>{diagnostics.spotifyApi.last1m}</strong> in last 1m ·{" "}
          <strong>{diagnostics.spotifyApi.last24h}</strong> in last 24h ·{" "}
          <strong>{diagnostics.spotifyApi.total}</strong> since start
        </p>
        {diagnostics.spotifyApi.dailyWarnExceeded && (
          <p className="small diagnostics-error">
            24h call count exceeds soft threshold (
            {diagnostics.spotifyApi.dailyWarnCalls?.toLocaleString()}). You may be
            approaching Spotify&apos;s daily quota — expect long Retry-After values.
          </p>
        )}
        <p className="small">
          Uptime {formatDuration(diagnostics.uptimeMs)} ·{" "}
          {diagnostics.spotifyApi.rateLimitCount} rate limits ·{" "}
          {diagnostics.spotifyApi.prefetchApiCalls} prefetch API calls
          {diagnostics.spotifyApi.last429At != null
            ? ` · last 429 at ${formatTime(diagnostics.spotifyApi.last429At)}`
            : ""}
        </p>
        <p className="small">
          Global budget: {budget.used}/{budget.limit} in{" "}
          {formatDuration(budget.windowMs)} window
          {budget.resetsInMs > 0
            ? ` · resets in ${formatDuration(budget.resetsInMs)}`
            : ""}
        </p>
        {callerRows.length > 0 && (
          <>
            <h3 className="diagnostics-subhead">By caller (5m)</h3>
            <ul className="diagnostics-list">
              {callerRows.map(([caller, count]) => (
                <li key={caller}>
                  <code>{caller}</code> · {count}
                </li>
              ))}
            </ul>
          </>
        )}
        {endpointRows.length > 0 ? (
          <>
            <h3 className="diagnostics-subhead">By endpoint (5m)</h3>
            <ul className="diagnostics-list">
              {endpointRows.map(([endpoint, count]) => (
                <li key={endpoint}>
                  <code>{endpoint}</code> · {count}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="small">No Spotify calls in the last 5 minutes.</p>
        )}
        {recentCalls.length > 0 && (
          <details className="diagnostics-details">
            <summary>Recent API calls ({recentCalls.length})</summary>
            <ul className="diagnostics-list diagnostics-api-list">
              {recentCalls.map((call, index) => (
                <li key={`${call.at}-${call.path}-${index}`}>
                  <span className="diagnostics-search-meta">
                    {formatTime(call.at)} · {call.caller} · {call.status} ·{" "}
                    {call.elapsedMs}ms
                    {call.retryAfterMs != null
                      ? ` · retry ${formatDuration(call.retryAfterMs)}`
                      : ""}
                  </span>
                  <code>{call.endpoint}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
        {rateLimits.length > 0 && (
          <details className="diagnostics-details">
            <summary>429 timeline ({rateLimits.length})</summary>
            <ul className="diagnostics-list">
              {rateLimits.map((entry, index) => (
                <li key={`${entry.at}-${index}`}>
                  {formatTime(entry.at)} · {entry.caller} · Retry-After{" "}
                  {formatDuration(entry.retryAfterMs)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="card diagnostics-card">
        <h2>Search activity</h2>
        <p className="diagnostics-stat-line">
          <strong>{formatPercent(diagnostics.search.hitRate)}</strong> cache hit rate ·{" "}
          <strong>{diagnostics.search.prefetchCount}</strong> prefetches
        </p>
        <p className="small">
          {diagnostics.search.total} lookups · {diagnostics.search.cacheHits} hits ·{" "}
          {diagnostics.search.cacheMisses} misses
        </p>
        {diagnostics.partySearchBudget && (
          <p className="small">
            Party search budget: {diagnostics.partySearchBudget.used}/
            {diagnostics.partySearchBudget.limit}
            {diagnostics.partySearchBudget.resetsInMs > 0
              ? ` · resets in ${formatDuration(diagnostics.partySearchBudget.resetsInMs)}`
              : ""}
          </p>
        )}
        {diagnostics.search.recent.length > 0 ? (
          <ul className="diagnostics-list diagnostics-search-list">
            {diagnostics.search.recent.map((event) => (
              <li key={`${event.at}-${event.query}-${event.kind}`}>
                <span className="diagnostics-search-query">"{event.query}"</span>
                <span className="diagnostics-search-meta">
                  {sourceLabel(event.source)} · {event.kind} ·{" "}
                  {event.cacheHit ? "cache hit" : "miss"} · {formatTime(event.at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small">No searches in this snapshot.</p>
        )}
      </section>

      <section className="card diagnostics-card">
        <h2>Cache</h2>
        <p className="diagnostics-stat-line">
          <strong>{diagnostics.cache.searchQueries.count}</strong> search queries ·{" "}
          <strong>{diagnostics.cache.artistTracks.count}</strong> artist track caches ·{" "}
          <strong>{diagnostics.cache.trackMetadata.count}</strong> track metadata
        </p>
        {diagnostics.cache.searchQueries.samples.length > 0 && (
          <>
            <h3 className="diagnostics-subhead">Cached searches</h3>
            <ul className="diagnostics-list">
              {diagnostics.cache.searchQueries.samples.map((entry) => (
                <li key={entry.query}>
                  <code>{entry.query}</code> · {entry.trackCount} tracks ·{" "}
                  {entry.artistCount} artists · TTL {formatDuration(entry.expiresInMs)}
                </li>
              ))}
            </ul>
          </>
        )}
        {diagnostics.cache.artistTracks.samples.length > 0 && (
          <>
            <h3 className="diagnostics-subhead">Cached artist tracks</h3>
            <ul className="diagnostics-list">
              {diagnostics.cache.artistTracks.samples.map((entry) => (
                <li key={entry.artistId}>
                  <code>{entry.artistId}</code> · {entry.trackCount} tracks · TTL{" "}
                  {formatDuration(entry.expiresInMs)}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card diagnostics-card">
        <h2>Sync worker</h2>
        <p className="diagnostics-stat-line">
          {diagnostics.sync.spotifyReachable ? "Spotify reachable" : "Spotify unreachable"}
          {diagnostics.sync.deviceName ? ` · ${diagnostics.sync.deviceName}` : ""}
        </p>
        <p className="small">
          Device {diagnostics.sync.deviceActive ? "active" : "inactive"}
          {diagnostics.sync.deviceRestricted ? " · restricted device" : ""}
        </p>
        <p className="small">
          Last sync {formatTime(diagnostics.sync.lastSyncedAt)}
          {diagnostics.sync.retryAfterMs != null && diagnostics.sync.retryAfterMs > 0
            ? ` · rate limited ${formatDuration(diagnostics.sync.retryAfterMs)}`
            : ""}
        </p>
        {diagnostics.sync.lastError && (
          <p className="small diagnostics-error">{diagnostics.sync.lastError}</p>
        )}
      </section>
    </div>
  );
}

export function AdminDiagnosticsPage() {
  const [party, setParty] = React.useState<PartyFull | null>(null);
  const [liveDiagnostics, setLiveDiagnostics] = React.useState<HostDiagnostics | null>(
    null,
  );
  const [sessions, setSessions] = React.useState<MetricsSessionSummary[]>([]);
  const [viewMode, setViewMode] = React.useState<"live" | "history">("live");
  const [selectedSessionId, setSelectedSessionId] = React.useState<string | null>(null);
  const [snapshots, setSnapshots] = React.useState<MetricsSnapshotSummary[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = React.useState<number | null>(
    null,
  );
  const [historicalDiagnostics, setHistoricalDiagnostics] =
    React.useState<HostDiagnostics | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const loadSessions = React.useCallback(async () => {
    const data = await api<{ sessions: MetricsSessionSummary[] }>(
      "/host/metrics/sessions",
    );
    setSessions(data.sessions);
    return data.sessions;
  }, []);

  const loadLive = React.useCallback(async () => {
    const p = await apiOptional<PartyFull>("/host/parties/current");
    setParty(p);
    const data = await api<HostDiagnostics>("/host/diagnostics");
    setLiveDiagnostics(data);
    return data;
  }, []);

  const load = React.useCallback(async () => {
    try {
      setError(null);
      await Promise.all([loadLive(), loadSessions()]);
    } catch (e) {
      setError(formatApiError(e));
    }
  }, [loadLive, loadSessions]);

  React.useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (viewMode === "live") {
        void loadLive().catch((e) => setError(formatApiError(e)));
        void loadSessions().catch(() => {});
      }
    }, 4000);
    return () => clearInterval(id);
  }, [load, loadLive, loadSessions, viewMode]);

  React.useEffect(() => {
    if (viewMode !== "history" || !selectedSessionId) {
      setSnapshots([]);
      setSelectedSnapshotId(null);
      setHistoricalDiagnostics(null);
      return;
    }

    void (async () => {
      try {
        setError(null);
        const data = await api<{ snapshots: MetricsSnapshotSummary[] }>(
          `/host/metrics/sessions/${selectedSessionId}/snapshots?limit=180&granularity=minute`,
        );
        setSnapshots(data.snapshots);
        const preferred =
          data.snapshots.find((snapshot) => snapshot.reason === "rate_limit") ??
          data.snapshots[0] ??
          null;
        setSelectedSnapshotId(preferred?.id ?? null);
      } catch (e) {
        setError(formatApiError(e));
      }
    })();
  }, [viewMode, selectedSessionId]);

  React.useEffect(() => {
    if (
      viewMode !== "history" ||
      !selectedSessionId ||
      selectedSnapshotId == null
    ) {
      setHistoricalDiagnostics(null);
      return;
    }

    void (async () => {
      try {
        setError(null);
        const data = await api<HostDiagnostics>(
          `/host/metrics/sessions/${selectedSessionId}/snapshots/${selectedSnapshotId}`,
        );
        setHistoricalDiagnostics(data);
      } catch (e) {
        setError(formatApiError(e));
      }
    })();
  }, [viewMode, selectedSessionId, selectedSnapshotId]);

  const activeDiagnostics =
    viewMode === "live" ? liveDiagnostics : historicalDiagnostics;

  const currentSession = sessions.find((session) => session.isCurrent) ?? null;
  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ?? null;

  return (
    <div className="app admin-diagnostics-page">
      <h1>Diagnostics</h1>
      <AdminNav guestCount={party?.guestCount ?? 0} partyActive={!!party} />
      {error && <p className="error">{error}</p>}

      <section className="card diagnostics-session-bar">
        <div className="row diagnostics-session-controls">
          <button
            type="button"
            className={viewMode === "live" ? undefined : "secondary"}
            onClick={() => {
              setViewMode("live");
              setSelectedSessionId(null);
            }}
          >
            Live
          </button>
          <label className="small diagnostics-session-select">
            Session{" "}
            <select
              value={viewMode === "history" ? (selectedSessionId ?? "") : ""}
              onChange={(e) => {
                const sessionId = e.target.value;
                if (!sessionId) {
                  setViewMode("live");
                  setSelectedSessionId(null);
                  return;
                }
                setViewMode("history");
                setSelectedSessionId(sessionId);
              }}
            >
              <option value="">Select past session…</option>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {formatDateTime(session.startedAt)}
                  {session.isCurrent ? " (current)" : ""}
                  {session.rateLimitSnapshotCount > 0
                    ? ` · ${session.rateLimitSnapshotCount}×429`
                    : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="small">
          {viewMode === "live" ? (
            <>
              Recording every 10s (shown by minute) into session{" "}
              <code>{currentSession?.id ?? liveDiagnostics?.sessionId ?? "…"}</code>
              {currentSession
                ? ` · ${currentSession.snapshotCount} snapshots`
                : ""}
            </>
          ) : selectedSession ? (
            <>
              Viewing {formatDateTime(selectedSession.startedAt)}
              {selectedSession.endedAt
                ? ` – ${formatDateTime(selectedSession.endedAt)}`
                : " (running)"}
              {" · "}
              {selectedSession.snapshotCount} snapshots
              {selectedSession.rateLimitSnapshotCount > 0
                ? ` · ${selectedSession.rateLimitSnapshotCount} captured at 429`
                : ""}
            </>
          ) : (
            "Select a session to review recorded metrics."
          )}
        </p>
      </section>

      {viewMode === "history" && snapshots.length > 0 && (
        <section className="card diagnostics-snapshot-picker">
          <h2>Timeline (1-minute summaries)</h2>
          <div className="diagnostics-snapshot-list">
            {snapshots.map((snapshot) => (
              <button
                key={`${snapshot.id}-${snapshot.recordedAt}`}
                type="button"
                className={`diagnostics-snapshot-chip${
                  snapshot.id === selectedSnapshotId
                    ? " diagnostics-snapshot-chip--active"
                    : ""
                }${snapshot.reason === "rate_limit" ? " diagnostics-snapshot-chip--429" : ""}`}
                onClick={() => setSelectedSnapshotId(snapshot.id)}
              >
                <span>{formatMinuteTime(snapshot.recordedAt)}</span>
                <span className="diagnostics-snapshot-chip-meta">
                  {reasonLabel(snapshot.reason)}
                  {snapshot.sampleCount != null && snapshot.sampleCount > 1
                    ? ` · ${snapshot.sampleCount} samples`
                    : ""}
                  {" · "}
                  {snapshot.apiCallsLast5m}/5m · {snapshot.rateLimitCount}×429
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {!activeDiagnostics ? (
        <p>Loading diagnostics…</p>
      ) : (
        <DiagnosticsPanels diagnostics={activeDiagnostics} />
      )}

      <p className="small" style={{ marginTop: "1rem" }}>
        <Link to="/admin" className="admin-back-link">
          ← Back to admin
        </Link>
      </p>
    </div>
  );
}
