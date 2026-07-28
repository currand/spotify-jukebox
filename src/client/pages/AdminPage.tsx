import * as React from "react";
import type {
  ArchivedPartySummary,
  DefaultGuestLimits,
  EndedPartyExport,
  HostSeedPlaylist,
  HostSpotifyStatus,
  PartyRateLimits,
  PartyView,
  QueueItemView,
  QueueSnapshot,
  SearchResult,
  SpotifyConnectDevice,
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

function startPlaybackBlockedReason(
  party: PartyView,
  status: HostSpotifyStatus | null,
): string | null {
  if (party.status !== "on") {
    return "Turn the party ON before starting playback.";
  }
  if (status?.deviceRestricted) {
    return (
      status.lastError ??
      "This device doesn't support remote playback control — use the Spotify app on your phone or computer."
    );
  }
  if (!status?.deviceActive) {
    return "Playback is not active on the target device — try Turn ON again or refresh devices.";
  }
  if (status.isPlaying) {
    return "Playback is already running.";
  }
  return null;
}

function stopPlaybackBlockedReason(
  party: PartyView,
  status: HostSpotifyStatus | null,
): string | null {
  if (party.status !== "on") {
    return "Turn the party ON before controlling playback.";
  }
  if (status?.deviceRestricted) {
    return (
      status.lastError ??
      "This device doesn't support remote playback control — use the Spotify app on your phone or computer."
    );
  }
  if (!status?.deviceActive) {
    return "Playback is not active on the target device — try Turn ON again or refresh devices.";
  }
  if (status.isPlaying !== true) {
    return "Nothing is playing right now.";
  }
  return null;
}

function PlayIcon() {
  return (
    <svg className="playback-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.14v13.72c0 .79.87 1.27 1.54.84l11.04-6.86a1 1 0 0 0 0-1.7L9.54 4.3A1 1 0 0 0 8 5.14Z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg className="playback-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5h3v14H7V5Zm7 0h3v14h-3V5Z" fill="currentColor" />
    </svg>
  );
}

function SkipIcon() {
  return (
    <svg className="playback-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" fill="currentColor" />
    </svg>
  );
}

function BlockedActionButton({
  blockedReason,
  onBlocked,
  onAction,
  children,
  className,
  ariaLabel,
}: {
  blockedReason: string | null;
  onBlocked: (message: string) => void;
  onAction: () => void;
  children: React.ReactNode;
  className?: string;
  ariaLabel: string;
}) {
  const blocked = blockedReason != null;
  return (
    <span
      className={`blocked-action-slot${blocked ? " blocked-action-slot--blocked" : ""}`}
      onClick={() => {
        if (blocked) onBlocked(blockedReason);
      }}
    >
      <button
        type="button"
        className={className}
        aria-label={ariaLabel}
        disabled={blocked}
        onClick={() => onAction()}
      >
        {children}
      </button>
    </span>
  );
}

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
    downvoteThreshold: 3,
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
  const [seedPlaylists, setSeedPlaylists] = React.useState<HostSeedPlaylist[]>([]);
  const [loadingSeedPlaylists, setLoadingSeedPlaylists] = React.useState(false);
  const [seedPlaylistsError, setSeedPlaylistsError] = React.useState<string | null>(
    null,
  );
  const [resuming, setResuming] = React.useState(false);
  const [spotifyDevices, setSpotifyDevices] = React.useState<SpotifyConnectDevice[]>([]);
  const [loadingDevices, setLoadingDevices] = React.useState(false);
  const [devicesError, setDevicesError] = React.useState<string | null>(null);
  const [deletingParty, setDeletingParty] = React.useState(false);
  const selectedArchivedIdRef = React.useRef<string | null>(null);
  const createFormDirtyRef = React.useRef(false);
  const seedPlaylistsLoadRef = React.useRef(0);
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
    if (status?.hostSetupTokenRequired !== true) return base;
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
      downvoteThreshold: defaults.downvoteThreshold,
      boostCap: defaults.boostCap,
    }));
    return defaults;
  }, [fetchDefaultGuestLimits]);

  const loadSeedPlaylists = React.useCallback(async () => {
    const loadId = ++seedPlaylistsLoadRef.current;
    setLoadingSeedPlaylists(true);
    setSeedPlaylistsError(null);
    try {
      const data = await api<{ playlists: HostSeedPlaylist[] }>(
        "/host/spotify/playlists",
      );
      if (loadId !== seedPlaylistsLoadRef.current) return;
      setSeedPlaylists(data.playlists);
    } catch (e) {
      if (loadId !== seedPlaylistsLoadRef.current) return;
      setSeedPlaylists([]);
      setSeedPlaylistsError(
        e instanceof Error ? e.message : "Failed to load Spotify playlists",
      );
    } finally {
      if (loadId === seedPlaylistsLoadRef.current) {
        setLoadingSeedPlaylists(false);
      }
    }
  }, []);

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
            downvoteThreshold: defaults.downvoteThreshold,
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

  React.useEffect(() => {
    if (party || !status?.authenticated) return;
    void loadSeedPlaylists();
  }, [party, status?.authenticated, loadSeedPlaylists]);

  const loadSpotifyDevices = React.useCallback(async () => {
    setLoadingDevices(true);
    setDevicesError(null);
    try {
      const data = await api<{ devices: SpotifyConnectDevice[] }>("/host/spotify/devices");
      setSpotifyDevices(data.devices);
    } catch (e) {
      setSpotifyDevices([]);
      setDevicesError(e instanceof Error ? e.message : "Failed to load devices");
    } finally {
      setLoadingDevices(false);
    }
  }, []);

  React.useEffect(() => {
    if (!party || !status?.authenticated) return;
    void loadSpotifyDevices();
  }, [party?.id, status?.authenticated, loadSpotifyDevices]);

  async function selectArchivedParty(partyId: string) {
    selectedArchivedIdRef.current = partyId;
    setSelectedArchivedId(partyId);
    setUseImportHistory(false);
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
        downvoteThreshold: number;
        boostCap?: number | null;
        rateLimits: PartyRateLimits;
        seedPlaylistId?: string;
        importFromPartyId?: string;
      } = {
        name: form.name.trim(),
        downvoteThreshold: form.downvoteThreshold,
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
      selectedArchivedIdRef.current = result.partyId;
      setSelectedArchivedId(result.partyId);
      setParty(null);
      setQueue(null);
      setHistory([]);
      setUseImportHistory(false);
      setShowHistoryList(false);
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
    if (!selectedArchivedId || !selectedArchivedParty?.canResume || useImportHistory) return;
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

  const selectedArchivedParty = archivedParties.find(
    (item) => item.partyId === selectedArchivedId,
  ) ?? null;

  function formatPlaylistMeta(playlist: HostSeedPlaylist): string {
    const parts = [`${playlist.trackCount} track${playlist.trackCount === 1 ? "" : "s"}`];
    if (playlist.collaborative) {
      parts.push("collaborative");
    } else if (playlist.isPublic === false) {
      parts.push("private");
    }
    if (playlist.ownerName) {
      parts.push(playlist.ownerName);
    }
    return parts.join(" · ");
  }

  const selectedSeedPlaylist = seedPlaylists.find(
    (item) => item.id === form.seedPlaylistId,
  ) ?? null;

  const canCreate =
    form.name.trim() &&
    (form.seedPlaylistId.trim() ||
      (useImportHistory && (endedExport?.trackCount ?? 0) > 0));

  const createPartyHint = !form.name.trim()
    ? "Enter a party name to continue."
    : !form.seedPlaylistId.trim() &&
        !(useImportHistory && (endedExport?.trackCount ?? 0) > 0)
      ? "Choose a seed playlist or import a previous party track list."
      : null;

  async function saveTargetDevice(deviceId: string | null) {
    if (!party) return;
    try {
      setError(null);
      await api(`/host/parties/${party.id}`, {
        method: "PATCH",
        body: JSON.stringify({ spotifyDeviceId: deviceId }),
      });
      await load();
    } catch (e) {
      setError(formatApiError(e));
    }
  }

  async function deleteArchivedParty() {
    if (!selectedArchivedId || !selectedArchivedParty) return;
    if (
      !confirm(
        `Delete "${selectedArchivedParty.partyName}" permanently?\n\nThis removes the party record and deletes its bootstrap Spotify playlist if one exists.`,
      )
    ) {
      return;
    }
    try {
      setDeletingParty(true);
      setError(null);
      await api(`/host/parties/${selectedArchivedId}`, { method: "DELETE" });
      selectedArchivedIdRef.current = null;
      setSelectedArchivedId(null);
      setEndedExport(null);
      setShowHistoryList(false);
      setNotice("Party deleted.");
      await load();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setDeletingParty(false);
    }
  }

  async function toggleParty(on: boolean) {
    if (!party) return;
    try {
      setError(null);
      const result = await api<{
        ok: boolean;
        bootstrapNotice?: string;
      }>(`/host/parties/${party.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: on ? "on" : "off" }),
      });
      if (result.bootstrapNotice) {
        setNotice(null);
        setError(result.bootstrapNotice);
      } else if (on) {
        setError(null);
        setNotice("Party is ON — guests can join.");
      }
      await load();
    } catch (e) {
      setError(formatApiError(e));
    }
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
              {status.retryAfterMs != null && status.retryAfterMs > 0 && (
                <div className="banner warn">
                  {status.lastError ??
                    `Spotify rate limited — retrying in ${Math.ceil(status.retryAfterMs / 1000)}s`}
                </div>
              )}
              {!status.deviceActive &&
                !(status.retryAfterMs != null && status.retryAfterMs > 0) && (
                <div className="banner warn">
                  No active playback on the target device — if the party is off,
                  select a player below and Turn ON. If the party is already on,
                  refresh devices or open Spotify on that speaker.
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
              {status?.hostSetupTokenRequired === true && (
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
                    status?.hostSetupTokenRequired === true &&
                    !hostSetupToken.trim()
                  }
                >
                  Sign in again
                </button>
              </a>
            </>
          ) : (
            <>
              {status?.hostSetupTokenRequired === true && (
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
                    status?.hostSetupTokenRequired === true &&
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
                <div className="admin-ended-actions">
                  <div className="admin-ended-actions-row">
                    <button
                      type="button"
                      onClick={() => void resumeArchivedParty()}
                      disabled={
                        !selectedArchivedParty?.canResume || resuming || useImportHistory
                      }
                      title={
                        useImportHistory
                          ? "Uncheck “Use as seed queue” to resume this party instead"
                          : selectedArchivedParty?.canResume
                            ? "Reactivate this party with the same slug and guest sessions"
                            : "Track list only — queue was fully ended before resume support"
                      }
                    >
                      {resuming ? "Resuming…" : "Resume party"}
                    </button>
                    <label
                      className="admin-checkbox-label"
                      title={
                        selectedArchivedParty?.canResume
                          ? "Start a new party below using this track list (does not restore guests or slug)"
                          : undefined
                      }
                    >
                      <input
                        type="checkbox"
                        checked={useImportHistory}
                        disabled={!endedExport?.trackCount || resuming}
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
                      onClick={() => setShowHistoryList((v) => !v)}
                      disabled={!endedExport?.tracks.length}
                    >
                      {showHistoryList ? "Hide" : "Show"} tracks
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void deleteArchivedParty()}
                      disabled={deletingParty}
                    >
                      {deletingParty ? "Deleting…" : "Delete party"}
                    </button>
                  </div>
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
            <label className="form-field create-party-name-field">
              <span>Party name</span>
              <input
                placeholder="e.g. Friday Night Mix"
                value={form.name}
                autoFocus
                onChange={(e) => {
                  createFormDirtyRef.current = true;
                  setForm((current) => ({ ...current, name: e.target.value }));
                }}
              />
            </label>
            <div className="seed-playlist-picker">
              <span className="small">Seed playlist</span>
              {seedPlaylistsError ? (
                <p className="small seed-playlist-status">{seedPlaylistsError}</p>
              ) : null}
              {loadingSeedPlaylists ? (
                <p className="small seed-playlist-status">Loading your Spotify playlists…</p>
              ) : null}
              {!loadingSeedPlaylists && seedPlaylists.length === 0 ? (
                <p className="small seed-playlist-status">
                  No playlists with tracks found in your Spotify account.
                </p>
              ) : null}
              {!loadingSeedPlaylists && seedPlaylists.length > 0 ? (
                <ul className="seed-playlist-list">
                  {seedPlaylists.map((playlist) => (
                    <li key={playlist.id}>
                      <label
                        className={`seed-playlist-option${
                          form.seedPlaylistId === playlist.id ? " seed-playlist-option--selected" : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name="seedPlaylist"
                          value={playlist.id}
                          checked={form.seedPlaylistId === playlist.id}
                          disabled={useImportHistory}
                          onChange={() => {
                            createFormDirtyRef.current = true;
                            setForm((current) => ({
                              ...current,
                              seedPlaylistId: playlist.id,
                            }));
                            setUseImportHistory(false);
                          }}
                        />
                        {playlist.imageUrl ? (
                          <img
                            className="seed-playlist-art"
                            src={playlist.imageUrl}
                            alt=""
                            width={48}
                            height={48}
                          />
                        ) : (
                          <span className="seed-playlist-art seed-playlist-art--placeholder" />
                        )}
                        <span className="seed-playlist-copy">
                          <span className="seed-playlist-name">{playlist.name}</span>
                          <span className="small seed-playlist-meta">
                            {formatPlaylistMeta(playlist)}
                          </span>
                          {playlist.description ? (
                            <span className="small seed-playlist-description">
                              {playlist.description}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : null}
              {selectedSeedPlaylist && !useImportHistory ? (
                <p className="small seed-playlist-selected">
                  Selected: {selectedSeedPlaylist.name} ({selectedSeedPlaylist.trackCount}{" "}
                  tracks)
                </p>
              ) : null}
            </div>
            <details className="admin-advanced">
              <summary>Advanced guest limits</summary>
              <GuestLimitsFields
                downvoteThreshold={form.downvoteThreshold}
                boostCap={form.boostCap}
                rateLimits={createRateLimits}
                onDownvoteThresholdChange={(value) => {
                  createFormDirtyRef.current = true;
                  setForm((current) => ({ ...current, downvoteThreshold: value }));
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
              {!canCreate && createPartyHint ? (
                <p className="small seed-playlist-status">{createPartyHint}</p>
              ) : null}
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
              downvoteThreshold={party.downvoteThreshold}
              boostCap={party.boostCap}
              rateLimits={party.rateLimits}
              defaultGuestLimits={defaultGuestLimits}
              onDefaultGuestLimitsChange={setDefaultGuestLimits}
              onSaved={() => void load()}
            />
            <div className="admin-device-picker">
              <div className="admin-device-picker-header">
                <h3>Target player</h3>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void loadSpotifyDevices()}
                  disabled={loadingDevices}
                >
                  {loadingDevices ? "Refreshing…" : "Refresh devices"}
                </button>
              </div>
              {devicesError && <p className="error small">{devicesError}</p>}
              {spotifyDevices.length === 0 && !loadingDevices && !devicesError ? (
                <p className="small muted">
                  No Spotify Connect devices found — open Spotify on your speaker or
                  computer, then refresh.
                </p>
              ) : (
                <div className="admin-device-list">
                  {spotifyDevices.map((device) => (
                    <label
                      key={device.id}
                      className={`admin-device-option${device.compatible ? "" : " admin-device-option--disabled"}`}
                      title={device.incompatibleReason}
                    >
                      <input
                        type="radio"
                        name="target-device"
                        value={device.id}
                        checked={party.spotifyDeviceId === device.id}
                        disabled={!device.compatible}
                        onChange={() => void saveTargetDevice(device.id)}
                      />
                      <span>
                        {device.name}
                        {device.isActive ? " (active)" : ""}
                        {!device.compatible && device.incompatibleReason
                          ? ` — ${device.incompatibleReason}`
                          : ""}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {!party.spotifyDeviceId && (
                <p className="small seed-playlist-status">
                  Select a compatible player before turning the party ON.
                </p>
              )}
            </div>
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
            {notice && <p className="toast-ok">{notice}</p>}
            <div className="queue-controls">
              <div className="queue-controls-row">
                <div className="actions queue-controls-group">
                  <button
                    type="button"
                    onClick={() => void toggleParty(true)}
                    disabled={party.status === "on" || !party.spotifyDeviceId}
                    title={
                      !party.spotifyDeviceId
                        ? "Select a target Spotify player first"
                        : undefined
                    }
                  >
                    Turn ON
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void toggleParty(false)}
                    disabled={party.status === "off"}
                  >
                    Turn OFF
                  </button>
                </div>
                <div className="queue-controls-divider" aria-hidden="true" />
                <div className="actions queue-controls-group">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void hostSync()}
                    disabled={syncing || party.status !== "on"}
                  >
                    {syncing ? "Syncing…" : "Sync with Spotify"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void hostAction(`/host/parties/${party.id}/queue/shuffle`)}
                  >
                    Shuffle
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void hostAction(`/host/parties/${party.id}/queue/clear`)}
                  >
                    Clear upcoming
                  </button>
                </div>
              </div>
              <div
                className="queue-controls-row queue-controls-row--playback"
                role="group"
                aria-label="Playback"
              >
                <BlockedActionButton
                  blockedReason={startPlaybackBlockedReason(party, status)}
                  onBlocked={setNotice}
                  onAction={() => void hostAction(`/host/parties/${party.id}/play`)}
                  className="playback-control-btn playback-control-btn--primary"
                  ariaLabel="Play"
                >
                  <PlayIcon />
                </BlockedActionButton>
                <BlockedActionButton
                  blockedReason={stopPlaybackBlockedReason(party, status)}
                  onBlocked={setNotice}
                  onAction={() => void hostAction(`/host/parties/${party.id}/pause`)}
                  className="playback-control-btn"
                  ariaLabel="Pause"
                >
                  <PauseIcon />
                </BlockedActionButton>
                <button
                  type="button"
                  className="playback-control-btn"
                  aria-label="Skip to next track"
                  onClick={() => void hostAction(`/host/parties/${party.id}/skip`)}
                >
                  <SkipIcon />
                </button>
              </div>
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
