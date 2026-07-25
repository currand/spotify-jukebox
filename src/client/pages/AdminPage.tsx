import * as React from "react";
import type {
  EndedPartyExport,
  HostSpotifyStatus,
  PartyView,
  QueueItemView,
  QueueSnapshot,
  SearchResult,
  TrackInfo,
} from "@/shared/types";
import { isTrackInPartyQueue } from "@/shared/queue-match";
import { api, apiOptional } from "../http";
import { AdminNav } from "../components/AdminNav";
import { SpotifyAttribution } from "../components/SpotifyAttribution";
import {
  formatApiError,
  NowPlayingBanner,
  SearchFilterChips,
  SearchNav,
  SearchTrackRow,
  TrackTitle,
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
  });
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
  const [endedExport, setEndedExport] = React.useState<EndedPartyExport | null>(
    null,
  );
  const [useImportHistory, setUseImportHistory] = React.useState(false);
  const [showHistoryList, setShowHistoryList] = React.useState(false);
  const artistLoadRef = React.useRef(0);
  const [hostSetupToken, setHostSetupToken] = React.useState(() => {
    try {
      return sessionStorage.getItem("jukebox_host_setup_token") ?? "";
    } catch {
      return "";
    }
  });

  function spotifyLoginHref(): string {
    const base = "/api/v1/host/spotify/login";
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

  const load = React.useCallback(async () => {
    try {
      setError(null);
      const s = await api<HostSpotifyStatus>("/host/spotify/status");
      setStatus(s);
      const p = await apiOptional<PartyFull>("/host/parties/current");
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
          const last = await apiOptional<EndedPartyExport>(
            "/host/parties/last-ended",
          );
          if (last?.trackCount) {
            setEndedExport(last);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

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
        seedPlaylistId?: string;
        importFromPartyId?: string;
      } = {
        name: form.name.trim(),
        vetoThreshold: form.vetoThreshold,
      };
      if (useImportHistory && endedExport?.trackCount) {
        body.importFromPartyId = endedExport.partyId;
      } else if (form.seedPlaylistId.trim()) {
        body.seedPlaylistId = form.seedPlaylistId.trim();
      } else {
        setError("Choose a seed playlist or import the last party history.");
        return;
      }
      await api("/host/parties", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setEndedExport(null);
      setUseImportHistory(false);
      setForm({ name: "", seedPlaylistId: "", vetoThreshold: 3 });
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
        `End "${party.name}"?\n\nGuests will lose access. Playlist history will be saved for your next party.`,
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
      setParty(null);
      setQueue(null);
      setHistory([]);
      setForm({ name: "", seedPlaylistId: "", vetoThreshold: 3 });
      setNotice(
        result.trackCount > 0
          ? `Party ended. ${result.trackCount} tracks saved from "${result.partyName}".`
          : "Party ended.",
      );
    } catch (e) {
      setError(formatApiError(e));
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

  async function hostSearch() {
    if (!party || !query.trim()) return;
    setError(null);
    setNotice(null);
    const data = await api<SearchResult>(
      `/host/parties/${party.id}/search?q=${encodeURIComponent(query)}`,
    );
    setResults(data);
    setShowSearchResults(true);
    setSelectedArtist(null);
    setArtistFilter(null);
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
      const fetchInit = { cache: "no-store" as RequestCache };
      let tracks: TrackInfo[] | undefined;
      if (filter === "top-tracks") {
        const data = await api<{ tracks: TrackInfo[] }>(
          `/host/parties/${party.id}/artists/${id}/top-tracks?name=${encodeURIComponent(name)}`,
          fetchInit,
        );
        tracks = data?.tracks;
      } else {
        const data = await api<SearchResult>(
          `/host/parties/${party.id}/search?q=${encodeURIComponent(`artist:${name}`)}`,
          fetchInit,
        );
        tracks = data?.tracks;
      }

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

  async function hostAction(path: string, method = "POST", body?: unknown) {
    await api(path, {
      method,
      body: body ? JSON.stringify(body) : "{}",
    });
    await load();
  }

  const joinUrl = party ? `${window.location.origin}/p/${party.slug}` : "";

  return (
    <div className="app">
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
                    "This device doesn't support Spotify's queue API — use the Spotify app on your phone or computer."}
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
              <a href={spotifyLoginHref()}>
                <button disabled={!hostSetupToken.trim()}>Sign in again</button>
              </a>
            </>
          ) : (
            <>
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
              <a href={spotifyLoginHref()}>
                <button disabled={!hostSetupToken.trim()}>Connect Spotify</button>
              </a>
            </>
          )}
        </div>

        {!party && status?.connected && status.authenticated && (
          <div className="card">
            <h2>Create party</h2>
            {notice && <p className="toast-ok">{notice}</p>}
            {endedExport && endedExport.trackCount > 0 && (
              <div className="banner playing" style={{ marginBottom: "1rem" }}>
                <strong>Last party: {endedExport.partyName}</strong>
                <p className="small" style={{ margin: "0.35rem 0 0" }}>
                  {endedExport.trackCount} tracks saved in playback order.
                </p>
                <div className="row" style={{ marginTop: "0.5rem" }}>
                  <label className="row" style={{ cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={useImportHistory}
                      onChange={(e) => {
                        setUseImportHistory(e.target.checked);
                        if (e.target.checked) {
                          setForm((f) => ({ ...f, seedPlaylistId: "" }));
                        }
                      }}
                    />
                    <span>Use as seed queue</span>
                  </label>
                  <button type="button" className="secondary" onClick={copyHistory}>
                    Copy list
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setShowHistoryList((v) => !v)}
                  >
                    {showHistoryList ? "Hide" : "Show"} tracks
                  </button>
                </div>
                {showHistoryList && (
                  <div
                    className="history-list small"
                    style={{ marginTop: "0.5rem", maxHeight: 160, overflow: "auto" }}
                  >
                    {endedExport.tracks.map((t) => (
                      <div key={t.uri}>
                        {t.name} — {t.artistName}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <input
              placeholder="Party name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <input
              style={{ marginTop: "0.5rem" }}
              placeholder="Seed playlist URL or ID (optional if using history)"
              value={form.seedPlaylistId}
              disabled={useImportHistory}
              onChange={(e) => {
                setForm({ ...form, seedPlaylistId: e.target.value });
                if (e.target.value.trim()) setUseImportHistory(false);
              }}
            />
            <input
              style={{ marginTop: "0.5rem" }}
              type="number"
              placeholder="Veto threshold"
              value={form.vetoThreshold}
              onChange={(e) =>
                setForm({ ...form, vetoThreshold: Number(e.target.value) })
              }
            />
            <div style={{ marginTop: "0.75rem" }}>
              <button onClick={() => void createParty()} disabled={!canCreate}>
                Create party
              </button>
            </div>
          </div>
        )}

        {party && (
          <div className="card">
            <h2>{party.name}</h2>
            <p className="small">/{party.slug}</p>
            <div className="row" style={{ marginBottom: "0.75rem" }}>
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
              style={{ width: 180, background: "#fff", padding: 8, borderRadius: 8 }}
            />
            <div style={{ marginTop: "1rem" }}>
              <button type="button" className="danger" onClick={() => void endParty()}>
                End party
              </button>
            </div>
          </div>
        )}
      </div>

      {party && (
        <div>
          <div className="card">
            <h2>Queue controls</h2>
            <div className="actions">
              <button onClick={() => void hostAction(`/host/parties/${party.id}/queue/shuffle`)}>
                Shuffle
              </button>
              <button
                className="secondary"
                onClick={() => void hostAction(`/host/parties/${party.id}/queue/clear`)}
              >
                Clear upcoming
              </button>
              <button onClick={() => void hostAction(`/host/parties/${party.id}/skip`)}>
                Skip now playing
              </button>
            </div>
            <div className="row" style={{ marginTop: "0.75rem" }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search to add"
                onKeyDown={(e) => e.key === "Enter" && void hostSearch()}
              />
              <button onClick={() => void hostSearch()}>Search</button>
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
                  <div style={{ marginBottom: "1rem" }}>
                    <strong>Artists</strong>
                    {results.artists.map((a) => (
                      <div key={a.id} className="artist-row">
                        <span className="artist-row-name">{a.name}</span>
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
                {results.tracks.map((t) => (
                  <SearchTrackRow
                    key={`${artistFilter ?? "none"}-${t.uri}`}
                    track={t}
                    inQueue={queue ? isTrackInPartyQueue(t, queue) : false}
                    onAdd={() => void hostAdd(t)}
                  />
                ))}
              </>
            )}
          </div>

          {queue?.nowPlaying && <NowPlayingBanner item={queue.nowPlaying} />}

          {!showSearchResults &&
            (queue?.upcomingOrder ?? [
              ...(queue?.boostLane ?? []),
              ...(queue?.upcoming ?? []),
            ]).map((item) => (
            <div key={item.id} className={`track card${item.isBoosted ? " track--boosted" : ""}`}>
              {item.albumArtUrl && <img src={item.albumArtUrl} alt="" />}
              <div className="track-meta">
                <TrackTitle name={item.trackName} boosted={item.isBoosted} />
                <p>
                  {item.artistName} · {item.addedBy} · ↑{item.upvoteCount}
                </p>
              </div>
              <div className="actions">
                <button
                  className="secondary"
                  onClick={() =>
                    void hostAction(
                      `/host/parties/${party.id}/queue/${item.id}`,
                      "PATCH",
                      { action: "force_next" },
                    )
                  }
                >
                  Force next
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    void hostAction(
                      `/host/parties/${party.id}/queue/${item.id}`,
                      "PATCH",
                      { action: "move_up" },
                    )
                  }
                >
                  ↑
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    void hostAction(
                      `/host/parties/${party.id}/queue/${item.id}`,
                      "PATCH",
                      { action: "move_down" },
                    )
                  }
                >
                  ↓
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    void hostAction(
                      `/host/parties/${party.id}/queue/start-from/${item.id}`,
                    )
                  }
                >
                  Start here
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    void hostAction(
                      `/host/parties/${party.id}/queue/${item.id}`,
                      "DELETE",
                    )
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          ))}

          <div className="card">
            <h2>History</h2>
            {history.slice(0, 20).map((item) => (
              <div key={item.id} className="small">
                {item.trackName} — {item.status}
              </div>
            ))}
          </div>
        </div>
      )}
      </div>
      <SpotifyAttribution />
    </div>
  );
}
