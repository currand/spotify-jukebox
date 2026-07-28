import * as React from "react";
import type {
  ArchivedPartySummary,
  DefaultGuestLimits,
  EndedPartyExport,
  HostSpotifyStatus,
  PartyRateLimits,
  PartyView,
  QueueItemView,
  QueueSnapshot,
  SearchResult,
  TrackInfo,
} from "@/shared/types";
import { factoryDefaultGuestLimits } from "@/shared/types";
import { getSearchTrackQueueState } from "@/shared/queue-match";
import { api, apiOptional } from "../http";
import { AdminNav } from "../components/AdminNav";
import { SpotifyAttribution } from "../components/SpotifyAttribution";
import {
  GuestLimitsFields,
  GuestLimitsPanel,
} from "../components/GuestLimitsFields";
import {
  AdminHistoryRow,
  AdminQueueRow,
  formatApiError,
  NowPlayingBanner,
  SearchFilterChips,
  SearchNav,
  SearchTrackRow,
  UpNextLockedSection,
} from "../components/QueueUi";

interface PartyFull extends PartyView {
  id: string;
  slug: string;
  seedPlaylistId?: string;
  guestCount?: number;
}

export function AdminPage() {
  const [status, setStatus] = React.useState<HostSpotifyStatus | null>(null);
  const [party, setParty] = React.useState<PartyFull | null>(null);
  const [queue, setQueue] = React.useState<QueueSnapshot | null>(null);
  const [history, setHistory] = React.useState<QueueItemView[]>([]);
  const [form, setForm] = React.useState({
    name: "",
    seedPlaylistId: "",
    vetoThreshold: 3,
    boostCap: null as number | null,
  });
  const [createRateLimits, setCreateRateLimits] =
    React.useState<PartyRateLimits>(factoryDefaultGuestLimits().rateLimits);
  const [defaultGuestLimits, setDefaultGuestLimits] =
    React.useState<DefaultGuestLimits>(factoryDefaultGuestLimits());
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResult | null>(null);
  const [showSearchResults, setShowSearchResults] = React.useState(false);
  const [selectedArtist, setSelectedArtist] = React.useState<{
    id: string;
    name: string;
  } | null>(null);
  const [artistFilter, setArtistFilter] = React.useState<
    "songs" | "top-tracks" | null
  >(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [hostSearching, setHostSearching] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [endedExport, setEndedExport] = React.useState<EndedPartyExport | null>(
    null,
  );
  const [archivedParties, setArchivedParties] = React.useState<
    ArchivedPartySummary[]
  >([]);
  const [selectedArchivedId, setSelectedArchivedId] = React.useState<string | null>(
    null,
  );
  const [useImportHistory, setUseImportHistory] = React.useState(false);
  const [showHistoryList, setShowHistoryList] = React.useState(false);
  const [resuming, setResuming] = React.useState(false);
  const selectedArchivedIdRef = React.useRef<string | null>(null);
  const createFormDirtyRef = React.useRef(false);
  const artistLoadRef = React.useRef(0);
  const scrollPendingRef = React.useRef<string | null>(null);
  const [highlightedItemId, setHighlightedItemId] = React.useState<string | null>(
    null,
  );
  const [hostSetupToken, setHostSetupToken] = React.useState(() => {
    try {
      return sessionStorage.getItem("jukebox_host_setup_token") ?? "";
    } catch {
      return "";
    }
  });

  function spotifyLoginHref(): string {
    const base = "/api/v1/host/spotify/login";
    if (status?.hostSetupTokenRequired === false) return base;
    const token = hostSetupToken.trim();
    if (!token) return base;
    return `${base}?token=${encodeURIComponent(token)}`;
  }

  function saveHostSetupToken(value: string) {
    setHostSetupToken(value);
    try {
      if (value.trim()) {
        sessionStorage.setItem("jukebox_host_setup_token", value);
      } else {
        sessionStorage.removeItem("jukebox_host_setup_token");
      }
    } catch {
      /* ignore */
    }
  }

  const loadArchivedExport = React.useCallback(async (partyId: string) => {
    const exportData = await apiOptional<EndedPartyExport>(
      `/host/parties/${partyId}/export`,
    );
    setEndedExport(exportData);
    return exportData;
  }, []);

  const fetchDefaultGuestLimits = React.useCallback(async () => {
    const defaults = await api<DefaultGuestLimits>(
      "/host/settings/default-rate-limits",
    );
    setDefaultGuestLimits(defaults);
    return defaults;
  }, []);

  const applyCreateFormDefaults = React.useCallback(async () => {
    const defaults = await fetchDefaultGuestLimits();
    setCreateRateLimits(defaults.rateLimits);
    setForm((current) => ({
      ...current,
      vetoThreshold: defaults.vetoThreshold,
      boostCap: defaults.boostCap,
    }));
    return defaults;
  }, [fetchDefaultGuestLimits]);

  const load = React.useCallback(async () => {
    try {
      setError(null);
      const s = await api<HostSpotifyStatus>("/host/spotify/status");
      setStatus(s);
      const p = await apiOptional<PartyFull>("/host/parties/current");
      if (s.authenticated) {
        const defaults = await fetchDefaultGuestLimits();
        if (!p && !createFormDirtyRef.current) {
          setCreateRateLimits(defaults.rateLimits);
          setForm((current) => ({
            ...current,
            vetoThreshold: defaults.vetoThreshold,
            boostCap: defaults.boostCap,
          }));
        }
      }
      setParty(p);
      if (p) {
        const q = await api<typeof queue>(`/host/parties/${p.id}/queue`);
        setQueue(q);
        const h = await api<{ history: QueueItemView[] }>(
          `/host/parties/${p.id}/history`,
        );
        setHistory(h.history);
      } else {
        setQueue(null);
        setHistory([]);
        if (s.authenticated) {
          const archived = await apiOptional<{ parties: ArchivedPartySummary[] }>(
            "/host/parties/archived",
          );
          const parties = archived?.parties ?? [];
          setArchivedParties(parties);
          const currentId = selectedArchivedIdRef.current;
          const preferredId =
            currentId && parties.some((item) => item.partyId === currentId)
              ? currentId
              : parties[0]?.partyId ?? null;
          selectedArchivedIdRef.current = preferredId;
          setSelectedArchivedId(preferredId);
          if (preferredId) {
            await loadArchivedExport(preferredId);
          } else {
            setEndedExport(null);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [loadArchivedExport, fetchDefaultGuestLimits]);

  async function selectArchivedParty(partyId: string) {
    selectedArchivedIdRef.current = partyId;
    setSelectedArchivedId(partyId);
    setShowHistoryList(false);
    try {
      await loadArchivedExport(partyId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load party export");
    }
  }

  React.useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  async function createParty() {
    try {
      setError(null);
      const body: {
        name: string;
        vetoThreshold: number;
        boostCap?: number | null;
        rateLimits: PartyRateLimits;
        seedPlaylistId?: string;
        importFromPartyId?: string;
      } = {
        name: form.name.trim(),
        vetoThreshold: form.vetoThreshold,
        boostCap: form.boostCap,
        rateLimits: createRateLimits,
      };
      if (useImportHistory && endedExport?.trackCount) {
        body.importFromPartyId = endedExport.partyId;
      } else if (form.seedPlaylistId.trim()) {
        body.seedPlaylistId = form.seedPlaylistId.trim();
      } else {
        setError("Choose a seed playlist or import a previous party track list.");
        return;
      }
      await api("/host/parties", {
        method: "POST",
        body: JSON.stringify(body),
      });
      selectedArchivedIdRef.current = null;
      setSelectedArchivedId(null);
      setEndedExport(null);
      setUseImportHistory(false);
      setForm((current) => ({ ...current, name: "", seedPlaylistId: "" }));
      createFormDirtyRef.current = false;
      await applyCreateFormDefaults();
      setNotice(null);
      await load();
    } catch (e) {
      setError(formatApiError(e));
    }
  }

  async function endParty() {
    if (!party) return;
      if (
      !confirm(
        `End "${party.name}"?\n\nGuests will lose access until you resume or start a new party. Queue state is preserved for resume.`,
      )
    ) {
      return;
    }
    try {
      setError(null);
      const result = await api<EndedPartyExport>(
        `/host/parties/${party.id}/end`,
        { method: "POST", body: "{}" },
      );
      setEndedExport(result);
      setUseImportHistory(result.trackCount > 0);
      selectedArchivedIdRef.current = result.partyId;
      setSelectedArchivedId(result.partyId);
      setParty(null);
      setQueue(null);
      setHistory([]);
      setForm((current) => ({ ...current, name: "", seedPlaylistId: "" }));
      createFormDirtyRef.current = false;
      await applyCreateFormDefaults();
      setNotice(
        result.trackCount > 0
          ? `Party ended. ${result.trackCount} tracks saved from "${result.partyName}".`
          : "Party ended.",
      );
      await load();
    } catch (e) {
      setError(formatApiError(e));
    }
  }

  async function resumeArchivedParty() {
    if (!selectedArchivedId || !selectedArchivedParty?.canResume) return;
    if (
      !confirm(
        `Resume "${selectedArchivedParty.partyName}" at /${selectedArchivedParty.slug}?\n\nGuest join links and saved sessions will work again. Turn the party ON when ready.`,
      )
    ) {
      return;
    }
    try {
      setResuming(true);
      setError(null);
      await api(`/host/parties/${selectedArchivedId}/resume`, {
        method: "POST",
        body: "{}",
      });
      setNotice(`Party "${selectedArchivedParty.partyName}" resumed. Turn it ON when ready.`);
      await load();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setResuming(false);
    }
  }

  function copyHistory() {
    if (!endedExport?.tracks.length) return;
    const text = endedExport.tracks
      .map((t) => `${t.name} — ${t.artistName}`)
      .join("\n");
    void navigator.clipboard.writeText(text);
    setNotice("Playlist copied to clipboard.");
  }

  const selectedArchivedParty = archivedParties.find(
    (item) => item.partyId === selectedArchivedId,
  ) ?? null;

  const canCreate =
    form.name.trim() &&
    (form.seedPlaylistId.trim() ||
      (useImportHistory && (endedExport?.trackCount ?? 0) > 0));

  async function toggleParty(on: boolean) {
    if (!party) return;
    await api(`/host/parties/${party.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: on ? "on" : "off" }),
    });
    await load();
  }

  function clearHostSearch() {
    setResults(null);
    setShowSearchResults(false);
    setSelectedArtist(null);
    setArtistFilter(null);
    setQuery("");
  }

  function scrollToQueueItem(itemId: string) {
    clearHostSearch();
    scrollPendingRef.current = itemId;
  }

  async function hostSearch(searchQuery?: string) {
    if (!party) return;
    const trimmed = (searchQuery ?? query).trim();
    if (trimmed.length < 3) {
      setError("Enter at least 3 characters to search.");
      return;
    }
    if (searchQuery) setQuery(searchQuery);
    if (hostSearching) return;
    setHostSearching(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api<SearchResult>(
        `/host/parties/${party.id}/search?q=${encodeURIComponent(trimmed)}`,
      );
      setResults(data);
      setShowSearchResults(true);
      setSelectedArtist(null);
      setArtistFilter(null);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setHostSearching(false);
    }
  }

  async function hostArtistFilter(
    id: string,
    name: string,
    filter: "songs" | "top-tracks",
  ) {
    if (!party) return;
    const loadId = ++artistLoadRef.current;
    setError(null);
    setNotice(null);
    setSelectedArtist({ id, name });
    setArtistFilter(filter);
    setShowSearchResults(true);

    try {
      const trackFilter = filter === "top-tracks" ? "credited" : "all";
      const data = await api<{ tracks: TrackInfo[] }>(
        `/host/parties/${party.id}/artists/${id}/tracks?name=${encodeURIComponent(name)}&filter=${trackFilter}`,
        { cache: "no-store" },
      );
      const tracks = data?.tracks;

      if (loadId !== artistLoadRef.current) return;
      if (!tracks) throw new Error("Could not load tracks");

      setResults({
        tracks,
        artists: [{ id, name, imageUrl: null }],
      });
    } catch (e) {
      if (loadId !== artistLoadRef.current) return;
      setError(formatApiError(e));
    }
  }

  async function hostAdd(track: TrackInfo) {
    if (!party) return;
    try {
      setError(null);
      setNotice(null);
      await api(`/host/parties/${party.id}/queue`, {
        method: "POST",
        body: JSON.stringify({
          uri: track.uri,
          name: track.name,
          artistName: track.artistName,
          albumArtUrl: track.albumArtUrl,
        }),
      });
      setNotice(`Added “${track.name}”`);
      await load();
    } catch (e) {
      setError(formatApiError(e));
    }
  }

  async function hostSync() {
    if (!party) return;
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const q = await api<QueueSnapshot>(`/host/parties/${party.id}/sync`, {
        method: "POST",
        body: "{}",
      });
      setQueue(q);
      setNotice("Synced with Spotify.");
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setSyncing(false);
    }
  }

  async function hostAction(path: string, method = "POST", body?: unknown) {
    try {
      setError(null);
      await api(path, {
        method,
        body: body ? JSON.stringify(body) : "{}",
      });
      await load();
    } catch (e) {
      setError(formatApiError(e));
      await load();
    }
  }

  const joinUrl = party ? `${window.location.origin}/p/${party.slug}` : "";
  const upcomingOrdered = queue?.upcomingOrder ?? [
    ...(queue?.boostLane ?? []),
    ...(queue?.upcoming ?? []),
  ];
  const upNext =
    queue?.nextItemId != null
      ? upcomingOrdered.find((item) => item.id === queue.nextItemId) ?? null
      : upcomingOrdered[0] ?? null;
  const laterQueue = upcomingOrdered.filter((item) => item.id !== upNext?.id);
  const reorderableIds = laterQueue
    .filter((item) => !item.spotifyLocked && item.status !== "queued")
    .map((item) => item.id);

  React.useEffect(() => {
    if (showSearchResults || !scrollPendingRef.current) return;
    const itemId = scrollPendingRef.current;
    scrollPendingRef.current = null;
    requestAnimationFrame(() => {
      document
        .getElementById(`queue-item-${itemId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightedItemId(itemId);
      window.setTimeout(() => setHighlightedItemId(null), 2000);
    });
  }, [showSearchResults]);

  return (
    <div className="app admin-page">
      <h1>Jukebox Admin</h1>
      <AdminNav
        guestCount={party?.guestCount ?? 0}
        partyActive={!!party}
      />
      {error && <p className="error">{error}</p>}

      <div className="admin-grid">
      <div>
        <div className="card">
          <h2>Spotify</h2>
          {status?.connected && status.authenticated ? (
            <>
              <p>Connected · expires {status.expiresAt}</p>
              {!status.deviceActive && (
                <div className="banner warn">
                  No active Spotify device — start playback on a device. Guests
                  can still queue.
                </div>
              )}
              {status.retryAfterMs != null && status.retryAfterMs > 0 && (
                <div className="banner warn">
                  {status.lastError ??
                    `Spotify rate limited — retrying in ${Math.ceil(status.retryAfterMs / 1000)}s`}
                </div>
              )}
              {status.deviceRestricted && (
                <div className="banner warn">
                  {status.lastError ??
                    "This device doesn't support remote playback control — use the Spotify app on your phone or computer."}
                  {status.deviceName && (
                    <p className="small" style={{ margin: "0.35rem 0 0" }}>
                      Active device: {status.deviceName}
                    </p>
                  )}
                </div>
              )}
              {!status.spotifyReachable && !status.deviceRestricted && (
                <div className="banner warn">
                  Spotify unreachable: {status.lastError}
                </div>
              )}
              <button
                className="secondary"
                onClick={() => void api("/host/logout", { method: "POST" })}
              >
                Logout
              </button>
            </>
          ) : status?.connected && !status.authenticated ? (
            <>
              <p>Spotify is linked, but your host session expired.</p>
              {status.hostSetupTokenRequired !== false && (
                <label className="small">
                  Host setup token
                  <input
                    type="password"
                    value={hostSetupToken}
                    onChange={(e) => saveHostSetupToken(e.target.value)}
                    placeholder="From HOST_SETUP_TOKEN in .env.production"
                    autoComplete="off"
                  />
                </label>
              )}
              <a href={spotifyLoginHref()}>
                <button
                  disabled={
                    status.hostSetupTokenRequired !== false &&
                    !hostSetupToken.trim()
                  }
                >
                  Sign in again
                </button>
              </a>
            </>
          ) : (
            <>
              {status?.hostSetupTokenRequired !== false && (
                <label className="small">
                  Host setup token
                  <input
                    type="password"
                    value={hostSetupToken}
                    onChange={(e) => saveHostSetupToken(e.target.value)}
                    placeholder="From HOST_SETUP_TOKEN in .env.production"
                    autoComplete="off"
                  />
                </label>
              )}
              <a href={spotifyLoginHref()}>
                <button
                  disabled={
                    status?.hostSetupTokenRequired !== false &&
                    !hostSetupToken.trim()
                  }
                >
                  Connect Spotify
                </button>
              </a>
            </>
          )}
        </div>

        {!party && status?.connected && status.authenticated && (
          <div className="card">
            <h2>Create party</h2>
            {notice && <p className="toast-ok">{notice}</p>}
            {archivedParties.length > 0 && (
              <div className="banner playing admin-ended-banner">
                <h3 className="admin-ended-banner-title">Previous parties</h3>
                <label className="form-field">
                  <span>Select a party</span>
                  <select
                    value={selectedArchivedId ?? ""}
                    onChange={(e) => void selectArchivedParty(e.target.value)}
                  >
                    {archivedParties.map((item) => (
                      <option key={item.partyId} value={item.partyId}>
                        {item.partyName} — {new Date(item.archivedAt).toLocaleString()} (
                        {item.guestCount} guests, {item.exportTrackCount} tracks)
                      </option>
                    ))}
                  </select>
                </label>
                {selectedArchivedParty && (
                  <p className="small admin-ended-banner-meta">
                    /{selectedArchivedParty.slug}
                    {selectedArchivedParty.canResume
                      ? " — queue can be resumed with guests, votes, and order intact."
                      : " — track list only (queue was fully ended before resume support)."}
                  </p>
                )}
                <div className="row party-controls">
                  <button
                    type="button"
                    onClick={() => void resumeArchivedParty()}
                    disabled={!selectedArchivedParty?.canResume || resuming}
                    title={
                      selectedArchivedParty?.canResume
                        ? "Reactivate this party with the same slug and guest sessions"
                        : "Track list only — queue was fully ended before resume support"
                    }
                  >
                    {resuming ? "Resuming…" : "Resume party"}
                  </button>
                  <label className="row admin-checkbox-label">
                    <input
                      type="checkbox"
                      checked={useImportHistory}
                      disabled={!endedExport?.trackCount}
                      onChange={(e) => {
                        setUseImportHistory(e.target.checked);
                        if (e.target.checked) {
                          setForm((f) => ({ ...f, seedPlaylistId: "" }));
                        }
                      }}
                    />
                    <span>Use as seed queue</span>
                  </label>
                  <button
                    type="button"
                    className="secondary"
                    onClick={copyHistory}
                    disabled={!endedExport?.tracks.length}
                  >
                    Copy list
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setShowHistoryList((v) => !v)}
                    disabled={!endedExport?.tracks.length}
                  >
                    {showHistoryList ? "Hide" : "Show"} tracks
                  </button>
                </div>
                {showHistoryList && endedExport?.tracks.length ? (
                  <div className="history-list small admin-history-list">
                    {endedExport.tracks.map((t) => (
                      <div key={t.uri}>
                        {t.name} — {t.artistName}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
            <div className="form-grid">
              <input
                placeholder="Party name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <input
                placeholder="Seed playlist URL or ID (optional if using history)"
                value={form.seedPlaylistId}
                disabled={useImportHistory}
                onChange={(e) => {
                  setForm({ ...form, seedPlaylistId: e.target.value });
                  if (e.target.value.trim()) setUseImportHistory(false);
                }}
              />
            </div>
            <details className="admin-advanced">
              <summary>Advanced guest limits</summary>
              <GuestLimitsFields
                vetoThreshold={form.vetoThreshold}
                boostCap={form.boostCap}
                rateLimits={createRateLimits}
                onVetoThresholdChange={(value) => {
                  createFormDirtyRef.current = true;
                  setForm((current) => ({ ...current, vetoThreshold: value }));
                }}
                onBoostCapChange={(value) => {
                  createFormDirtyRef.current = true;
                  setForm((current) => ({ ...current, boostCap: value }));
                }}
                onRateLimitsChange={(next) => {
                  createFormDirtyRef.current = true;
                  setCreateRateLimits(next);
                }}
                showIntro={false}
              />
            </details>
            <div className="party-controls">
              <button onClick={() => void createParty()} disabled={!canCreate}>
                Create party
              </button>
            </div>
          </div>
        )}

        {party && (
          <div className="card admin-section">
            <h2>{party.name}</h2>
            <p className="small">/{party.slug}</p>
            <div className="row party-controls">
              <button onClick={() => void toggleParty(true)} disabled={party.status === "on"}>
                Turn ON
              </button>
              <button
                className="secondary"
                onClick={() => void toggleParty(false)}
                disabled={party.status === "off"}
              >
                Turn OFF
              </button>
            </div>
            <p>
              Join link:{" "}
              <a
                href={joinUrl}
                target="_blank"
                rel="noreferrer"
                className="text-break"
              >
                {joinUrl}
              </a>
            </p>
            <img
              src={`/api/v1/host/parties/${party.id}/qr`}
              alt="QR code"
              className="party-qr"
            />
            <p className="small">
              <a href="/admin/display?fullscreen=1" target="_blank" rel="noreferrer">
                Open display view
              </a>{" "}
              for a TV-friendly queue + QR screen.
            </p>
            <GuestLimitsPanel
              partyId={party.id}
              vetoThreshold={party.vetoThreshold}
              boostCap={party.boostCap}
              rateLimits={party.rateLimits}
              defaultGuestLimits={defaultGuestLimits}
              onDefaultGuestLimitsChange={setDefaultGuestLimits}
              onSaved={() => void load()}
            />
            <div className="party-controls">
              <button type="button" className="danger" onClick={() => void endParty()}>
                End party
              </button>
            </div>
          </div>
        )}
      </div>

      {party && (
        <div>
          <div className="card admin-section">
            <h2>Queue controls</h2>
            <div className="actions">
              <button
                className="secondary"
                onClick={() => void hostSync()}
                disabled={syncing || party.status !== "on"}
              >
                {syncing ? "Syncing…" : "Sync with Spotify"}
              </button>
              <button
                onClick={() => void hostAction(`/host/parties/${party.id}/play`)}
                disabled={
                  party.status !== "on" ||
                  !status?.deviceActive ||
                  status?.deviceRestricted ||
                  status?.isPlaying === true
                }
              >
                Start
              </button>
              <button
                className="secondary"
                onClick={() => void hostAction(`/host/parties/${party.id}/pause`)}
                disabled={
                  party.status !== "on" ||
                  !status?.deviceActive ||
                  status?.deviceRestricted ||
                  status?.isPlaying !== true
                }
              >
                Stop
              </button>
              <button onClick={() => void hostAction(`/host/parties/${party.id}/skip`)}>
                Skip
              </button>
              <button onClick={() => void hostAction(`/host/parties/${party.id}/queue/shuffle`)}>
                Shuffle
              </button>
              <button
                className="secondary"
                onClick={() => void hostAction(`/host/parties/${party.id}/queue/clear`)}
              >
                Clear upcoming
              </button>
            </div>
            <div className="row admin-search-row">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search to add"
                onKeyDown={(e) => e.key === "Enter" && void hostSearch()}
              />
              <button
                onClick={() => void hostSearch()}
                disabled={hostSearching || query.trim().length < 3}
              >
                {hostSearching ? "Searching…" : "Search"}
              </button>
            </div>
            {showSearchResults && results && (
              <SearchNav
                label={selectedArtist ? "Back to search" : "Back to queue"}
                onBack={() => {
                  if (selectedArtist) {
                    void hostSearch();
                  } else {
                    setShowSearchResults(false);
                    setResults(null);
                    setNotice(null);
                  }
                }}
              />
            )}
            {showSearchResults && results && (
              <>
                {notice && <p className="toast-ok">{notice}</p>}
                {!selectedArtist && results.artists.length > 0 && (
                  <div className="admin-artist-results">
                    <strong>Artists</strong>
                    {results.artists.map((a) => (
                      <div key={a.id} className="artist-row">
                        <button
                          type="button"
                          className="linkish artist-row-name"
                          onClick={() => void hostSearch(a.name)}
                        >
                          {a.name}
                        </button>
                        <SearchFilterChips
                          filters={[
                            {
                              id: "songs",
                              label: "Songs",
                              onClick: () =>
                                void hostArtistFilter(a.id, a.name, "songs"),
                            },
                            {
                              id: "top-tracks",
                              label: "Top tracks",
                              onClick: () =>
                                void hostArtistFilter(
                                  a.id,
                                  a.name,
                                  "top-tracks",
                                ),
                            },
                          ]}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {selectedArtist && (
                  <div style={{ marginBottom: "0.75rem" }}>
                    <p className="small" style={{ margin: "0 0 0.5rem" }}>
                      {selectedArtist.name}
                    </p>
                    <SearchFilterChips
                      filters={[
                        {
                          id: "songs",
                          label: "Songs",
                          active: artistFilter === "songs",
                          onClick: () =>
                            void hostArtistFilter(
                              selectedArtist.id,
                              selectedArtist.name,
                              "songs",
                            ),
                        },
                        {
                          id: "top-tracks",
                          label: "Top tracks",
                          active: artistFilter === "top-tracks",
                          onClick: () =>
                            void hostArtistFilter(
                              selectedArtist.id,
                              selectedArtist.name,
                              "top-tracks",
                            ),
                        },
                      ]}
                    />
                  </div>
                )}
                {results.tracks.map((t) => {
                  const queueState = queue
                    ? getSearchTrackQueueState(t, queue)
                    : { blockedReason: null, queueItemId: null };
                  return (
                    <SearchTrackRow
                      key={`${artistFilter ?? "none"}-${t.uri}`}
                      track={t}
                      blockedReason={queueState.blockedReason}
                      queueItemId={queueState.queueItemId}
                      onAdd={() => void hostAdd(t)}
                      onGoToQueue={scrollToQueueItem}
                    />
                  );
                })}
              </>
            )}
          </div>

          {queue?.nowPlaying && (
            <NowPlayingBanner
              item={queue.nowPlaying}
              highlightedItemId={highlightedItemId}
            />
          )}

          {!showSearchResults && upNext && (
            <UpNextLockedSection
              item={upNext}
              highlightedItemId={highlightedItemId}
            />
          )}

          {!showSearchResults &&
            laterQueue.map((item) => {
              const reorderIdx = reorderableIds.indexOf(item.id);
              return (
                <AdminQueueRow
                  key={item.id}
                  item={item}
                  partyId={party.id}
                  onAction={hostAction}
                  canMoveUp={reorderIdx > 0}
                  canMoveDown={
                    reorderIdx >= 0 && reorderIdx < reorderableIds.length - 1
                  }
                  highlightedItemId={highlightedItemId}
                />
              );
            })}

          <div className="card admin-section">
            <h2>History</h2>
            {history.length === 0 ? (
              <p className="small muted">No history yet.</p>
            ) : (
              history.slice(0, 20).map((item) => (
                <AdminHistoryRow
                  key={item.id}
                  item={item}
                  partyId={party.id}
                  onAction={hostAction}
                />
              ))
            )}
          </div>
        </div>
      )}
      </div>
      <SpotifyAttribution />
    </div>
  );
}
