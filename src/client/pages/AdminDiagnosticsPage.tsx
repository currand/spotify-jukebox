import * as React from "react";
import { Link } from "react-router-dom";
import type { HostDiagnostics, PartyView } from "@/shared/types";
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

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function sourceLabel(source: HostDiagnostics["search"]["recent"][number]["source"]): string {
  if (source === "prefetch") return "prefetch";
  if (source === "host") return "host";
  return "guest";
}

export function AdminDiagnosticsPage() {
  const [party, setParty] = React.useState<PartyFull | null>(null);
  const [diagnostics, setDiagnostics] = React.useState<HostDiagnostics | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setError(null);
      const p = await apiOptional<PartyFull>("/host/parties/current");
      setParty(p);
      const data = await api<HostDiagnostics>("/host/diagnostics");
      setDiagnostics(data);
    } catch (e) {
      setError(formatApiError(e));
    }
  }, []);

  React.useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 4000);
    return () => clearInterval(id);
  }, [load]);

  const endpointRows = diagnostics
    ? Object.entries(diagnostics.spotifyApi.byEndpointLast5m).sort((a, b) => b[1] - a[1])
    : [];

  return (
    <div className="app admin-diagnostics-page">
      <h1>Diagnostics</h1>
      <AdminNav guestCount={party?.guestCount ?? 0} partyActive={!!party} />
      {error && <p className="error">{error}</p>}

      {!diagnostics ? (
        <p>Loading diagnostics…</p>
      ) : (
        <div className="diagnostics-grid">
          <section className="card diagnostics-card">
            <h2>Spotify API</h2>
            <p className="diagnostics-stat-line">
              <strong>{diagnostics.spotifyApi.last5m}</strong> calls in last 5m ·{" "}
              <strong>{diagnostics.spotifyApi.last1m}</strong> in last 1m ·{" "}
              <strong>{diagnostics.spotifyApi.total}</strong> since start
            </p>
            <p className="small">
              Uptime {formatDuration(diagnostics.uptimeMs)} ·{" "}
              {diagnostics.spotifyApi.rateLimitCount} rate limits
              {diagnostics.spotifyApi.last429At != null
                ? ` · last 429 at ${formatTime(diagnostics.spotifyApi.last429At)}`
                : ""}
            </p>
            {endpointRows.length > 0 ? (
              <ul className="diagnostics-list">
                {endpointRows.map(([endpoint, count]) => (
                  <li key={endpoint}>
                    <code>{endpoint}</code> · {count}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small">No Spotify calls in the last 5 minutes.</p>
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
                      {event.cacheHit ? "cache hit" : "miss"} ·{" "}
                      {formatTime(event.at)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small">No searches yet this session.</p>
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
      )}

      <p className="small" style={{ marginTop: "1rem" }}>
        <Link to="/admin" className="admin-back-link">
          ← Back to admin
        </Link>
      </p>
    </div>
  );
}
